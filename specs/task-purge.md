# 彻底删除归档任务并释放磁盘空间

## 背景

归档与「移除」都只改 tasks-index 的状态（`archived` / `deleted`），会话数据全部留在磁盘上，
不释放空间。本 spec 定义「彻底删除」：物理删除会话数据与任务文件，并把空闲页归还文件系统。

**不可恢复**，因此必须由用户显式二次确认后才执行。

## 产品规则

1. **两档删除语义**：
   - 「移除」（现有）：写墓碑，从列表消失，数据仍在磁盘；
   - 「彻底删除」（本次）：删除数据 + 回收空间，不可恢复。
2. **只对归档任务开放**：`archived = 1` 才允许彻底删除，避免误删正在使用的任务。
3. **运行中拒绝**：任务状态为 `running` 时跳过并计入 `skippedTaskIds`，不报错、不删除。
4. **能力缺失显式失败**：CLI 未提供 `sessionStore.purgeSession` 时命令返回失败，
   不静默降级成「只关闭会话」——否则用户会以为空间已释放。
5. **删除后广播**：沿用 `task_deleted` reason，与现有删除一致，让列表 tombstone 收敛。
6. **不要求会话常驻**：目标通常是归档的历史任务，本就没有活动 record。命令入口对
   `purgeSession` 豁免「sessionExists 才准入」（`command-inbox` 的 `PERSISTED_DATA_COMMANDS`），
   handler 也不用 `requireRecord`；否则这些任务会在 admission 阶段被 `proto.sessionNotFound`
   拒绝，永远删不掉。运行时若恰好常驻，bridge 钩子会先按 closeSession 的顺序摘除。
7. **产物目录根在进程启动时登记**：`zcode-protocol-entrypoint` 与 `create-app` 用同一表达式
   登记 storageRoot / cliStorageRoot，保证「没有创建过 app 的进程」也能清理产物目录。

## 删除集合（最小安全集）

CLI 侧（`SessionStorePort.purgeSession`，见 `repositories/sessions.ts`）：

- `delete from session where id = ?`，按外键级联删除
  `message` / `part` / `todo` / `session_entry` / `session_target` / `session_input` /
  `model_usage` / `turn_usage` / `tool_usage` / `session_task_link` 等 cascade 子行。
- 显式删除**无外键**的 `input_history.session_id`（属于会话内容）。
- 显式把**无外键**的 `dwf_run.parent_session_id`、`dwf_actor.session_id` 置空：
  dynamic workflow 记录保留行、只解除归属。
- `workflow_run` / `workflow_activity` 的父引用本就是 `on delete set null`，历史保留。

CLI 侧文件产物（`app/session-data-purge.ts`，路径与写入方逐一对应）：

- `cli/artifacts/<sanitize(sessionId)>`
- `cli/image-cache|pdf-cache|video-cache/<sanitize(sessionId)>`
- `cli/exec/<sanitize(sessionId)>`
- `cli/sessions/<sessionId>`（workflow 脚本，写入方用裸 sessionId）
- `cli/agents/<sessionId>`（子代理产物）

Host 侧：

- `v2/sessions/{workspaceHash}/{taskId}.json` 与 `.deleted.json` 快照。
- tasks-index 的 tasks 行**物理 DELETE**，并在同一事务里清理 `task_group_members` 与
  `task_group_view_node_orders`（这两张表对 tasks 没有外键级联）。

**不删除**：workspace 级 checkpoint（`GitCheckpointMeta` 无 taskId，无法按任务归属）。

## 空间回收

删除行之后 sqlite 文件不会自己缩小。`VACUUM` 需要排他锁并重写整库，且多个 Agent 进程
共享同一 session DB，因此按双阈值触发，避免为小批量删除付出秒级代价：

- `freelist_count >= VACUUM_MIN_FREE_PAGES`（2000 页，约 8MB）
- 且 `freelist_count / page_count >= VACUUM_MIN_FREE_RATIO`（0.2）

VACUUM 失败（最常见是多进程争锁的 SQLITE_BUSY）**静默吞掉**：删除已经提交，空间回收是
best-effort，不能把成功的删除变成失败。

## 状态所有者

- **会话行与消息**：CLI `SqliteSessionStore`（唯一持有 session DB 连接的实现）。
- **产物目录**：CLI bootstrap（`session-data-purge`，根由 `create-app` 登记，与写入方同源）。
- **tasks-index 行与 v2 快照**：Host（`taskIndexRepo` / `zcodeTaskServiceAdapter`）。
- **确认面**：Host/UI；协议层不做确认。

## 时序

```
UI 二次确认（不可恢复）
  → Host：逐任务校验（archived=1、status != running）
  → 发 v4 purgeSession 命令（CLI 进程）
      → closeSessionRecord（退订 / app.close / gateway 清通道 / 注册表摘除）
      → store.purgeSession（事务删行）→ 按阈值 VACUUM
      → purgeSessionDataDirs（删 cli/* 产物目录）
  → Host：删除 v2/sessions 快照文件
  → Host：taskIndexRepo.purgeTask（物理删行 + 清理分组引用）
  → 广播 task_deleted
```

顺序不可颠倒：会话仍在注册表时删库，后续事件写入会重新 insert 出半截会话。

## 验收场景

1. 归档任务彻底删除后：磁盘占用下降（达到阈值时）、归档列表不再出现该任务、重启后不复活。
2. 未归档任务：不提供彻底删除入口。
3. 运行中的任务：跳过并在结果里标记 skipped，不删除。
4. CLI 不支持 purge 能力：命令失败，任务不被删除，列表状态不变。
5. 多进程同时写库：VACUUM 失败不影响删除结果。

## 已知限制

- 无法按任务回收 checkpoint（workspace 级，无任务归属）。
- 删除是逐会话命令，批量删除 N 个任务会发 N 次命令；VACUUM 由阈值兜住频率。
- 运行中守卫只看 tasks-index 的 `task_status`（`running` 跳过）。多 Agent 进程共享同一 session DB，
  若另一进程仍在用该会话，删行后它可能重新 insert 出半截会话——彻底删除只对归档任务开放，
  这类竞态需要后续在 Host 侧叠加活动 attachment 判定。
- `purgeSession` 已加入 `SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS`：side chat 由模型驱动，
  不允许它自行触发删库。
- 命令经 `sendConversationCommandV4` 走 workspace 的 CLI 连接；「workspace 从未有过活动会话时
  这条连接是否一定可用」尚未在真实环境验证（本仓库环境起不了 Electron），需要在桌面端 E2E 覆盖。
- `cli/sessions/<id>` 与 `cli/agents/<id>` 用裸 sessionId（与写入方一致）。session id 由系统生成，
  不含路径分隔符；若将来允许外部传入 id，需要补路径段校验。

## 接入进度（已完成）

- shared：`purgeSession` 命令载荷。
- contracts / adapters：`SessionStorePort.purgeSession`、事务删除（含无外键引用的解除）、
  阈值 VACUUM、`sanitizePathSegment` 公开导出。
- bootstrap：`purgeSession` handler、`V4CommandCoreHost.purgeSession` 钩子、bridge 实现
  （close → 删库 → 删产物目录）、`session-data-purge`（根缺失显式失败）。
- services：`taskIndexRepo.isArchivedTask` / `purgeTask`、adapter `purgeArchivedTasks`
  （运行中守卫 → CLI 命令 → v2 快照 → 索引行 → `task_deleted` 广播）、service 接口。
- desktop：window-controller 接口 + `purge-archived-batch` mutation + host 转发。
- ui：归档管理页「彻底删除 / 彻底删除本组 / 彻底删除全部」与不可恢复确认文案。
- 测试：`adapters/test/sessionPurge.test.ts`（级联 + 无外键解除 + 幂等）、
  `services/test/taskPurge.test.ts`（仅归档可删 + 物理删除）。
