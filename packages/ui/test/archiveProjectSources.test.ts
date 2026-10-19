import assert from "node:assert/strict";
import test from "node:test";
import {
  buildArchiveProjects,
  selectListedArchiveProjects,
  type ArchiveProject,
  type ArchiveProjectTab,
} from "../src/settings/useArchivedTasksByProject.js";

function tab(
  workspacePath: string,
  extra: Partial<ArchiveProjectTab> = {},
): ArchiveProjectTab {
  return { workspacePath, ...extra };
}

function project(key: string, label = key): ArchiveProject {
  return { key, workspacePath: `D:/${label}`, label, remote: false };
}

test("应用的项目列表只包含当前打开的工作区标签", () => {
  const sources = buildArchiveProjects(
    [tab("D:/open-a"), tab("D:/open-b")],
    ["D:/recent-only"],
    [{ workspacePath: "D:/history-only" }, { workspacePath: "D:/index-only" }],
  );

  assert.deepEqual(
    [...sources.appProjectKeys].sort(),
    ["D:/open-a", "D:/open-b"],
    "最近项目 / 上次会话 / 任务索引都只是历史来源，不算应用的项目列表",
  );
  assert.equal(sources.projects.length, 5, "全部来源仍要保留，读取归档要用完整列表");
});

test("同 key 的来源去重，带 identity 的标签按 identity 建 key", () => {
  const sources = buildArchiveProjects(
    [
      tab("D:/same", { label: "same" }),
      tab("D:/remote", { workspaceIdentity: "ssh://host/remote", label: "remote" }),
    ],
    ["D:/same", "D:/remote"],
    [],
  );

  // D:/same：标签与最近项目同一个 key，去重成一条；
  // D:/remote：标签按 identity 建 key，与只带路径的最近项目不是同一条。
  assert.deepEqual(
    sources.projects.map((item) => item.key),
    ["D:/same", "ssh://host/remote", "D:/remote"],
  );
  assert.deepEqual([...sources.appProjectKeys].sort(), ["D:/same", "ssh://host/remote"]);
});

test("空路径不入列表，远端标签按 identity 建 key", () => {
  const sources = buildArchiveProjects(
    [tab("   "), tab("D:/remote", { workspaceIdentity: "ssh://h/p", remoteTarget: { kind: "ssh" } as never })],
    [],
    [],
  );

  assert.equal(sources.projects.length, 1);
  assert.equal(sources.projects[0]?.key, "ssh://h/p");
  assert.equal(sources.projects[0]?.remote, true);
});

test("归档数据还没读回时不隐藏任何项目", () => {
  const projects = [project("D:/open"), project("D:/removed")];
  const listed = selectListedArchiveProjects({
    projects,
    appProjectKeys: new Set(["D:/open"]),
    projectKeysWithArchivedTasks: new Set(),
    hasArchiveData: false,
  });

  assert.equal(listed.length, 2, "首帧不知道谁有归档，先全列，避免下拉先少后多");
});

test("没被移除的项目即使没有归档任务也保留", () => {
  const projects = [project("D:/open"), project("D:/removed")];
  const listed = selectListedArchiveProjects({
    projects,
    appProjectKeys: new Set(["D:/open"]),
    projectKeysWithArchivedTasks: new Set(),
    hasArchiveData: true,
  });

  assert.deepEqual(listed.map((item) => item.key), ["D:/open"]);
});

test("已被移除但有归档任务的项目保留", () => {
  const projects = [project("D:/open"), project("D:/removed-with-archive")];
  const listed = selectListedArchiveProjects({
    projects,
    appProjectKeys: new Set(["D:/open"]),
    projectKeysWithArchivedTasks: new Set(["D:/removed-with-archive"]),
    hasArchiveData: true,
  });

  assert.deepEqual(
    listed.map((item) => item.key),
    ["D:/open", "D:/removed-with-archive"],
    "残留归档要留着，否则再也清不掉",
  );
});

test("已被移除且没有任何归档任务的项目不再展示", () => {
  const projects = [project("D:/removed-no-archive"), project("D:/open")];
  const listed = selectListedArchiveProjects({
    projects,
    appProjectKeys: new Set(["D:/open"]),
    projectKeysWithArchivedTasks: new Set(),
    hasArchiveData: true,
  });

  assert.deepEqual(listed.map((item) => item.key), ["D:/open"]);
});
