import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  resolveCandidateProjectMemoryRoots,
  resolveInactiveProjectMemoryRoots,
} from "../src/memory/roots.js";

function memoryProjectsPath(dataRoot: string): string {
  return resolve(dataRoot, ".zcode", "cli", "memories", "projects");
}

test("数据根就是家目录时只返回一个候选根，不产生自己对自己的提示", () => {
  const home = resolve("zcode-home");
  const candidates = resolveCandidateProjectMemoryRoots({ homeDir: home, dataBaseDir: home });

  assert.deepEqual(candidates, [{ rootId: "home", path: memoryProjectsPath(home) }]);
  assert.deepEqual(
    resolveInactiveProjectMemoryRoots({
      homeDir: home,
      dataBaseDir: home,
      activeRootPath: memoryProjectsPath(home),
    }),
    [],
  );
});

test("数据根被搬到别处时，家目录根成为不生效的差异根", () => {
  const home = resolve("zcode-home");
  const dataBase = resolve("zcode-data");
  const candidates = resolveCandidateProjectMemoryRoots({ homeDir: home, dataBaseDir: dataBase });

  assert.deepEqual(
    candidates.map((candidate) => candidate.rootId),
    ["home", "dataBaseDir"],
  );

  const inactive = resolveInactiveProjectMemoryRoots({
    homeDir: home,
    dataBaseDir: dataBase,
    activeRootPath: memoryProjectsPath(dataBase),
  });
  assert.deepEqual(inactive, [{ rootId: "home", path: memoryProjectsPath(home) }]);
});

test("生效根改为家目录时，自定义数据目录成为差异根", () => {
  const home = resolve("zcode-home");
  const dataBase = resolve("zcode-data");
  const inactive = resolveInactiveProjectMemoryRoots({
    homeDir: home,
    dataBaseDir: dataBase,
    activeRootPath: memoryProjectsPath(home),
  });

  assert.deepEqual(inactive, [{ rootId: "dataBaseDir", path: memoryProjectsPath(dataBase) }]);
});

test("路径带尾斜杠或未规范化时仍能识别为同一个根，不误报差异", () => {
  const home = resolve("zcode-home");
  const candidates = resolveCandidateProjectMemoryRoots({ homeDir: home, dataBaseDir: home });
  const activePath = candidates[0]!.path;

  assert.deepEqual(
    resolveInactiveProjectMemoryRoots({
      homeDir: home,
      dataBaseDir: home,
      // 带尾斜杠、且中间夹了 . 段：规范化后应与候选根相同。
      activeRootPath: `${activePath}${process.platform === "win32" ? "\\" : "/"}.`,
    }),
    [],
  );
});
