# 上游运行时权限修复（最小回移）

## 范围与证据

本次只修复当前源码可达、官方已修复的权限与子 Plan 缺陷，不合并官方版本或新增功能。

- 官方固定基线：`a4b4445141eb7d3b3e99eada9292775383bfc44e`（v4.0.0）。
- 官方前一版本：`a9fe401eede6e6e5e01be9048679c206fe6f02d9`（v3.17.2）。
- `git blame` 显示本组修复已经在 v3.17.2 引入；两版本间 diff 没有这些 hunk，并不表示不存在修复。用 `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1` → v3.17.2 的 diff 核验引入，禁止用 `FETCH_HEAD`。
- 调查起点本地 HEAD：`4a592368deb3fab37cd4ffab60f806d5791f7dc3`；已有编排活动、通知与协议等未提交改动必须保留。

| 已确认行为                                                                                         | 本地修前位置                                                                                              | 官方 v4.0.0 位置（修复 blame 为 v3.17.2）                    |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Plan 的只读分支忽略 `needsApproval`，非 destructive MCP 直接免审批                                 | `core/src/permission/service.ts:176–178,402–444`                                                          | 同文件 `214–233,514–565`                                     |
| 内置 Explore 默认 yolo，父 Plan 被 `childMode === "plan"` 清掉；工具面含 Bash，prompt 不是执行限制 | `core/src/runtime/methods/subagent.ts:177–188,253–258,495–509`；`core/src/subagent/explore-tools.ts:1–22` | `subagent.ts:226–235,639–667`                                |
| Explore 新建默认权限服务，丢失父配置与会话授权                                                     | `subagent.ts:337–340`                                                                                     | `subagent.ts:412–414`                                        |
| SendMessage 恢复 terminal child 时，历史 mode/执行 entry 覆盖本次父状态                            | `subagent.ts:392–396`；`resume.ts:194–217`；`subagent/runner.ts:936–1083`                                 | `subagent.ts:501–506`；`resume.ts:244–250`                   |
| 子 Plan 得到根规划流程，被要求递归派发 Explore 或以根审批工具收尾                                  | `runtime-reminders.ts:25–73,182–203`；`turn-loop.ts:132–143`                                              | `runtime-reminders.ts:81–92,278–325`；`turn-loop.ts:346–353` |

以上 `core/` 均指 `apps/zcode-cli/packages/core/`。审查也核验了实际工具注册、MCP capability、权限 executor 和 runner；缺少官方符号本身不构成缺陷证据。

## 产品规则

1. `mode` 与 `planEnabled` 是一个完整执行状态；Plan 在原权限模式之上收紧，不能把 build/edit 的需审批调用升级成免审批。
2. Plan 允许非 destructive 且无需审批的只读工具。需审批的只读工具（普通 WebFetch、readOnlyHint MCP）只通过 Plan 闸门，继续走原模式、项目规则和 URL 预批。
3. Plan 继续硬拒绝 native 非只读工具和 destructive 工具。保留上游现有 MCP 兼容例外：非只读、非 destructive MCP 在 build/edit + Plan 强制单次审批，不能用项目 allow 规则或“始终允许”跳过；yolo + Plan 的此类 MCP 仍按原 yolo 放行。不能将这条回移宣称为所有 MCP 的绝对只读沙箱。
4. 内置 Explore 不再固定 yolo，和其它 child 一样继承父权限服务与当前执行状态。Bash 只读性仍由现有 shell 语义解析器判定，不增加命令字符串特判、不删除 Bash。
5. 父 Plan 必须覆盖子 profile 的模式声明（包括保留但未实现的 auto）；保留已有 Plan + 编排 force 分支。子 profile 的 plan 仍能进一步收紧非 Plan 父会话；auto 在非 Plan 父会话下仍是原来的 fail-closed 行为。
6. 新建与恢复 child 使用同一份本次派发计算的 `{ mode, planEnabled }`。新增可选 `ResumeSessionOptions.executionStateOverride`，在历史 mode 与执行 entry 恢复之后最后应用；普通 root resume 不传入时保留原恢复优先级，`modeOverride` 的既有调用语义不变。
7. 子 Plan 提醒只包含只读约束与完成委派查询的要求；只有本轮实际可见 AskUserQuestion 才提示它。根会话的规划流程、审批与提醒频率不改。
8. 不改变任何工具面。实际 provider 回归确认所有 child 已由 `subagent/tool-policy.ts` 剔除 EnterPlanMode/ExitPlanMode，不能只看主 registry 宣称 child 有根审批工具；保持此现有过滤。Explore 与专业只读角色仍没有递归 Agent/Task；general-purpose 的 Bash/Read/Write/Edit 等执行工具继续保留。

## 所有者与事件顺序

- CLI runtime 的 `config` / `runtime/execution_state` entry 是执行状态事实；权限服务只裁决调用，broker 通过既有父会话交互路由等待决定。
- Host owner/lease、CLI CommandInbox admission、branch/run generation fence 与 OrchestrationRunStore 均保持原所有权和入口。
- 本次不新增状态、队列、缓存、跨进程消息或持久化版本；override 是调用级完整状态，不回写历史 entry。

```text
Desktop continuous / 手机 replayable
  → 既有 Host owner/lease 路由与鉴权
  → CLI CommandInbox 串行 admission（原幂等键 / 顺序不变）
  → 父 runtime 已应用的 mode + planEnabled
  → Agent 或既有 DAG dispatcher
  → 计算 child execution state（父 Plan 上限，profile 仅按现有声明解析）
       ├─ 新 child：构造器消费同一状态
       └─ 恢复 child：历史 mode → saved entry → 调用级完整 override
  → 子工具注册（allowlist / disallowlist / 禁递归 / CUA 验证不变）
  → 每次调用：硬工具边界 → 原 capability 解析 → PermissionService
       ├─ Plan 拒绝 → permission_denied，handler 不执行
       ├─ 可过 Plan 闸门 → 原 mode / deny / ask / 预批判定
       └─ ask → 既有 hook / broker 竞速 → 父会话决定 → handler 或拒绝
  → 原事件、持久化与投影（Desktop continuous / 手机 replayable 各自恢复语义不变）
```

子 Plan 提醒在每次模型请求边界由 `taskType === "subagent_child"` 与实际可见工具派生。当前本地压缩后仍回到同一个 turn-loop 收集入口，不恢复官方已不同的 compact helper。

## 必须保留的本地边界

- `orchestration: { enabled: false }`、`taskType: "subagent_child"`、`subagents.enabled: false`；本地没有独立 `agentRole` 配置字段，default 角色由这些边界保证，不新增第二事实源。
- 主编排 provider 隐藏名单与 executor 硬白名单、完整 registry 供可写子代理继承、团队实时派生及在飞 run 的冻结 `visibleProfiles`。
- workspacePath 用于执行/展示，workspaceIdentity 用于隔离；原 identity fallback、remoteSessionId、clientMode、deliveryKind 与 owner/lease 传递不删改。
- 模型 Selection 与 override 工厂、modelRequestAdmission、modelStreaming、父 instructions snapshot、MCP borrowed 生命周期/启动快照、官方 CUA provenance/禁用、childClientPorts、事件镜像和 session readiness 次序。
- runtime/orchestration entry、run journal、同 run 修订、选择性取消/写占位、generation fencing、队列提升与已有活动通知改动。
- alwaysAsk、会话授权、workflow owner 修订授权、项目 deny/ask、官方 CUA capability group、权限应答竞速与修改输入复核的现有优先级。

## 明确排除

- 不新增 guarded、Guarded 单次危险命令审批、official feature tags、on-demand workflow、Shell/语言公告或其它官方新能力。
- 本地 profile parser 只接受 auto/plan，不接受 bypassPermissions/dontAsk/acceptEdits；缺少官方 `permissionModeRestrictOnly` 不是当前可达的提权缺陷，不扩大 profile 支持面。
- builtin `js` capability 是非只读 `node_repl`，本地 Plan 已拒绝它。上游提到的 `node_repl/js` 免审批只适用于实际注册成 `permission: "mcp"` 的路径，不能混为一谈。
- 单独修 Explore 的权限服务并不足以修复默认 yolo；单独给 resume 传 mode 也会丢 Plan，必须成套回移完整执行状态。

## 验收与验证

正式回归放 `core/test/upstream*.test.ts`，使用现有 Node test + tsx。先执行修前红灯，再改最小生产 hunk；不在仓库放临时脚本或截图，临时目录均 finally 删除，命令/HTTP 副作用用端口记录而不触碰真实用户文件或网络。

- Plan：build/edit 中普通 WebFetch、readOnlyHint MCP 需审批；预批 URL/显式 allow 仍有效；非只读 MCP 强制单次审批并传到 broker；native Write/Bash/js 与 destructive MCP 仍拒绝；yolo 和 yolo+Plan 的上游兼容边界明确测试。
- Explore：父 build 下非只读 Bash 需审批、只读 Bash 可执行；父 Plan 下非只读 Bash 不执行；父权限 disallowedTools 生效；父 yolo 无 Plan 保持免审批。
- Child：经典与编排、新建与 terminal SendMessage 恢复、profile 缺省/plan/auto、build/edit/yolo + 父 Plan；既有编排 force 分支保持只读，工具完整性/禁递归/工作区身份不退化。
- Resume：saved yolo 不能覆盖本次 build；saved Plan false 不能覆盖父 Plan true；不传 override 时保留 root 恢复及 modeOverride；完整 override 最后应用，不改其它持久配置。
- Reminder：捕获真实模型请求，子 Plan 无根 Phase/递归 Explore/ExitPlanMode 收尾要求；按可见 AskUserQuestion 提示；根提醒及非 Plan 行为不变。
- 既有 `orchestrationRuntimePolicy.test.ts`、`orchestrationSubagentWorkspace.test.ts`、`orchestrationSubagentLaunchProfiles.test.ts`、编排调度/恢复/修订测试继续执行。

命令从仓库根执行：

```sh
node --import tsx --test apps/zcode-cli/packages/core/test/upstream*.test.ts
pnpm exec tsc -p apps/zcode-cli/packages/core/tsconfig.upstream-test.json
pnpm --filter @zcode/core typecheck
pnpm --dir apps/zcode-cli exec oxlint --no-ignore <本次源文件和正式测试>
pnpm architecture:check --changed
pnpm typecheck
pnpm lint
```

`tsconfig.upstream-test.json` 与 root/core 的 typecheck 接线由主代理统一维护；本次不编辑 package.json/tsconfig。真实结果、已有失败与未做的完整模型/Electron/手机 E2E 均在交付报告中区分。代码只改指定权限/子运行时/恢复/提醒及 resume 类型；不编辑其它代理正在修改的 context、rewind、read-state hydrator、tool/types 或已有未提交 agent-runtime 文件。
