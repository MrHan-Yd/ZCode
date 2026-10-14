# 提交消息的格式与长度约束

## 背景

生成提交消息时，模型输出此前会被静默裁剪到 `MAX_COMMIT_MESSAGE_CHARS` 上的 `slice` 结果。模型偶尔会多写一段解释或正文，裁剪点落在句子中间，提交历史里就留下一句断掉的话——用户看到的不是"生成失败"，而是一条看着像正常消息、实际被砍过的文本。本次改成**生成时约束 + 超限判不合规**：约束写进提示词（模型能读到），校验只做判定，任何情况下都不再裁剪模型输出；上界同时从 1000 收紧到 500 字符（约定的提交消息本来远短于此）。

## 产品规则

1. **首行必须是 Conventional Commit**：type ∈ {feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert}，可选 `(scope)`，可选 `!`，然后是 `: ` + 1–100 字符的主题。不合规即判为不可用，不补、不裁剪。
2. **提示词显式约定长度**（模型可见，是唯一的"生成时约束"）：
   - 首行主题 < 72 字符；
   - 整条消息（含正文）≤ `MAX_COMMIT_MESSAGE_CHARS`（500）字符；
   - 优先只写一行，只有主题装不下的信息才加正文。
3. **整条消息上界是判定，不是裁剪**：超过 500 字符 → 生成失败（UI 沿用既有单一失败文案），服务日志记 `reason=too-long` 与长度/短预览。禁止把模型输出 `slice` 后当提交消息用。
4. **装饰剥离先于判定**：``` 围栏、`commit message:` 前缀、包裹引号等先去掉，再按规则 1–3 判定长度与首行。
5. **用户手打的消息不受约束**：本项目对生成物负责；输入框里的文本按原样提交。

## 状态所有者

- **约束与判定**都只存在于 `GitCommitMessageGenerator`：`buildGitCommitMessageGenerationPrompt`（写进提示词）与 `validateGeneratedGitCommitMessage`（判定）。
- **长度的唯一事实源**是常量 `MAX_COMMIT_MESSAGE_CHARS`；提示词里的数字由该常量插值，不允许出现第二份手写数字。
- 不新增协议字段、不改 UI 文案、不改模型来源解析（见 `git-commit-message-model.md`）。

## 接口

```ts
// packages/services/src/git/gitCommitMessageGenerator.ts
const MAX_COMMIT_MESSAGE_CHARS = 500;

type GitCommitMessageValidationFailureReason = "empty" | "invalid" | "too-long";

validateGeneratedGitCommitMessage(rawMessage: string):
  | { ok: true; message: string }
  | { ok: false; reason: GitCommitMessageValidationFailureReason; preview?: string };
```

## 验收场景

1. 模型返回 500 字符以内、首行合规 → 原样使用，不裁剪。
2. 模型返回 501 字符 → 生成失败（消息不是被切成 500），日志 `reason=too-long`。
3. 首行不是 Conventional Commit（含主题超过 100 字符）→ 生成失败，`reason=invalid`。
4. 输出带 ```围栏 /`commit message:` 前缀 / 引号 → 先剥离装饰，再按规则 2 判定；剥离后合规即通过。
5. 用户手打一条 2000 字符的消息 → 正常提交，不进入生成器的判定。
6. 提示词里出现的长度数字与 `MAX_COMMIT_MESSAGE_CHARS` 一致（改常量即改提示）。

## 已知限制

- 失败在 UI 上仍是单一文案（`git.actionMenu.commitDialog.error.generateFailed`），`invalid` / `too-long` 的区别只在服务日志。
- **不做自动重试**：超限时用户再点一次生成，或自己写消息。加自动重试会引入新的模型调用次数与费用，需要另外决策。
- 首行主题的社区惯例是 ≤ 50（上限 72），代码只在提示词里约定 < 72，硬判定的首行上界仍是 100 字符（拒绝而非裁剪）。中文按显示列宽算，一字两列。
- 500 字符是整条消息的硬上界，不含首行更严的 72 字符软约定；两者同时生效时以先触发者为准（首行超 100 判 `invalid`，整条超 500 判 `too-long`）。
