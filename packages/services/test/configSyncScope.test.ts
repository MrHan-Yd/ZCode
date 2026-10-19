import assert from "node:assert/strict";
import { sep } from "node:path";
import test from "node:test";
import {
  resolveConfigSyncScope,
  resolveWorkspaceLabel,
  scopeBackupDirName,
  scopeGistDescription,
  USER_CONFIG_SYNC_SCOPE,
} from "../src/config-sync/scope.js";

/** 用平台原生分隔符拼路径，免得断言依赖运行在哪个系统上。 */
function nativePath(...segments: string[]): string {
  return segments.join(sep);
}

test("作用域判别：没有 workspacePath 就是用户级", () => {
  assert.deepEqual(resolveConfigSyncScope(undefined), USER_CONFIG_SYNC_SCOPE);
  assert.deepEqual(resolveConfigSyncScope(""), USER_CONFIG_SYNC_SCOPE);
  assert.deepEqual(resolveConfigSyncScope("   "), USER_CONFIG_SYNC_SCOPE);
});

test("项目标识 = 工作区目录名", () => {
  const workspacePath = nativePath("tmp", "workspaces", "my-project");
  assert.deepEqual(resolveConfigSyncScope(workspacePath), {
    kind: "workspace",
    label: "my-project",
  });
  // 末尾分隔符不影响 basename。
  assert.equal(resolveWorkspaceLabel(`${workspacePath}${sep}`), "my-project");
  assert.equal(resolveWorkspaceLabel(workspacePath), "my-project");
});

test("目录名取不出来时回退固定标识，不留空 label", () => {
  assert.equal(resolveWorkspaceLabel(sep), "workspace");
  assert.equal(resolveWorkspaceLabel("   "), "workspace");
});

test("gist description：用户级是基础标记，工作区级拼上项目名", () => {
  const base = "zcode-subagents-config-sync";
  assert.equal(scopeGistDescription(base, USER_CONFIG_SYNC_SCOPE), base);
  assert.equal(
    scopeGistDescription(base, { kind: "workspace", label: "my-project" }),
    `${base}:my-project`,
  );
  // 用户级与项目级必须能区分开，否则发现会取到错的那一份。
  assert.notEqual(
    scopeGistDescription(base, { kind: "workspace", label: "my-project" }),
    scopeGistDescription(base, USER_CONFIG_SYNC_SCOPE),
  );
});

test("备份子目录名：用户级用原根目录，工作区级带前缀", () => {
  assert.equal(scopeBackupDirName(USER_CONFIG_SYNC_SCOPE), "");
  assert.equal(scopeBackupDirName({ kind: "workspace", label: "my-project" }), "ws-my-project");
});

test("备份子目录名转义路径分隔符与控制字符，不让项目名把路径带出目录", () => {
  assert.equal(scopeBackupDirName({ kind: "workspace", label: "a/b" }), "ws-a%2fb");
  assert.equal(scopeBackupDirName({ kind: "workspace", label: "a\\b" }), "ws-a%5cb");
  assert.equal(scopeBackupDirName({ kind: "workspace", label: "a%b" }), "ws-a%25b");
  assert.equal(scopeBackupDirName({ kind: "workspace", label: "a\u0001b" }), "ws-a%01b");
});
