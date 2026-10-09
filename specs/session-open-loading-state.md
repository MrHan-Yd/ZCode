# 会话首帧加载占位（Session Open Loading State）

## 背景

点击侧栏历史会话后，主区域要等「冷恢复」完成才出现内容：订阅 → 拉起/复用 CLI → 读全量 transcript → 恢复 runtime → 水合投影 → 打帧。其中读盘与水合是全量的，窗口化只发生在打帧边界，所以耗时会随会话总长度增长；长历史会话的等待尤其明显。

在这段等待里，`SessionPane` 的 `connecting` 分支把空数组交给时间线，消息区是**纯空白**——没有任何占位，用户无法区分「在加载」和「坏了」。

同时，侧栏的 sessions-index 订阅早已持有该会话的标题与 `lastAssistantPreview`（≤120 字符），但这份数据只被侧栏消费，主区域完全没用上。

本次只改「首帧到达之前的展示」，**不改冷恢复链路本身**，也不改变首帧到达后的任何渲染行为。

## 产品规则

1. **触发条件**：pane 处于 connecting（`sessionId !== null && (state.status === "connecting" || snapshot === null)`）且非草稿态。首帧 snapshot 到达后占位立即卸载，不加退场动画。
2. **骨架形态**：3 组「用户输入行 + 助手回复行」的对话轮廓，表达"内容即将出现在这里"。不伪装成真实内容（不使用真实文案、不冒充已完成的回答）。
   - **锚点必须与首帧内容一致（底部）**：首帧拿到的是「尾窗 + 吸底」——服务端按 `snapshotTailWindowRows`（60 行）截尾，真实会话滚动为 `stickToBottom`。骨架若留在消息区顶部，就会出现「骨架在顶部 → 内容出现在底部」的整屏跳变，长会话下尤其明显。因此骨架与预览行都要贴在消息区底部，预览行落在最下方（= 最新一条回复的位置，也是用户视线所在处），内容到达后从底部接上、再往上补更早的行。
   - 骨架内容高于可视高度时退化为「从顶部开始 + 随滚动可达」，不使用父级 `justify-end`：`justify-end` 会把溢出的部分顶到滚动起点之外，滚轮也回不去。
3. **预览行（可选）**：若该会话在 sessions-index 中存在且带 `lastAssistantPreview`，在骨架底部显示一行「上一轮回复」预览，单行截断。取不到就不显示——**不因此降级骨架本身**。
4. **标题兜底**：connecting 期间 header 标题回退到 sessions-index 的 `title`（仅在 `snapshot` 为空时生效）。snapshot 到达后完全沿用既有 `snapshot.meta.title` 路径。
5. **只读无副作用**：不写任何状态、不发起任何新 RPC、不新增 protocol 方法、不新增持久化。
6. **无障碍**：占位根节点 `role="status"` 并提供 sr-only 文案（随 locale）；骨架块 `aria-hidden="true"`。
7. **优先级**：订阅错误态优先于占位——`errored` 时仍渲染既有的 `SessionSubscriptionErrorPanel`，不残留骨架。
8. **平台一致**：桌面与手机 Web 同一组件；浅色/深色主题全部使用既有语义 token。

## 状态所有者

- **预览与标题的权威**：CLI 的 sessions-index（`SessionSummary.lastAssistantPreview` / `title`）。renderer 不缓存第二份、不派生、不回写。
- **订阅复用（关键）**：通过 `acquireSessionsIndex(scope, agentService)` 按 `endpoint + workspaceKey` 取共享 store，refCount 复用侧栏已建立的那条订阅。本特性**不新增第二条 sessions-index 订阅**。
- **占位本身**：纯 renderer 显示投影，只存在于组件实例，不持久化。首帧到达即销毁。
- **数据读取开关**：只有处于 connecting 时才持有该 store 引用（hook 参数传 `null` 即释放），live 之后不额外占资源。

## 接口

```ts
// packages/ui/src/v4/useSessionIndexSummary.ts
// 参数形状（内部类型，不对外导出）：
interface SessionIndexSummaryScope {
  workspacePath: string;
  workspaceIdentity?: string | undefined;
  remoteSessionId?: string | null | undefined;
}

/**
 * 读取某会话在 sessions-index 中的摘要（标题 / 上一轮回复预览）。
 * 复用共享 store；sessionId 为 null 或对端订阅尚未就绪时返回 null。
 */
export function useSessionIndexSummary(
  scope: SessionIndexSummaryScope,
  sessionId: string | null,
): SessionSummary | null;
```

```tsx
// packages/ui/src/v4/ConversationLoadingState.tsx
export function ConversationLoadingState(props: {
  /** 上一轮助手回复预览；空则不渲染该行。 */
  preview?: string | null;
  className?: string;
}): JSX.Element;
```

复用既有槽位，**不修改** `ConversationTimeline` 的 props：`SessionPane` 在 connecting 且非草稿时把 `ConversationLoadingState` 传给时间线既有的 `emptyState`。

之所以必须走槽位而不是整体替换时间线：`ConversationComposer` 挂在 `ConversationTimeline` 的 `bottomDock` 内，替换时间线会连带移除输入框。

## 数据流

```text
CLI sessions-index（title / lastAssistantPreview 唯一权威）
        │  已有订阅：侧栏 + pane guard 共享（refCount，不新增）
        └─ SessionsIndexStore.getSessions()
                 │
        useSessionIndexSummary(scope, connecting ? sessionId : null)
                 │
        SessionPane ── emptyState ──► ConversationLoadingState（connecting 期间）
                 └─ ConversationHeader.title 兜底（仅 snapshot 为空）

首帧 snapshot 到达 ──► 占位卸载 ──► ConversationTimeline（既有路径，行为不变）
```

## 验收场景

1. **打开长历史会话**：点击后消息区立即出现骨架，不再纯空白；该会话在 sessions-index 中且带 preview 时，骨架底部显示上一轮回复预览。
2. **首帧到达**：骨架消失，时间线正常渲染；时间线实例不重挂（composer 不重建、不丢草稿）。
3. **索引未就绪 / 无该会话**（deeplink 直开、远程 endpoint 未连上）：只显示骨架，无预览行，不报错、不阻塞。
4. **草稿态**（`sessionId === null`）：仍走既有 `ConversationDraftEmptyState`，不受影响。
5. **订阅失败**：显示既有错误面板，骨架不残留、不闪烁。
6. **切换会话**：从 A 切到 B 时预览必须立刻换成 B 的（或清空），不能残留 A 的预览。
7. **zh-CN / en-US**：sr-only 文案与预览行标签随 locale 变化。
8. **主题与窄屏**：浅色/深色、桌面/手机 Web 下骨架与预览不溢出、不遮挡输入框。
9. **锚点一致（无跳变）**：connecting 期间骨架贴在消息区底部、紧邻输入框；首帧到达后内容从底部接上，不出现「骨架在顶部 → 内容在底部」的整屏跳变。窗口高度不足以容纳骨架时，骨架从顶部开始并可通过滚动看全（不出现滚不回去的溢出）。

## 已知限制

- 预览只有 ≤120 字符的**上一轮助手回复**，不是完整末条消息；且取自 sessions-index 最近一次快照，可能略滞后于真实末条。
- 标题兜底可能短暂显示 sessions-index 的旧标题（例如自动标题刚被重生成），首帧到达后即被权威标题覆盖。
- 首帧到达后，若尾窗正好切断了首个 turn 的 header，`SessionPane` 会立即自动补拉一次 `rowsRange`；这次前插由 V4 的 prepend 锚点补偿，不产生可见跳变，故不延后。
- 本改法**不缩短**冷恢复耗时，只消除「空白」与「骨架/内容锚点不一致的跳变」。真正缩短首屏需要把 CLI 的读盘与水合改成尾部优先（有界读 + 按需回补水合），另立 spec——`packages/shared/src/zcode-protocol-v4/core.ts` 的 `snapshotTailWindowRows` 只是打帧边界截尾，读盘仍是全量 `select * from message`（`apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/messages.ts`）加全量反向合成（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`）。

## E2E 锚点

- `TID_V4_TIMELINE_LOADING` = `"v4-timeline-loading"`：占位根节点。
- `TID_V4_TIMELINE_LOADING_PREVIEW` = `"v4-timeline-loading-preview"`：预览行。
