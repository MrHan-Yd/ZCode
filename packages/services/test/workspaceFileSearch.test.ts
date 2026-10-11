import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  packWorkspaceFileEntries,
  unpackWorkspaceFileEntries,
} from "@zcode/shared/workspaceFileEntriesCodec";
import {
  filterWorkspaceFileSearchCandidates,
  mapWorkspaceFileEntriesToSearchCandidates,
  type WorkspaceFileSearchCandidate,
} from "@zcode/shared/workspaceFileSearch";
import {
  buildHostFileSearchCandidates,
  searchHostFileCandidates,
} from "../src/file/workspaceFileSearch.js";

function entry(relativePath: string, type: WorkspaceFileEntry["type"]): WorkspaceFileEntry {
  const name = relativePath.split("/").pop() ?? relativePath;
  return { name, path: `/repo/${relativePath}`, relativePath, type };
}

/** 复现 fileService 的索引顺序：目录优先，其次路径。 */
function sortAsIndex(entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] {
  return [...entries].sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function toEntries(candidates: WorkspaceFileSearchCandidate[]): WorkspaceFileEntry[] {
  return candidates.map(({ name, path, relativePath, type }) => ({ name, path, relativePath, type }));
}

test("空 query 直接返回默认预览，顺序与共享排序一致（文件优先、再目录）", async () => {
  const ordered = sortAsIndex([
    entry("src", "directory"),
    entry("src/components", "directory"),
    entry("README.md", "file"),
    entry("package.json", "file"),
    entry("src/index.ts", "file"),
  ]);
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(ordered);

  // 与优化前的实现（共享全量排序）逐条对比，确保快路径没有改变可见顺序。
  for (const limit of [1, 2, 3, 4, 10]) {
    const fast = await searchHostFileCandidates(candidates, "", limit);
    const reference = toEntries(
      filterWorkspaceFileSearchCandidates(candidates, "", { limit }),
    );
    assert.deepEqual(fast, reference, `limit=${limit}`);
    assert.ok(fast.length <= limit);
  }

  // 文件优先：limit 覆盖全部文件后才补目录（文件之间保持索引顺序）。
  const preview = await searchHostFileCandidates(candidates, "", 4);
  assert.deepEqual(
    preview.map((item) => item.relativePath),
    ["package.json", "README.md", "src/index.ts", "src"],
  );
});

test("空 query 快路径在真实 packed 索引上同样成立", async () => {
  const ordered = sortAsIndex([
    entry("app", "directory"),
    entry("app/main.ts", "file"),
    entry("lib", "directory"),
    entry("lib/util.ts", "file"),
    entry("z.txt", "file"),
  ]);
  const packed = packWorkspaceFileEntries(ordered);
  const decoded = unpackWorkspaceFileEntries(packed, "/repo");
  const candidates = await buildHostFileSearchCandidates(packed, "/repo");

  const fast = await searchHostFileCandidates(candidates, "", 3);
  const reference = toEntries(
    filterWorkspaceFileSearchCandidates(
      mapWorkspaceFileEntriesToSearchCandidates(decoded),
      "",
      { limit: 3 },
    ),
  );
  assert.deepEqual(fast, reference);
  assert.deepEqual(
    fast.map((item) => item.relativePath),
    ["app/main.ts", "lib/util.ts", "z.txt"],
  );
});

test("有 query 时结果与共享过滤一致", async () => {
  const ordered = sortAsIndex([
    entry("src", "directory"),
    entry("src/index.ts", "file"),
    entry("src/mentionPanel.tsx", "file"),
    entry("README.md", "file"),
  ]);
  const candidates = mapWorkspaceFileEntriesToSearchCandidates(ordered);

  for (const query of ["index", "src", "mention"]) {
    const got = await searchHostFileCandidates(candidates, query, 10);
    const reference = toEntries(
      filterWorkspaceFileSearchCandidates(candidates, query, { limit: 10 }),
    );
    assert.deepEqual(got, reference, `query=${query}`);
  }
});

test("被更新的查询取代后提前返回，不再扫完剩下的候选", async () => {
  // 前 20000 条不命中，命中项全部排在很靠后的批次；无论分批大小如何，
  // 首批就要求 abort 时都不应继续扫到命中项。
  const nonMatching = Array.from({ length: 20_000 }, (_, index) =>
    entry(`bulk/f${index}.txt`, "file"),
  );
  const matching = Array.from({ length: 50 }, (_, index) =>
    entry(`needle/n${index}.txt`, "file"),
  );
  const candidates = mapWorkspaceFileEntriesToSearchCandidates([
    ...nonMatching,
    ...matching,
  ]);

  const full = await searchHostFileCandidates(candidates, "needle", 10);
  assert.ok(full.length > 0);
  assert.ok(full.length <= 10);

  const aborted = await searchHostFileCandidates(candidates, "needle", 10, {
    shouldAbort: () => true,
  });
  assert.deepEqual(aborted, []);
});
