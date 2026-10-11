import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateGitPullDiffTotals,
  classifyGitPullFailure,
  formatGitPullErrorMessage,
  isGitPullUpdated,
} from "../src/git/repo/gitPullHelpers.js";

function classifyFailure(stderr: string, stdout = "") {
  return classifyGitPullFailure({ stderr, stdout, exitCode: 1 });
}

test("合并冲突：识别为 merge-conflict，并保留 git 列出的冲突线索", () => {
  const failure = classifyFailure(
    [
      "Auto-merging src/a.ts",
      "CONFLICT (content): Merge conflict in src/a.ts",
      "Automatic merge failed; fix conflicts and then commit the result.",
    ].join("\n"),
  );

  assert.equal(failure.code, "merge-conflict");
  assert.match(formatGitPullErrorMessage(failure), /CONFLICT \(content\)/);
});

test("本地改动会被覆盖：识别为 dirty-working-tree", () => {
  const failure = classifyFailure(
    [
      "error: Your local changes to the following files would be overwritten by merge:",
      "\tsrc/a.ts",
      "Please commit your changes or stash them before you merge.",
    ].join("\n"),
  );

  assert.equal(failure.code, "dirty-working-tree");
  assert.match(formatGitPullErrorMessage(failure), /src\/a\.ts/);
});

test("rebase 策略下的未暂存改动同样归为 dirty-working-tree", () => {
  const failure = classifyFailure("error: cannot pull with rebase: You have unstaged changes.");

  assert.equal(failure.code, "dirty-working-tree");
});

test("HTTPS 认证失败：识别为 authentication-failed", () => {
  const failure = classifyFailure(
    "fatal: Authentication failed for 'https://github.com/example/repo.git/'",
  );

  assert.equal(failure.code, "authentication-failed");
});

test("SSH 公钥被拒：识别为 authentication-failed 而不是 network-error", () => {
  const failure = classifyFailure(
    [
      "git@github.com: Permission denied (publickey).",
      "fatal: Could not read from remote repository.",
    ].join("\n"),
  );

  assert.equal(failure.code, "authentication-failed");
});

test("域名解析失败：识别为 network-error", () => {
  const failure = classifyFailure(
    "fatal: unable to access 'https://github.com/example/repo.git/': Could not resolve host: github.com",
  );

  assert.equal(failure.code, "network-error");
});

test("未配置 pull 策略且分支分叉：识别为 diverged", () => {
  const failure = classifyFailure("fatal: Need to specify how to reconcile divergent branches.");

  assert.equal(failure.code, "diverged");
});

test("已有未完成的合并：识别为 operation-in-progress", () => {
  const failure = classifyFailure("error: You have not concluded your merge (MERGE_HEAD exists).");

  assert.equal(failure.code, "operation-in-progress");
});

test("冲突未解决时再次拉取：仍归为 merge-conflict 而不是 unknown", () => {
  // 真实 Git 输出（首次冲突后再次 pull）：不再重复打 CONFLICT，只说有未合并的文件。
  const failure = classifyFailure(
    [
      "error: Pulling is not possible because you have unmerged files.",
      "hint: Fix them up in the work tree, and then use 'git add/rm <file>'",
      "fatal: Exiting because of an unresolved conflict.",
    ].join("\n"),
  );

  assert.equal(failure.code, "merge-conflict");
});

test("remote 的 URL 指向非 Git 仓库：识别为 no-remote", () => {
  const failure = classifyFailure(
    [
      "fatal: '/tmp/missing.git' does not appear to be a git repository",
      "fatal: Could not read from remote repository.",
    ].join("\n"),
  );

  assert.equal(failure.code, "no-remote");
});

test("没有上游分支：识别为 no-upstream", () => {
  const failure = classifyFailure("There is no tracking information for the current branch.");

  assert.equal(failure.code, "no-upstream");
});

test("没有配置 remote：识别为 no-remote", () => {
  const failure = classifyFailure(
    "fatal: No remote repository specified. Please, specify either a URL or a remote name.",
  );

  assert.equal(failure.code, "no-remote");
});

test("远端分支已被删除：识别为 upstream-branch-missing 而不是 unknown", () => {
  // 真实 Git 输出（PR 合并后远端删掉该分支）：上游配置还在，但远端那个 ref 没了。
  const failure = classifyFailure(
    [
      "Your configuration specifies to merge with the ref 'refs/heads/feature'",
      "from the remote, but no such ref was fetched.",
    ].join("\n"),
  );

  assert.equal(failure.code, "upstream-branch-missing");
});

test("未识别的失败回落到 unknown，并把原始输出放进详情", () => {
  const failure = classifyFailure("fatal: something completely unexpected");

  assert.equal(failure.code, "unknown");
  assert.equal(failure.message, "git pull failed.");
  assert.equal(
    formatGitPullErrorMessage(failure),
    "git pull failed.\n\nfatal: something completely unexpected",
  );
});

test("stderr 为空时用退出码兜底，详情不会是空串", () => {
  const failure = classifyGitPullFailure({ stderr: "", stdout: "", exitCode: null });

  assert.equal(failure.code, "unknown");
  assert.equal(failure.detail, "exitCode=null");
});

test("拉取量聚合：文件数与增删行数按逐文件结果求和", () => {
  const totals = aggregateGitPullDiffTotals(
    new Map([
      ["src/a.ts", { added: 3, removed: 1 }],
      ["src/b.ts", { added: 0, removed: 4 }],
      // 二进制文件在 numstat 里是 "-"，解析后记 0 行，但仍算一个文件。
      ["assets/logo.png", { added: 0, removed: 0 }],
    ]),
  );

  assert.deepEqual(totals, { fileCount: 3, added: 3, removed: 5 });
});

test("空 diff 聚合为零", () => {
  assert.deepEqual(aggregateGitPullDiffTotals(new Map()), {
    fileCount: 0,
    added: 0,
    removed: 0,
  });
});

test("更新判定：两侧 HEAD 一致才算没拉到东西", () => {
  assert.equal(isGitPullUpdated("aaa", "bbb"), true);
  assert.equal(isGitPullUpdated("aaa", "aaa"), false);
  assert.equal(isGitPullUpdated(null, null), false);
});

test("更新判定：任一侧读不到 HEAD 时按「有更新、数量未知」上报，不能报成「已是最新」", () => {
  // 拉取后读 HEAD 失败（超时等）时若报「已是最新」，会把真的快进过的分支说成没变，
  // 用户会误判自己的分支状态；反过来只是多报一次数量未知的拉取。
  assert.equal(isGitPullUpdated("aaa", null), true);
  assert.equal(isGitPullUpdated(null, "bbb"), true);
});
