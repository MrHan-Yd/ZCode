import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveNativeSearchPrebuiltPlan } from "./native-search-tools-config.mjs";
import { prepareNativeSearchTools } from "./prepare-native-search-tools.mjs";
import { extractPrebuiltBinary, verifyPrebuiltArchiveSha256 } from "./prebuilt-binary-extract.mjs";
import { verifyNativeSearchBinaryTarget } from "./native-search-tools-verify.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const { ZipFile } = createRequire(import.meta.url)("yazl");
const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

async function withDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "zcode-native-search-test-"));
  try {
    return await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

function capture(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function writeZip(path, contents = { "nested/fixture.exe": "fixture-binary" }) {
  const zip = new ZipFile();
  const chunks = [];
  const output = new Promise((resolve, reject) => {
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
  });
  for (const [name, value] of Object.entries(contents)) zip.addBuffer(Buffer.from(value), name);
  zip.end();
  const bytes = await output;
  await writeFile(path, bytes);
  return sha256(bytes);
}

async function isolatedExtraction(archivePath, extractDir, env) {
  const moduleUrl = new URL("./prebuilt-binary-extract.mjs", import.meta.url).href;
  const code = `import { extractPrebuiltArchive } from ${JSON.stringify(moduleUrl)}; await extractPrebuiltArchive(${JSON.stringify({ archivePath, archiveExt: "zip", extractDir, cwd: ROOT })});`;
  return capture(process.execPath, ["--input-type=module", "-e", code], env);
}

test("仓库固定工具归档通过 SHA-256 校验，篡改副本会被拒绝", async () => {
  for (const platform of ["win32", "darwin", "linux"]) {
    for (const arch of ["x64", "arm64"]) {
      const plan = resolveNativeSearchPrebuiltPlan({ platform, arch });
      for (const artifact of plan.artifacts)
        await verifyPrebuiltArchiveSha256(artifact.archivePath, artifact.archiveSha256);
    }
  }

  await withDirectory(async (directory) => {
    const plan = resolveNativeSearchPrebuiltPlan({
      platform: process.platform,
      arch: process.arch,
    });
    const source = plan.artifacts[0];
    const tamperedPath = join(directory, "tampered.zip");
    const bytes = await readFile(source.archivePath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(tamperedPath, bytes);
    await assert.rejects(
      verifyPrebuiltArchiveSha256(tamperedPath, source.archiveSha256),
      /Archive SHA-256 mismatch/u,
    );
  });
});

test("新目录完整准备真实本机工具，并复用验证后的缓存", async () => {
  await withDirectory(async (directory) => {
    const outputDir = join(directory, "tools");
    const plan = await prepareNativeSearchTools({ outputDir });
    const digests = new Map();
    for (const artifact of plan.artifacts) {
      digests.set(artifact.toolId, sha256(await readFile(artifact.binaryPath)));
      const result = await capture(artifact.binaryPath, ["--version"]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(artifact.version.replaceAll(".", "\\.")));
    }

    const messages = [];
    const originalLog = console.log;
    console.log = (...args) => {
      messages.push(args.join(" "));
      originalLog(...args);
    };
    try {
      await prepareNativeSearchTools({ outputDir });
    } finally {
      console.log = originalLog;
    }
    for (const artifact of plan.artifacts) {
      assert.ok(
        messages.some((message) => message.includes(`[skip] ${artifact.toolId} `)),
        `second prepare did not reuse ${artifact.toolId} cache`,
      );
      assert.equal(sha256(await readFile(artifact.binaryPath)), digests.get(artifact.toolId));
    }
  });
});

test(
  "Windows ZIP 不读取污染的 Archive 模块，并支持特殊字符路径",
  { skip: process.platform !== "win32" },
  async () => {
    await withDirectory(async (directory) => {
      const archivePath = join(directory, "archive 中文 ' space.zip");
      await writeZip(archivePath);
      const moduleDirectory = join(directory, "polluted", "Microsoft.PowerShell.Archive");
      await mkdir(moduleDirectory, { recursive: true });
      await writeFile(
        join(moduleDirectory, "Microsoft.PowerShell.Archive.psm1"),
        "function Expand-Archive { Write-Error 'fixture.incompatibleArchiveModule' }; Export-ModuleMember -Function Expand-Archive",
      );
      const env = { ...process.env };
      for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
      env.PSModulePath = dirname(moduleDirectory);
      const old = await capture(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(join(directory, "old"))}`,
        ],
        env,
      );
      assert.match(old.stderr, /fixture\.incompatibleArchiveModule/u);
      const extractDir = join(directory, "new extract 中文 '");
      const result = await isolatedExtraction(archivePath, extractDir, env);
      assert.equal(result.code, 0, result.stderr);
      assert.doesNotMatch(result.stderr, /fixture\.incompatibleArchiveModule/u);
      assert.equal(
        await readFile(join(extractDir, "nested", "fixture.exe"), "utf8"),
        "fixture-binary",
      );
    });
  },
);

test("损坏 ZIP 立即拒绝，不验证、不覆盖目标、不遗留临时目录", async () => {
  await withDirectory(async (directory) => {
    const archivePath = join(directory, "broken.zip");
    const binaryPath = join(directory, "existing.exe");
    const broken = Buffer.from("not-a-valid-zip");
    await writeFile(archivePath, broken);
    await writeFile(binaryPath, "original");
    const before = new Set(
      (await readdir(tmpdir())).filter((name) => name.startsWith("zcode-prebuilt-binary-")),
    );
    let validationCalls = 0;
    await assert.rejects(
      extractPrebuiltBinary({
        archivePath,
        archiveExt: "zip",
        archiveSha256: sha256(broken),
        binaryName: "fixture.exe",
        binaryPath,
        targetPlatform: process.platform,
        validateBinary: () => {
          validationCalls += 1;
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /Failed to locate/u);
        return true;
      },
    );
    assert.equal(validationCalls, 0);
    assert.equal(await readFile(binaryPath, "utf8"), "original");
    const after = (await readdir(tmpdir())).filter(
      (name) => name.startsWith("zcode-prebuilt-binary-") && !before.has(name),
    );
    assert.deepEqual(after, []);
  });
});

test("SHA 与可执行架构校验失败都保留原目标", async () => {
  await withDirectory(async (directory) => {
    const archivePath = join(directory, "fixture.zip");
    const archiveSha256 = await writeZip(archivePath);
    const binaryPath = join(directory, "existing.exe");
    await writeFile(binaryPath, "original");
    const input = {
      archivePath,
      archiveExt: "zip",
      archiveSha256,
      binaryName: "fixture.exe",
      binaryPath,
      targetPlatform: process.platform,
    };
    await assert.rejects(
      extractPrebuiltBinary({ ...input, archiveSha256: "0".repeat(64) }),
      /Archive SHA-256 mismatch/u,
    );
    await assert.rejects(
      extractPrebuiltBinary({
        ...input,
        validateBinary: (path) =>
          verifyNativeSearchBinaryTarget(path, { platform: process.platform, arch: process.arch }),
      }),
      (error) => {
        // 必须证明是目标架构校验失败，而不是解压工具缺失等旁路错误被当成通过。
        assert.doesNotMatch(error.message, /Archive SHA-256 mismatch/u);
        assert.match(error.message, /fixture\.exe/u);
        return true;
      },
    );
    assert.equal(await readFile(binaryPath, "utf8"), "original");
  });
});

test("并发归档解压使用独占目录并各自返回正确结果", async () => {
  await withDirectory(async (directory) => {
    const archivePath = join(directory, "fixture.zip");
    const archiveSha256 = await writeZip(archivePath);
    await Promise.all(
      ["first", "second"].map((name) =>
        extractPrebuiltBinary({
          archivePath,
          archiveExt: "zip",
          archiveSha256,
          binaryName: "fixture.exe",
          binaryPath: join(directory, name, "fixture.exe"),
          targetPlatform: process.platform,
        }),
      ),
    );
    for (const name of ["first", "second"])
      assert.equal(await readFile(join(directory, name, "fixture.exe"), "utf8"), "fixture-binary");
  });
});
