import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import process from "node:process";

// Bugfix: Windows GNU tar（Git Bash）会把绝对路径里的盘符冒号（C:）当成远程主机名，
// 反斜杠路径也会被 MSYS 参数转换破坏。tar 参数统一转正斜杠，归档路径优先改用
// 相对 cwd 的形式避开盘符冒号；对 bsdtar 与 Linux/macOS CI 无影响。
function toTarPosixPath(pathValue) {
  return pathValue.replaceAll("\\", "/");
}

function resolveTarArchiveArg(archivePath, cwd) {
  if (process.platform === "win32") {
    try {
      const relativeArchivePath = relative(cwd, archivePath);
      if (relativeArchivePath && !relativeArchivePath.startsWith("..")) {
        return toTarPosixPath(relativeArchivePath);
      }
    } catch {
      // 跨盘符时 relative 会抛错，退回正斜杠绝对路径（bsdtar 可用）。
    }
  }

  return toTarPosixPath(archivePath);
}

function formatCommand(command, args) {
  return [command, ...args].join(" ");
}

// 解压子进程必须等待真实退出码：旧实现用 Expand-Archive 的“非终止错误”会让
// powershell.exe 以 0 退出，失败随后才在查找二进制时暴露成误导性的缺文件。
async function runExtractionCommand(command, args, { cwd } = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${formatCommand(command, args)} terminated by signal ${signal}`));
        return;
      }

      if (code !== 0) {
        const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
        reject(
          new Error(
            `${formatCommand(command, args)} failed with code ${code}${details ? `\n${details}` : ""}`,
          ),
        );
        return;
      }

      resolve();
    });
  });
}

function toPowerShellSingleQuoted(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

// Bugfix: Windows PowerShell 5.1 从继承来的 PSModulePath 里可能加载 PowerShell 7
// 的 Microsoft.PowerShell.Archive，其 Expand-Archive 内部使用三参数
// ExtractToDirectory 重载，在 .NET Framework 下直接报“找不到三参数重载”。
// 这里不调用 Expand-Archive，也不导入 Archive 模块，直接用 .NET 两参数接口解压。
function buildWindowsZipExtractScript(archivePath, extractDir) {
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[System.IO.Compression.ZipFile]::ExtractToDirectory(${toPowerShellSingleQuoted(archivePath)}, ${toPowerShellSingleQuoted(extractDir)})`,
  ].join("; ");
}

// 契约：extractDir 必须是调用方创建的独占目录，且本身尚不存在。
// Windows 交给 ExtractToDirectory 自行创建目录（目标里已有同名文件时会抛 IOException）；
// Unix 的 unzip/tar 会覆盖已有内容。两种语义都只对全新私有目录成立，不能复用非空目录。
export async function extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd }) {
  if (archiveExt === "zip") {
    if (process.platform === "win32") {
      await runExtractionCommand("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        buildWindowsZipExtractScript(archivePath, extractDir),
      ]);
      return;
    }

    await mkdir(extractDir, { recursive: true });
    await runExtractionCommand("unzip", ["-q", archivePath, "-d", extractDir], { cwd });
    return;
  }

  await mkdir(extractDir, { recursive: true });
  const tarCwd = cwd ?? process.cwd();
  await runExtractionCommand(
    "tar",
    ["-xzf", resolveTarArchiveArg(archivePath, tarCwd), "-C", toTarPosixPath(extractDir)],
    { cwd: tarCwd },
  );
}

export async function findPrebuiltBinary(rootDir, binaryName) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findPrebuiltBinary(fullPath, binaryName);
      if (nested) return nested;
      continue;
    }

    if (entry.isFile() && entry.name === binaryName) return fullPath;
  }

  return undefined;
}

function assertPrebuiltArchiveSha256(expectedSha256) {
  const normalizedExpectedSha256 = String(expectedSha256 ?? "")
    .trim()
    .toLowerCase();
  if (!/^[a-f0-9]{64}$/u.test(normalizedExpectedSha256)) {
    throw new Error("missing prebuilt archive SHA-256");
  }
  return normalizedExpectedSha256;
}

export async function verifyPrebuiltArchiveSha256(archivePath, expectedSha256) {
  const normalizedExpectedSha256 = assertPrebuiltArchiveSha256(expectedSha256);
  const actualSha256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  if (actualSha256 !== normalizedExpectedSha256) {
    throw new Error(
      `Archive SHA-256 mismatch: expected ${normalizedExpectedSha256}, received ${actualSha256}`,
    );
  }
}

export async function extractPrebuiltBinary({
  archiveExt,
  archivePath,
  archiveSha256,
  binaryName,
  binaryPath,
  cwd,
  targetPlatform,
  validateBinary,
}) {
  await verifyPrebuiltArchiveSha256(archivePath, archiveSha256);
  await mkdir(dirname(binaryPath), { recursive: true });
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-prebuilt-binary-"));
  const extractDir = join(tempDir, "extract");

  try {
    await extractPrebuiltArchive({ archivePath, archiveExt, extractDir, cwd });
    const extractedBinaryPath = await findPrebuiltBinary(extractDir, binaryName);
    if (!extractedBinaryPath) {
      throw new Error(`Failed to locate ${binaryName} in extracted archive`);
    }

    // foreign target 不能靠执行目标文件验真，必须在覆盖正式路径前校验临时产物。
    await validateBinary?.(extractedBinaryPath);
    await copyFile(extractedBinaryPath, binaryPath);
    if (targetPlatform !== "win32") {
      await chmod(binaryPath, 0o755);
    }
  } finally {
    // Bugfix: Windows 下解压产物可能被杀毒/索引器或尚未退出的解压子进程短暂持有句柄，
    // 删除会 EPERM，且 finally 里抛出的异常会掩盖真正的解压错误。
    // 带重试删除，失败时仅告警，让原始错误正常抛出。
    try {
      await rm(tempDir, { force: true, recursive: true, maxRetries: 10, retryDelay: 500 });
    } catch (error) {
      console.warn(`[warn] 清理临时目录失败（可忽略）: ${tempDir}`);
      console.warn(`[warn] ${String(error)}`);
    }
  }
}
