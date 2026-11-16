# 设置：模型请求日志

## 产品规则与范围

1. 设置的「数据与统计」分组新增独立的「请求日志」入口，不替换现有使用统计。页面提供「请求日志」「供应商」「模型」三个视图，计数来自相同筛选条件下的完整数据库结果，不只统计当前页。
2. 请求明细按模型调用记录展示：时间、模型、供应商、新增输入、输出、缓存命中（含命中率）、速度、首字、总耗时、状态。模型与供应商合并在同一格（模型一行、供应商名称在下），缓存命中与命中率合并在同一格，避免横向滚动。调用来源与成本不展示，也不参与筛选；协议仍保留 `querySource` / `costUsd` 字段供其它消费者使用。
3. 一条日志对应既有 `model_usage.id` 的一次模型调用事实，不伪装成逐 HTTP 尝试日志；请求内部的重试通过 `retryCount` 表示。普通对话、子智能体及走既有 `recordModelUsageFact` 的辅助调用都包含在内。未进入该记录链路的连接探测不凭空生成历史日志。
4. 供应商视图按 `providerId` 分组；模型视图按 `(providerId, modelId)` 分组，不能把不同供应商的同名模型合并。列为名称、请求数、Tokens、成功率、速度、首字（不展示成本）。默认请求明细按时间倒序，分组按请求数倒序；分组请求数支持切换升降序。
5. 提供今日 / 最近 7 天 / 最近 30 天、状态（全部 / 成功 / 失败 / 已取消 / 进行中）筛选、刷新和上一页/下一页。**默认时间范围为今日**，默认状态为全部。更换视图、时间或状态重置页码。每页默认 **20** 条（避免长列表滚到底才能翻页），协议只允许 1..100 条，页码上限 100000；分页控件固定在表格上方的工具条内，不放在表格底部。工具条固定为两行：第一行是页签 + 时间/状态/刷新，第二行只放分页并右对齐；行数、行高不随总数/页数位数、文案语言或窗口宽度变化，首帧未拿到总数时也保留分页行的占位高度，表格起始位置因此保持稳定。不把完整请求历史下发给 UI，也不引入无限列表缓存。
6. 沿用现有用量表 30 天滚动保留期；不新增日志清理、导出、原始请求/响应查看或自动刷新。正在执行但尚未落库的模型调用在结束后可见；进行中筛选仅展示持久层已有的进行中事实。
7. 空数据、初次加载、刷新中、查询错误分别展示；错误有重试入口，不能把查询失败伪装成「暂无数据」。旧端缺少新方法时显示不可用错误，不回退到其它 Host 或本地数据，不影响其它设置。切换视图/筛选/翻页时，标签计数与分页栏保留上一次成功结果并置灰，不能退回占位符「—」，否则整行宽度跳动；表格区域保留最小高度，加载态不塌陷。
8. 时间/状态筛选、翻页与刷新采用 stale-while-revalidate：新响应到达前继续展示上一次成功结果（同一目标环境且同一视图）并置灰，表格不卸载、不回退到「加载中」占位，避免整块内容消失又出现造成的闪屏和页面滚动条抖动。视图切换改变列结构，不复用旧快照；目标环境（workspace/service/时区）变化时不复用它机数据，按初次加载处理。换筛选后的查询失败时清空旧筛选的行（错误提示与重试照常展示），只有同一查询的刷新失败才保留已有结果。时间与状态下拉触发器的宽度不随选中项文字变化，避免工具条横向跳动。

## 指标口径

- **Tokens**：总量取 `providerTotalTokens ?? computedTotalTokens` 的既有持久层口径。AI SDK v6 的 `inputTokens` 已包含缓存读写；输入列的历史记录按现有 `inputSideTokensFromStoredUsage` 的判别规则归一化，不能再次叠加缓存。不变更现有 App Usage / Task Usage 的统计口径。
- **新增输入**：本次请求归一化总输入减去缓存读取，最小为 0；这是「未命中缓存的输入」，不是跨轮上下文增量。缓存写入仍属于新增输入。
- **缓存命中率**：缓存读取 / 归一化总输入；输入为 0 时未知（`null`），显示「—」。
- **速度**：仅成功且输出和时间计量完整、`durationMs > timeToFirstTokenMs` 的请求参与；输出 Tokens / (总耗时 - 首字延迟)。分组采用同一批请求的输出之和 / 生成时长之和，不平均单行速率，不用总耗时代替生成时长。
- **首字**：优先取首个文本/思考增量的事件时间。没有正文增量时（典型是纯工具调用响应）回填 provider 里程碑：`model_request_completed` 事件携带本次尝试的 `durationMs` 与 `timeToFirstContentMs`，以 `事件时间 − durationMs + timeToFirstContentMs` 还原首个内容时刻；`timeToFirstContentMs` 已包含工具参数增量，不受 core 工具参数缓冲影响。里程碑缺失或超出该次尝试耗时（非流式旧配置）时保持未知，显示「—」。分组对成功且有计量的请求取算术平均；失败、取消和缺失计量不污染平均值。禁止把 `tool_input_delta` / `tool_call` 事件直接当作首字：它们会被缓冲到换行、4096 字符或结束时才落事件，首字会退化到接近总耗时。
- **成功率**：成功记录数 / 全部记录数；失败和取消不是成功。计数仍按调用记录而非网络尝试。
- **成本**：当前版本不展示成本列。持久层继续按原口径保存可空 USD 费用（`cost_usd`，只在能确认币种时写入），协议继续返回 `costUsd` / `costKnownCount`；UI 不渲染，也不按模型名猜定价。后续若要恢复展示，只需加回列，不需要改写入或查询。
- **状态码**：保存错误网络事件实际携带的 HTTP 状态码到可空 `http_status`；成功状态不伪造 200，失败但无 HTTP 响应不伪造状态码。UI 主筛选以调用结果状态为准，有真实状态码时附带显示。
- **供应商名称**：分组键与明细键始终是持久层的 `providerId`，不改变统计。UI 只做显示投影：用当前目标环境的 Provider Settings 视图把 `providerId` 映射为 `providerName`；设置未就绪、查询失败或找不到该 ID 时回退显示原始 ID，不阻塞日志渲染，也不新增服务端字段。
- 不向页面返回 prompt、响应正文、原始 usage/metadata、headers、API Key、完整错误消息或内部地址。

## 唯一所有者、边界与事件顺序

- 写入所有者：CLI runtime 的 `recordModelUsageFact`，继续调用 `UsageStorePort.recordModelUsage`，按既有 `id` 幂等写入。仅在现有事实记录上添加可空成本/HTTP 状态码，不新增记录器、队列或进程级缓存。
- 持久层：CLI SQLite `model_usage`。迁移添加 nullable 列，旧数据保留、旧调用不传新增字段时仍可写；保留现有清理和会话删除语义。
- 查询：`UsageStorePort.queryModelRequestLogs` 经 SQLite adapter 做分页和全范围聚合。独立只读 repository，不由 renderer 聚合已加载页。
- 公开接口：`@zcode/shared` 的请求、记录、分组与快照 schema；`IUsageStatsService.getModelRequestLogs` 经 `IZCodeAgentService.getModelRequestLogs` 和 `v4/usage/requestLogs` 到同一 CLI Store。
- UI：独立 `useModelRequestLogs` hook 访问当前 ServiceProvider 的 `usageStatsService`；组件只持有筛选/视图/页码和只读显示快照。请求版本 guard 保证切换视图、筛选、workspace/service 或卸载后旧响应不覆盖新页面。
- Desktop 与 Web 共用设置组件和服务契约。手机通过现有 attachment / RPC 读取已有 Host，不新建 Agent、Local Host 或远端会话。本次是只读请求/响应，不修改 `desktop-continuous` 与 `web-remote-replayable` 的流式、恢复和 owner/lease 语义。
- 全应用数据范围是当前 Host 环境。服务参数可携带 `workspacePath`、`workspaceIdentity`、`remoteSessionId`，路由参数不进入 CLI 查询载荷。远端必须精确选中已有 workspace client（existing-only），不能回落本地；无显式目标时仅复用未 disposed 的本地 client，排除远端 attachment。UI 用既有 workspace resolver 注入目标服务并传递远端身份，不从一个 Host 聚合另一 Host 的私有数据库。
- 既有表把缺失输出 Tokens 存为 0，无法事后区分真实零输出；完整有效计时配合零输出沿用既有 0 TPS 口径，不回填历史输出。费用目前只识别原始 usage 中明确的 `cost_usd` 或 `cost` + `currency: USD`，普通未上报费用的供应商显示「—」。

```text
模型调用结束
  └─ CLI recordModelUsageFact（唯一写入者，固定请求模型快照）
       └─ UsageStorePort.recordModelUsage(id 幂等)
            └─ SQLite model_usage（30 天保留）

设置筛选 / 翻页 / 刷新
  └─ useModelRequestLogs（版本隔离，最多持有一页）
       └─ IUsageStatsService.getModelRequestLogs
            └─ 当前环境 IZCodeAgentService / 已有 attachment
                 └─ v4/usage/requestLogs（严格校验）
                      └─ UsageStorePort.queryModelRequestLogs
                           └─ SQLite 分页 + 同条件完整计数/分组
                                └─ 只读快照；旧版本响应丢弃
```

## 代表性验收与测试

1. **数据库/协议**：含成功、失败、取消、同时间不同 ID、同名模型不同供应商的 fixture；明细稳定时间/ID 排序，分页不超限，所有计数和分组来自全部匹配行。
2. **过滤**：今日按调用端时区解释，7/30 天沿用滚动窗口；范围上下界、状态筛选与分页一致；非法状态、页大小、页码、未知字段被严格 schema 拒绝。
3. **指标**：总输入含缓存的 v6 记录与旧版分离缓存记录都不重复累计；缓存写入属于新增输入；失败/取消不参与速度/首字；无计量显示未知；分组速度采用加权口径。
4. **费用/状态**：已知零成本仍显示 0；未知成本显示「—」；分组部分已知标记准确；迁移后历史行为空且既有写入成功；实际错误状态码保留，不暴露 headers/body/errorMessage。
5. **写入**：主会话/子智能体/工作流/辅助生成沿用同一 `recordModelUsageFact`；固定模型快照不受运行中切模影响；同 ID 重入不增加请求数。
6. **服务**：只读请求完整转发给当前 Agent；无活动 client 或旧端方法缺失明确失败，不落本地 fallback。
7. **UI/E2E**：打开设置入口→三视图切换→日期/状态筛选→分页→排序→刷新→空态/错误重试；中英文、浅色/深色及手机宽度可操作，表格横向滚动限定在容器内。
8. **异步**：延迟旧请求，在新筛选/视图返回后再完成，旧响应不能覆盖新结果；卸载不写入状态。
9. 验证以当前包实际命令为准，正式新增测试纳入类型检查；必须执行根目录 `pnpm typecheck`、`pnpm lint`、架构检查。浏览器基础设施不齐时如实记录缺口，不能将静态审阅称为 E2E 通过。

## 已执行验证（2026-11-16）

- 请求日志与相关统计回归共 43 项通过：包含共享 schema、服务身份转发、SQLite 分页/分组/迁移、CLI 事实写入、今日/DST 边界、UI 导航/格式/查询状态和陈旧响应隔离。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过；根 Lint 保留 70 条既有警告，架构零 baseline / 零新增违规。
- CLI contracts / adapters / core / bootstrap 独立编译与类型检查通过。CLI 修改文件定向 Lint 通过，保留 `runner-normalization.ts` 一条既有 spread 警告。
- Chromium 浏览器实际渲染 `RequestLogsPanel`，用隔离的模拟服务验证三视图、计数、日期/状态筛选、分页、排序、刷新、错误重试、空态、等待连接门禁、旧服务响应隔离、中英文、深色主题、390px 窄屏滚动和键盘下拉交互；通过。没有使用真实 API Key、生产数据或向外部模型发请求。
- 浏览器验证是组件交互，不等同于打包桌面、真实 SSH Host 或手机 attachment 的全链路 E2E；这些运行环境未实测。
- 浏览器脚本、fixture、截图及缓存均置于系统临时目录并已删除。仓库只保留正式源码、测试和规范。
- 2026-11-16 版式收敛复验：设置页宽度下明细表无横向滚动；应用/来源列已移除；模型与供应商同格、缓存与命中率同格；供应商显示 Provider Settings 名称；默认 20 行；翻页控件位于表格上方。同时重新构建 `apps/zcode-cli/packages/cli/dist/zcode.cjs`，确认包内包含 `v4/usage/requestLogs`。
- 2026-11-16 首字回填：`recordModelUsageFact` 在无文本/思考增量时用 `model_request_completed.timeToFirstContentMs` 回填首字（`core/src/runtime/methods/model-usage-timing.ts`）。5 项记账测试覆盖里程碑回填、事件优先、非法/超出耗时保持未知；核心包与 Agent 包重新编译，包内确认包含 `firstProviderContentAt`。历史行按约定不回填；非流式旧配置路径仍为未知。
- 2026-11-16 工具条固定两行：页签 + 筛选在第一行，分页单独一行右对齐（首帧未拿到总数也保留 `h-7` 占位）。Chromium 实测 817px 内容宽度下，总数 3 条/1 页与 32342 条/1618 页两种情况下表格顶部都在 135px、筛选控件与页签同排（`top` 60/58），页面无横向滚动；英文在同等宽度下同样单行、表格顶部 153px 不变。唯一例外是窗口约 1024–1050px（内容约 677px）加英文时筛选行会折行，与数据量无关。
- 2026-11-16 默认今日与切换不闪屏：`initialModelRequestLogsQuery.range` 改为 `today`；`useModelRequestLogs` 在同一目标环境、同一视图内保留上一次成功快照直到新响应到达，加载中表格继续渲染并置灰（`opacity-60`），不再卸载成「加载中…」占位。Chromium 实际渲染 `RequestLogsPanel`（隔离模拟服务，响应延迟 1.5s）：首帧请求 `range=today`、下拉显示「今日」；切换状态与时间时表格节点始终存在、行数保持、页面高度不变、无「加载中」文案；两个下拉在「今日 / 最近 7 天 / 最近 30 天」与「Today / Last 30 days / All statuses」下宽度恒为 128px，工具条不横向跳动。失败路径同样实测：换筛选后失败清空旧行并显示错误提示，同一查询刷新失败保留已有行；错误重试后恢复。harness 与截图置于临时目录并已删除。UI lib 测试 10 项通过（新增默认今日与快照复用判定）。

## 非目标

新增模型价格配置或外部价格同步、记录 prompt/响应正文、修改计费或现有用量统计、跨 Host 汇总、日志导出/删除、连接探测历史、原始 HTTP 重试逐条事件日志、全局 UI 改版。
