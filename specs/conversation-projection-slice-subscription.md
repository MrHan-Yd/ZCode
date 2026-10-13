# 会话投影 store 切片订阅

## 背景

`useConversationProjection`（`packages/ui/src/v4/useConversationProjection.ts`）此前只提供
整桶订阅：返回整个 `ConversationStoreState`。store 的 `setState` 每次都新建整个 state 对象
（`conversationProjectionStore.ts`），而流式期间每个 delta 帧都会更新 `snapshot`，导致所有
整桶订阅者（SessionPane + 6 个 side pane + treemapping hook）在每个流式帧上全部重渲染，
即使它们各自只消费 `snapshot` 的一个子结构。

## 行为

新增 selector 版 hook `useConversationProjectionValue(lease, selector)`：

- 基于 `useSyncExternalStore`，`getSnapshot` 内做 **(state 引用 → selector 结果) 缓存**：
  state 未变时直接返回缓存值，保证返回值引用稳定（否则会触发 React 重渲染循环）。
- 组件只在自己消费的切片变化时重渲染。

### 为什么切片引用稳定是成立的

`applyConversationDelta`（`packages/shared/src/zcode-protocol-v4/apply.ts`）已做结构共享：
`row.delta` 只重建 `rows.window` 数组与目标行，`subagents`、`workflowRuns` 等其余键通过
浅拷贝保留原引用。因此 `s => s.snapshot?.subagents` 这类 selector 在纯文本流式期间返回
引用不变，订阅者不重渲染。

## 所有权与不变量

- Owner 不变：projection store 仍是会话投影状态的唯一所有者；本改动只影响**订阅侧**。
- 整桶 hook `useConversationProjection` 保留：SessionPane 等真实消费大部分字段的组件
  继续使用，行为不变。
- selector 必须是**纯函数**且返回值来自 state 内部引用（字段、数组内对象、find 结果），
  不得在 selector 内构造新对象；否则引用永远不稳，退化为整桶订阅。
- 流式语义不变：`row.delta` 更新目标行时该行引用变化，消费该行的 selector 正常触发重渲染。

## 迁移范围（本批）

- `PlanDetailSidePane`：selector 取目标 toolCall row（行未变时 find 结果引用稳定）。
- `SubagentDirectorySidePane`：selector 取 `snapshot?.subagents`。
- `WorkflowActorSessionSidePane` / `WorkflowWorkspaceSidePane` / `WorkflowRunSidePane`：
  selector 取 `snapshot?.workflowRuns`（`rows.window` 属真实消费，保留原样）。
- `WorkflowArtifactSidePane` / `WorkflowRunDirectorySidePane`：selector 取
  `workflowRuns?.runs` / `workflowRuns?.runs`（find / refreshKey）。
- 不迁移：`SessionPane`（消费几乎全部字段，收益低）、`useTreemappingConversationMessage`
  （消费整个 `rows.window`，流式期间本来就每帧变化）。

## 失败语义

- `lease` 为 null 或 store 关闭时，selector 作用于 `CLOSED_STATE`，与整桶 hook 一致。
- 组件卸载时 `useSyncExternalStore` 自动退订，无新增清理路径。

## 验收

- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
- 人工验证：打开 Subagent/Workflow side pane 时主会话流式输出不再触发这些面板重渲染。
