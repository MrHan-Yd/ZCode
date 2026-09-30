# Git 提交消息的模型来源

## 背景

生成提交消息此前不接受任何模型输入：服务层直接读 Host 的 `preferredSelection`（持久化的默认模型；未设置时按 registry 顺序取第一个可见 provider 的第一个模型）。在没有配置默认模型的环境里，这个值恒定指向 provider 顺序的第一位，与用户当前窗口正在用的模型无关；用户也无法从 UI 看出请求打到了哪个模型，只能看到一句统一的失败提示。

本次改为**默认继承当前会话模型**，并在设置页提供「提交消息模型」覆盖项。

## 产品规则

1. 模型解析顺序（单次解析，只有一个入口）：

   1. 设置页配置的固定模型（`gitCommitMessageModelSelection`）；
   2. 否则用当前会话（composer 草稿）的模型选择；
   3. 否则退回 Host 的 `preferredSelection`，服务没有 UI 会话上下文时的兜底。

2. 设置项默认值 = 跟随当前会话。选择器把「跟随当前会话」放在第一项，选中即写入 `null` 清除覆盖。

   - 用 `null` 而不是 `undefined` 表达「清除」：RPC 传输会吞掉 `undefined`（见 `packages/services/src/setting/normalizeSettingsPatch.ts` 中终端字体清空的同类注释），`undefined` 过不了 renderer→host 边界。

3. 固定模型只在当前 Host 的 registry 候选中可选。已失效的固定模型**不回退、不静默改写**：请求按原样发出，失败沿用现有失败提示，CLI 日志记录实际 providerId / modelId。

4. 提交弹窗的按钮、交互与成功/失败文案不变；本次不改错误提示的粒度。

## 状态所有者

- **配置值**：`ISettingService`（`AppSettings.gitCommitMessageModelSelection`）是唯一事实源，只有设置页写它。
- **当前会话模型**：composer 草稿（`V4ComposerDraft.modelSelection`，即 `draftConfig.modelSelection`）。`GitActionMenu` 只读，不复制、不缓存。
- **解析动作**：只发生在 `GitActionMenu` 的生成入口——它是唯一同时拿得到设置与会话模型的地方。服务层不再自行决定模型，只执行调用方传入的 selection。

## 接口

```ts
// packages/shared/src/git.ts
interface GitGenerateCommitMessageRequest {
  // ...
  /** 调用方当前会话使用的模型；缺省时服务退回 Host 的 preferredSelection。 */
  selection?: ModelSelection;
}

// packages/shared/src/protocol.ts
interface AppSettings {
  /** 生成提交消息使用的固定模型；null/缺省表示跟随当前会话。 */
  gitCommitMessageModelSelection?: ModelSelection | null;
}
```

- `GitCommitMessageGenerator.generate({ selection? })`：传入即用，未传才读 `preferredSelection`。
- 服务日志新增 `selectionSource`：`session | preferred`，用于区分两条来源（UI 侧另记 `configured`）。
- `querySource` 仍为 `git_commit_message`，模型能力绑定（最低推理档 + 辅助输出预算）不变。

## 验收场景

1. 未配置覆盖项、当前会话模型为 X → 生成请求打 X，日志 `selectionSource=session`。
2. 配置覆盖项为 Y、当前会话为 X → 请求打 Y，日志 `selectionSource=configured`。
3. 覆盖项选回「跟随当前会话」→ 落盘 `null`，请求回到会话模型。
4. 不传 selection 的调用方（无 UI 会话上下文）→ 仍用 `preferredSelection`，不产生行为回归。
5. 覆盖项指向当前 Host 上已失效的模型 → 请求失败并给出既有失败提示，不静默换模型。

## 已知限制

- 只影响提交消息生成。`session_title`、`prompt_enhance` 等辅助调用各自解析模型，语义不变。
- 失败原因在 UI 上仍是单一文案（`git.actionMenu.commitDialog.error.generateFailed`），真实原因只在 CLI 日志；本 spec 不承诺改善提示粒度。
