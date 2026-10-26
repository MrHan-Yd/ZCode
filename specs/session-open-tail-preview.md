# 会话首帧只读尾部预览（Session Open Tail Preview）

## 背景

冷开历史会话时，首帧必须等 `app.resume` 完成全量 transcript 读取与投影归约：实测 2496 条消息的会话，
`store.messages()` 冷盘约 8.1 秒，完整 resume 约 1.3 秒，之后才轮到 60 行尾窗。用户在这段时间只看到骨架。

本特性在**不改变权威冷恢复链路**的前提下，增加一个独立的只读尾部预览：先从 SQLite 读取最后 N 条消息，
立即渲染一个非权威预览；权威 snapshot 到达后由正式时间线整体接管。它是“看”和“继续对话”解耦的第一步，
不是新的会话状态来源。

## 产品规则

1. **触发**：pane 处于 connecting（`sessionId !== null && (state.status === "connecting" || snapshot === null)`）、
   非草稿态、且会话不存在 revert/branch cut（存在时活跃分支可能不是 transcript 尾部，v1 直接回退骨架，
   不做按 cut 点截断）。
2. **内容**：最后 `limit`（默认 40，最大 80）条消息，按原时间顺序展示。只包含：
   - `role === "user" | "assistant"`；
   - text part 的正文，单条最多 2000 字符，超出截断并加省略号；
   - 工具调用只显示数量（`N 个工具调用`），不显示工具输入/输出；
   - 不含 reasoning、附件、patch、快照等内部 part；
   - 跳过 synthetic 用户消息、`source === "shared_context"` 的交接消息、`synthetic` text part；
   - 没有任何正文且没有工具调用的消息跳过。
3. **只读**：预览是渲染层的一次性视图，不是会话状态：
   - 不进入 `ConversationProjectionStore`，不产生 rowId/revision，不接受命令；
   - 不对预览发 `loadOlder`、文件变更、撤销、搜索等请求；
   - 不写 sessions-index，不作为 resume base，不参与分享。
4. **禁写**：connecting 期间 composer 沿用现有 `disabled` 逻辑（`SessionPane` 已按 `connecting` 禁用），
   预览不额外开放输入；不新增“排队草稿”语义。
5. **替换**：权威 snapshot 到达后预览立即卸载，正式时间线渲染；两者不做行级合并。时间线保持既有的
   `stickToBottom` 初始位置。v1 不把预览的滚动锚点迁移到时间线：用户在预览中上滑后，权威替换会回到
   尾窗底部。
6. **失败与回退**：请求失败、方法不存在（旧 CLI）、超时、返回空列表、会话有 revert/branch cut 时，
   一律回退到现有骨架 `ConversationLoadingState`，不显示错误面板。
7. **取消**：pane 卸载或权威 snapshot 先到时，忽略迟到的预览结果（不得 setState 到已卸载组件）。
8. **平台一致**：桌面 `desktop-continuous` 与手机 `web-remote-replayable` 使用同一个只读 RPC；
   它是无状态查询，不进入两条交付链路的状态机。
9. **国际化**：新增文案同时加入 zh-CN / en-US；预览根节点带 `data-testid`（`TID_SESSION_TAIL_PREVIEW`）。

## 状态所有者

- **持久事实**：CLI 的 session store（message/part）。预览只读它，不缓存、不回写。
- **权威会话状态**：仍是 `ConversationTopicPublisher` / `ProductProjection`。预览不是第二真值。
- **预览生命周期**：只存在于 `SessionPane` 的局部 state（hook），随 connecting 结束销毁。
- **请求归属**：UI 通过现有 workspace conversation transport 发 `v4/conversation/tailPreview`；
  Host 用 `getReadOnlyClient` 复用/拉起同一个 CLI 进程，不新建 Agent。

## 接口

```ts
// V4_METHODS
conversationTailPreview: "v4/conversation/tailPreview"
```

```ts
// params
{
  sessionId: string;
  limit?: number; // 默认 40，1..80
}

// result
{
  sessionId: string;
  hasMore: boolean;       // 会话消息数 > limit
  messages: Array<{
    id: string;
    role: "user" | "assistant";
    createdAt: number;
    text: string;         // 已截断
    toolCallCount: number;
  }>;
}
```

- 只读、无状态、超时重发安全；不新增 revision/logEpoch。
- 旧 CLI 不实现该方法时，Host 把 `method not found` 映射为 `null`，UI 回退骨架。

## 数据流

```text
click session
   │
   ├─ UI: useSessionTailPreview(enabled = connecting)
   │     └─ transport.tailPreview ──► Host getReadOnlyClient ──► CLI v4/conversation/tailPreview
   │                                                              └─ sessionStore.tailMessages(limit+1)
   │                                                                   └─ 只读最后 N 条 message/part
   │     └─ setPreview(messages) ──► SessionPane emptyState = ConversationTailPreview
   │
   └─ 原有权威链路（并行、不变）
         subscribeConversationV4 ──► 全量 read → resume → hydrate → tail 60 行 snapshot
                                        └─ snapshot 到达 ──► connecting=false ──► 预览卸载，时间线接管
```

## 服务端读取

- `SessionStorePort.tailMessages?({ sessionID, limit })` 返回**升序**的最后 `limit` 条消息（含 parts）。
- SQLite 实现：按 `(session_id, sequence, time_created, rowid)` 倒序取 `limit+1` 条，再反转；
  parts 只查这些 messageId。
- 读取前先 `getSession`：若 `revert` 存在（`branchCutAfterMessageID` / `targetMessageID` /
  `createdMessageID` / `keptMessageIDs`），说明活跃分支可能不是 transcript 尾部，**本次不提供预览**，
  UI 回退骨架。v1 不做“按 cut 点截断”的复杂读取，避免展示已丢弃分支。
- 旧 store 没有 `tailMessages` 时，回退 `messages()` 后切片，并用 warn 记录（只影响性能，不改变形状）。
- **实测**（本机、2496 消息会话、热缓存）：`limit=40` 的完整预览读取 **36.7 ms / 39 条消息 / 约 3.7k 字符**；
  `limit=80` 为 40.9 ms / 约 9k 字符。首屏剩余时间主要是 CLI 进程启动（约 1.1–1.4 s），
  不再是 8 s 的全量 transcript 读取。

## 验收场景

1. 冷开长会话：骨架 →（CLI 尾部读取完成）预览 →（权威 snapshot）正式时间线；预览期间 composer 保持禁用。
2. 预览请求失败 / 旧 CLI 不识别方法：全程骨架，不出现错误提示。
3. 预览先返回、snapshot 后到：正常替换，无重复渲染、无行级合并。
4. snapshot 先到、预览后到：迟到的预览被忽略，不覆盖正式时间线。
5. 会话有未完成 revert/branch cut：不显示预览，回退骨架。
6. 会话消息少于 limit：`hasMore=false`，全部展示。
7. 桌面与手机：预览内容一致；手机重连不把预览当作恢复状态。
8. 预览期间不发任何命令、`rowsRange`、`fileChanges`、sessions-index 写请求。

## 非目标

- 不做预览内分页/搜索/撤销/文件详情。
- 不追求与正式时间线逐像素一致（v1 是简化视图）。
- 不改变权威冷恢复链路、snapshot 契约、rowId 身份或 `loadOlder` 语义。
- 不缓存预览结果，不持久化，不写 sessions-index。
- 不做命令排队；connecting 期间输入仍按现有 disabled 规则处理。
