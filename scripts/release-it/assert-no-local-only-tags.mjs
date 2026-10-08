/**
 * 发版前置检查：本地存在、远端没有的 `v*` tag 必须拦下。
 *
 * release-it 用 `git push --follow-tags` 推分支，而 `--follow-tags` 会**把所有从被推提交可达的
 * 附注 tag 一起推上去**。本地若残留一个从未推送过的历史 tag，它会被顺带推上去，而发版工作流是
 * 「推 tag 即公开发布 Release，无需人工确认」——结果是凭空发布一个旧版本，并可能抢占 latest，
 * 让自动更新源与「前往下载」入口指向旧版本。（2026-10-08 的 v3.16.0 发版就是这样连带发布了 v3.15.0。）
 *
 * 这里在发版开始前直接中止，让操作者显式决定这些 tag 该不该发布。
 */
import { execFileSync } from "node:child_process";

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

const localTags = git(["tag", "--list", "v*"])
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

if (localTags.length === 0) {
  process.exit(0);
}

const remoteTags = new Set(
  git(["ls-remote", "--tags", "origin"])
    .split("\n")
    .map((line) => line.split("refs/tags/")[1])
    .filter(Boolean)
    // 附注 tag 会同时出现 `v1.2.3` 与 `v1.2.3^{}` 两行，去掉 peel 后缀去重。
    .map((ref) => ref.replace(/\^\{\}$/, "")),
);

const localOnlyTags = localTags.filter((tag) => !remoteTags.has(tag));
if (localOnlyTags.length === 0) {
  process.exit(0);
}

console.error(
  [
    "发版已中止：以下 tag 只存在于本地，远端没有：",
    ...localOnlyTags.map((tag) => `  - ${tag}`),
    "",
    "release-it 会用 `git push --follow-tags` 推分支，这些 tag 会被一起推上去，",
    "而推 tag 会直接触发公开发布。请先逐个确认：",
    "  - 该发布：先 `git push origin <tag>`，再重跑发版；",
    "  - 不该发布：`git tag -d <tag>` 删掉本地 tag。",
  ].join("\n"),
);
process.exit(1);
