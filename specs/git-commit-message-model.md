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

## 4.0.1 模型设置回归修复

### 原因与迁移边界

Git 入口从会话状态面板迁移到工作区标题栏时，遗漏了当前 Composer 模型的传递。设置仍显示「跟随当前会话」，请求却因缺少 selection 退回 Host 默认模型。固定模型设置只持久化 providerId / modelId；严格 Model Factory 又要求完整推理档位，Core 在创建 Model 后绑定辅助档位无法修复创建前的失败。

修复只恢复上述两条路径，不恢复旧 Git 面板、不更改主会话模型、不改变模型网络重试、60 秒超时、消息格式或费用策略。

### 产品规则

1. 「跟随当前会话」在每次生成的写入口读取当前 Composer 的有效模型，与输入框使用同一事实源；切模型后无需重开弹窗，下一次生成立即使用新选择。
2. 标题栏通过只读端口访问 Composer 已有的 modelSelection ref，不另存一份模型或从会话历史、Host 默认值推断当前选择。
3. 端口按 `[workspaceIdentity?.trim() || workspacePath, sessionId ?? draftScope]` 隔离。只注册当前可交互 pane，切会话、切工作区、切焦点或卸载时释放旧读端口；旧清理不能删除新注册。
4. 设置尚未读取完成，或有 UI 会话上下文但尚无有效模型时，生成明确失败，不偷偷使用 Host 默认模型或把尚未读取的固定配置当成「跟随」。固定配置优先于读端口；没有 UI 上下文的既有脚本调用仍保留 Host preferred fallback。
5. 固定模型候选沿用当前 registry 的公开模型列表。设置保存、清除与重启恢复继续由 ISettingService 负责；生成时始终携带该 providerId / modelId，不能因缺档位、不可用或网络错误换渠道。
6. Git 辅助请求在 Model Factory 校验前，按目标模型公开能力补齐最低推理档位，保留其它 options。Core 原有辅助输出预算不变；不在 UI 持久化另一份档位默认值。
7. 未知、已删除或已禁用的固定选择保持明确失败，不自动回退；「可选」表示当前配置可执行，不承诺供应商永不返回限流或网络故障。
8. 生成按钮与留空提交使用同一解析入口。只生成消息不暂存、不提交、不推送；手填非空消息仍绕过 AI 生成。
9. 生成请求捕获弹窗的 mounted/open/loadGeneration/scope 生命周期。关闭重开、切会话、切 identity 或服务变化后，旧结果、错误与 pending 不回写新弹窗；留空提交必须在生成完成后、首次 Git 写入前再次校验，过期请求不得暂存、提交或推送。已经进入 Git 写入的操作仍按原提交链收口，不半途中断已接纳的写操作。

### 所有者与事件顺序

```text
设置页 → ISettingService（固定模型唯一写入方） ────────────────┐
                                                          │ 优先级解析
Composer owner（useDraftConfigControl，唯一模型意图）         │
  └─ draftConfigRef → scope 隔离的只读端口 → 标题栏 Git 写入口 ┘
      → GitGenerateCommitMessageRequest.selection
      → 目标 Workspace Host / CLI facade
      → registry 补齐辅助档位 → 严格 Model Factory → 模型请求
      → 消息格式校验 → 输入框
```

只读端口保存的是访问函数，不保存或写回模型事实。生成开始时冻结本次 selection，后续模型改选只影响下一次请求。Desktop continuous 与手机 Web replayable 保留各自现有连接/恢复语义；两者均复用相同 Composer 与 GitService，不新增协议或 Agent。workspacePath 用于 Git 操作，workspaceIdentity 用于隔离并完整透传。

### 补充验收场景

- 跟随模式下，输入框 X、Host 默认 Z：标题栏生成请求必须打 X，不能读 Z。
- 弹窗保持打开，输入框由 X 改成 Y：第二次生成必须打 Y。
- 固定 P、输入框 X：实际请求始终打 P；清回「跟随当前会话」后重新生成打 X，且设置落盘为 null。
- 切换同路径不同 workspaceIdentity 或不同 session，旧读端口和卸载清理不能串入新请求；没有当前选择时不发默认模型请求。
- 固定选择只含 providerId / modelId：真实 Factory 校验通过后调用该目标模型，辅助最低档位来自目标模型。
- 固定选择已失效或模型请求失败：不换默认模型，现有失败文案和手填提交路径仍保留。
- 真实浏览器通过设置控件、标题栏 Git 入口与生成按钮验证固定、清除、会话切换、留空提交两条入口；Desktop 和手机尺寸、中文/英文与亮暗主题覆盖代表场景。

## 已知限制

- 只影响提交消息生成。`session_title`、`prompt_enhance` 等辅助调用各自解析模型，语义不变。
- 失败原因在 UI 上仍是单一文案（`git.actionMenu.commitDialog.error.generateFailed`），真实原因只在 CLI 日志；本 spec 不承诺改善提示粒度。
