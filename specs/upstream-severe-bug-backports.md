# 官方严重缺陷的最小修复移植

## 本次授权边界

只修复官方 `zai-org/ZCode` 已提供修复、当前本地仍能触发的严重缺陷。官方公开对象以 v4.0.0 快照 `a4b4445141eb7d3b3e99eada9292775383bfc44e` 为最终参照，具体修复从其历史同步快照逐 hunk 取证；同步 SHA 不是原始内部修复 PR。

不以此前“23 个确定缺失”的汇总作为实施依据。每条先重新确认本地真实调用链、触发前提及现有等价实现，补修前失败的正式回归后才修改。

本次限制在权限绕过、诊断凭据泄露、清数据的写入竞态、目录读取导致进程 IO 耗尽、回退导致记忆写入被错误阻断及与子代理 Plan 限制相关的运行时流程冲突。下列差异不实施：

- Composer 的同类推断、Git symlink 推断及其他没有同场景官方证据的本地问题。
- UI 截断、比例布局、动画性能、错误文案、工具名建议、prompt cache 优化。
- 本地没有触发方的 v3 fill、没有官方 pending-persistence 前提的完全访问授权、本地已用 receipt 实现的重试幂等。
- 官方 guarded、新 OAuth 家族、系统凭据存储、MCP Apps、installer helper、递归工作流留白、麦克风、内存诊断等新功能。

## 保留不变量

1. 不 merge/rebase/cherry-pick 官方快照，不按官方整文件替换本地文件，不删二开模块或依赖。
2. 编排模式、团队与模型选择、动态工作流、提示词库、配置同步、Git 工具、归档、请求统计和记忆数据根保持原功能。
3. 保留现有未提交编排改动；任务开始时的 32 个改动/新增文件已在系统临时目录记录内容指纹，收尾核对，不通过 reset/stash 处理。
4. runtime 继续是权限与 admission 的唯一业务 owner，Host 只调度和路由；不改 owner/lease、attempt generation、stale-run 防护或 CommandInbox。
5. 身份仍以 `workspaceIdentity?.trim() || workspacePath` 隔离；路径用于文件操作。远端 identity 与 remoteSessionId 不丢失。
6. Desktop continuous 与手机 replayable 仍走同一 owner、保持不同传输恢复语义；不新增手机 Agent/Host。
7. 清数据测试绝不调用实际用户数据删除、重启或退出；日志测试使用假凭据，绝不发送遥测。

## 修复子规范

- `upstream-runtime-permission-fixes.md`：父子权限服务、Plan 上限及恢复覆盖的时序。
- `upstream-diagnostic-redaction.md`：MCP stderr 与 Agent 诊断在日志/遥测边界脱敏。
- `upstream-file-directory-read.md`：挂起目录读取在途复用，不伪装底层取消成功。
- `upstream-clear-data-quiescence.md`：沿用现有 Desktop 退出所有者，确认写入方收尾后才删除。
- `runtime-read-state-rewind.md`：保留当前上下文真实已读种子，仍执行 stale/partial 保护。

以上子规范必须在对应实现前写入；实现按本地接口适配，不搬入官方不同架构。

## 正式验证入口

`pnpm test:upstream-fixes` 运行本次 `test/upstream*.test.ts` 正式回归，目录为 CLI core、CLI adapters、services、desktop。入口通过 Node 异步列举测试并串行运行各包，避免 shell 通配符或 Windows 引号差异。

- CLI core/adapters 和 Desktop 的新测试由各自 `tsconfig.upstream-test.json` 纳入根 `pnpm typecheck`；services 沿用已有全量 `tsconfig.test.json`。
- 原编排测试与发行回归必须保留并实际运行。
- 必跑 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`，如有现存失败按真实结果区分，不修改基线掩盖问题。
- 定向检查 CLI 实现的类型与 Lint，不能只依赖根 Lint 忽略的目录。
- Desktop 测试保持严格索引检查，并纳入本地既有 node-forge 声明。测试导入的既有崩溃归档循环中 `keptCount` 从数组长度递减且循环保证大于 1，索引处可补不改变运行时的非空类型断言；不得禁用严格检查、掩盖主工程既有失败或借机修改归档行为。
- 完成后独立复核真实调用链和二开保留情况，修复本次引入的回归。
- 删除系统临时备份/验证产物；用 `git status --porcelain -uall` 和 ignored 状态确认没有一次性脚本、截图、日志或临时配置遗留。正式规范、回归测试和验证入口不是一次性产物。

## 执行结果（2026-11-24）

### 直接上游对应修复

- `a9fe401e`（v3.17.2）：Explore 继承父权限服务与执行模式，父 Plan 不能被子 profile 清掉，恢复 child 最后使用本次派发的完整执行状态；Plan 只收紧原模式，需审批只读工具继续原审批，非只读 MCP 的单次询问政策贯穿事件/broker；子 Plan 不再收到根会话规划收尾流程。
- `a9fe401e` / `b95ebaf`：MCP stderr 前缀/引号/VT 与截断边界脱敏；Agent 诊断统一 Bearer/Basic 优先于赋值，服务到 Main 同规则幂等处理，不改变日志级别、归因或遥测策略。
- `a60ba6a7`（v3.17.1）：挂起目录达到阈值后复用底层读取，settle 后不保留陈旧结果；rewind 保留上下文已读种子，跳过没有新正文的 cached Read，不改变本地 range/工作流快照规则。
- `a4b44451`（v4.0.0）：清数据先等待既有退出/写入 owner，严格 utility exit 与失败截止时间不能被普通退出的 fail-open 替代，失败不删除/重启；Main 日志在清理后不重建目录，普通退出/更新语义保留。

### 已执行验证

- `pnpm typecheck` 通过；新增正式测试均纳入类型检查。
- `pnpm lint` 通过，69 warnings / 0 errors，与开始时相同。
- `pnpm architecture:check --changed` 通过，0 violations / 0 new。
- `pnpm verify:pre-push` 通过，发行回归 13/13。
- `pnpm test:upstream-fixes` 通过：入口接线 2、core 43、adapters 55、services 12、desktop 22，共 134 项（包括 Node 子测试的父项），无失败或跳过。
- 既有 core 编排/目录/辅助生成/工具截断回归 157/157，未提交编排 UI 回归 10/10；Git 服务回归 108/108、bootstrap 子代理历史回归 19/19。
- 额外二开配置同步/GitHub/记忆回归 182/183；唯一失败是未修改的 `subagentConfigSync.test.ts` 把 Windows 的 `nested\\inner.md` 与固定 `nested/inner.md` 比较，单独重跑仍失败。未将此既有平台断言改成通过，也未改配置同步功能。
- core/adapters/bootstrap 实现类型检查通过；新增测试和 helper 的定向 Lint 通过。CLI 既有大文件 `permission/service.ts`、`runtime/methods/resume.ts`、`tool/handlers/read.ts`、`adapters/mcp/index.ts` 的 max-lines 债务仍在，MCP 还有原未使用导入/spread 告警，未加 disable 或修改基线。
- Desktop main 独立工程原有类型失败未整体修复；用 TypeScript noEmit 前后对照确认本次没有新增错误（85 项变 83 项，两个差异仅为安全索引类型断言）。不能将“无新增错误”写成 Main 全量类型通过。
- Desktop Agent bundle 已构建并暂存，未重启运行中的应用、未打包发行、未发布或提交。
- 已独立复核权限、凭据脱敏和记忆回退；复核发现的 cached Read 与跨行脱敏回归都补正式测试并修复。清数据的稳定 helper/接线得到只读复核，最终截止时间/quit gate 因 reviewer 限流由主代理补测试、回查调用链和 Main noEmit 差异。
- 开始时的 32 个未提交修改/新增文件内容指纹仍一致，无二开文件删除或官方整文件覆盖。

### 未执行与限制

没有真实模型、Electron/手机端到端交互或无响应网络盘真机复现。清数据仅使用 fake 副作用；Host `exit(0)` 不能绝对证明 Windows 快照不可用时所有 Agent 后代均已核验，参见 `upstream-clear-data-quiescence.md`。本次不扩展成新进程树协议修复，不覆盖此前未确认的 Composer/Git 场景或官方新功能。
