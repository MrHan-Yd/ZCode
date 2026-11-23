# 子智能体历史目录与详情恢复

## 问题与范围

编排调度器直接调用 SubagentPort，父会话中不存在对应的 Agent / Task 工具 part。原历史查询只遍历这些工具 part：实时投影已显示「已结束 · N」，但 `session/subagents` 的 ended 清单为空；重新打开会话时，同一查询生成的冷恢复种子又清空 childSessionIds，导致目录入口消失、已打开的详情 tab 被当成无效引用回收。

本次恢复已有「智能体 → 已结束 → 子智能体目录 → 子会话详情」交互。不新增编排步骤上的详情按钮，不修改经典模式的输入或运行方式，不改数据库和 journal 结构。

关联规范：[编排模式](./orchestrator-mode.md)、[编排子代理工具行](./conversation-orchestration-subagent-row.md)、[状态面板子代理身份](./status-panel-subagent-identity.md)。

## 产品规则

1. 运行中和已结束的编排子代理均可出现在同一个子智能体目录。已结束包括成功、失败、取消和失联，不能因为终态隐藏查看入口。
2. 每个有效子会话只显示一次。目录保留任务标题、身份（记录存在时）、状态、结果摘要和时间；整行点击打开原有只读子会话详情，查看持久化的消息和工具记录。
3. 经典 Agent / Task 工具输出及后台 launch ACK 保持兼容。编排不要求父会话伪造 Agent / Task 工具 part。
4. 重新打开父会话后，已持久化的子代理历史仍可查看，不需要重跑编排或重新调用模型。
5. `childSessionIds`、running 和 ended 来自同一次查询、同一候选集合。V4 冷恢复种子使用这份清单；存在可查看历史时不能种入空清单，导致计数和详情 tab 丢失。

## 单一事实源与边界

- 运行期事实由 CLI SubagentSpawned / SubagentStopped 与 runtime projection 提供。
- 跨进程历史关系由父会话活动分支内已持久化的工具 part / 后台结果通知提供。通知复用 `parseZCodeBackgroundTaskNotificationText`，必须来自 canonical synthetic background_task 消息；单条通知校验 subagent 来源与 taskId / workId，批量校验代表项后逐条识别 Agent 通知，不能按首项 Bash / workflow 来源丢弃后续子代理，也不能把批量合成标题当成第一名子代理的标题。formatter 截断尾部时保留可核验的头部身份和终态，不能把缺闭合标签当成空历史。用户输入的任意 XML 不构成事实。
- 消息与工具记录仍由 SessionStorePort 保存。候选必须对应真实 `subagent_child`，parentID 必须等于正在查询的父会话；显式 workspaceID 必须一致。既有 child 构造曾未继承 identity，合法旧 child 的空 workspaceID 仅沿已校验 parentID 继承父身份，不能接受不一致的非空身份，不按相同文件路径匹配其它远端。新建 child 通过已有 runtime config 的 workspaceIdentity / workspacePath 继承父身份与展示路径；Memory 配置仅作为旧入口 identity fallback，不整体继承其执行行为。不在本次改写历史库。
- 候选归并键为 childSessionId。工具 part、事件和通知只补充同一子代理的缺失字段，不增加第二份可写状态或缓存。通知里的真实终态与结果不能被 launch ACK 的 completed 覆盖；同 child 被 SendMessage 续跑后，以最新 attempt / 子会话完成时间选取终态、摘要和结束时间，不能把旧失败摘要挂在新成功结果上。
- 分支 rewind / edit / retry 后，只读取活动分支消息。只有活动分支可证明归属的事件可补充无工具行候选，不能用旧事件复活已作废分支。
- 没有可核验引用、已经彻底删除的子会话、错误父会话或远端身份均不进入清单。存储读取异常继续由现有接口报错，不包装成空历史。
- 热路径和冷路径共用同一候选解析与目录投影；TUI 与协议调用不各自推导一套关系。

## 所有者与事件顺序

```text
运行时 SubagentPort
  ├─ SubagentSpawned / SubagentStopped（当前会话事件）
  └─ 后台结果通知（活动分支 message / part 持久化）
                 │
                 ▼
CLI 子代理候选解析（childSessionId 去重）
                 │
                 ▼
SessionStorePort 校验 child 类型、parentID、workspaceID
                 │
                 ▼
同一次目录投影：childSessionIds + running + ended
  ├─ Desktop continuous：实时投影 + session/subagents
  └─ Mobile replayable / 冷开：同一清单作为 V4 seed
                 │
                 ▼
既有目录整行点击 → 既有只读 SessionPane → 子会话持久历史
```

父会话的 owner / lease 与 gateway 的 snapshot、live buffer 顺序不变：历史查询在冷恢复种子发布前完成，随后补入查询期间的 live 尾部，避免清单覆盖新启动的子代理。目录分页和稳定排序不变；同 child 的重复通知和重复事件幂等归并。

## 验收与回归

- 父会话没有 Agent / Task 工具 part，只有编排 spawn / stop 事件：已结束数量、列表标题和 childSessionId 正确；目录仍可点开详情。
- 模拟进程重启、父事件为空，活动分支保存三条编排后台结果通知：`ended.total === 3`，完整 childSessionIds；成功、失败、取消均保持真实终态与摘要。
- 同时有工具 part、spawn / stop、完成通知：同 child 只显示一行，launch ACK 不覆盖完成结果。经典工具在子会话成功后写结果失败时，保留较晚的工具失败 / 取消、错误摘要及结束时间。
- 纯子代理和混合 Bash / workflow batch：只恢复真正子代理，各自标题正确，不包含拼接标题或追加的带引号失败原因。截断结果仍恢复头部完整的 child、标题和终态。
- 有身份父会话兼容真实 parentID 对应的旧空身份 child，拒绝错误非空身份；新 child 经真实构造 / 持久化验证显式身份与 Memory fallback 两条路径。
- 同 child 续跑、尚无新完成通知的热 / 冷查询：最新子会话终态、摘要和时间一致，不复用上轮失败原因。
- 同一父会话含运行中与已结束子代理：running、ended 与 manifest 计数一致，冷种子不把仍运行的 child 误算成已结束。
- 活动分支裁掉旧通知与旧工具：旧 child 不恢复。仅旧分支事件不得复活 child。
- 用户输入的任务通知、非 subagent 的后台通知、taskId 与 workId 不一致、缺失 child、非 subagent_child、错误 parentID / workspaceID 均被排除。
- child 最后一条 assistant 可读时保持只读最后一条的性能约束；旧 store 缺该能力仍回退全量消息，结果一致。
- 浏览器交互覆盖：点击「已结束 · 3」，目录显示三行，分别打开只读历史详情；切换目录/详情、刷新父投影后入口不消失。使用真实目录组件与原有 side-pane opener，隔离 fixture 不调用真实模型。
- 执行正式 Node 回归、根 `pnpm typecheck` / `pnpm lint`、CLI 类型与 Lint、架构检查；记录环境受限的完整 Electron / 手机远控验证范围。

## 验证结果（2026-11-23）

- `node --import tsx --test apps/zcode-cli/packages/core/test/orchestration*.test.ts apps/zcode-cli/packages/bootstrap/test/subagent*.test.ts`：152/152 通过；历史目录初始新增用例先复现空清单，再验证修复。
- `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json node --import tsx --test packages/ui/test/subagentHistoryDirectory.browser.test.ts`：6/6 场景通过（含父测试共 7 项）。使用真实目录、只读 SessionPane、原 opener/sync、workspace registry、AgentTransport 与物理分片帧，覆盖 desktop-continuous / web-remote-replayable、1366px / 390px、loading / error / recovery、页面重载和 same-sub resync。
- 根 `pnpm typecheck` 通过；根 `pnpm lint` 为 0 errors / 69 既有 warnings；CLI `pnpm exec turbo --cwd apps/zcode-cli run typecheck` 为 27/27，通过新测试的独立 tsc 门禁。
- CLI 包级 typecheck / lint 因本地 turbo 不可用而未启动；根 Turbo 替代运行后，CLI 全量 Lint 仍为 83 项存量 max-lines 错误 / 51 warnings。本次七个 CLI 文件定向 Lint 为 0 errors / 0 warnings，不把全量 Lint 写成通过。
- 架构检查为 0 violations；新解析模块不增加跨包实现导入，不改变状态所有者。临时 Vite、Chrome profile、fixture/cache 经 finally 清理。
- 桌面开发 Agent bundle 已重新构建并暂存，未重启当前运行的 Electron，未部署或更新安装发行版。真实 Electron、生产 Host、手机 relay 和 Safari / iOS 不在本次隔离验证覆盖内；不改写历史库、不重跑子代理。
