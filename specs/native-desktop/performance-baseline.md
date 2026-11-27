# 原生版性能基线与同场景验收

## 当前证据状态

2026-11-27 只完成了源码调查、框架资料核实和准备规格。本轮没有启动原生应用，没有跑原版性能场景，没有采集可用于两版比较的干净基线。

- 用户的任务管理器截图约 1 GB，是问题线索，不包含进程角色、会话规模、启动条件或采样时间，不能据此认定泄漏。
- 讨论期间对已运行 ZCode 的采样受当前会话和调查工作影响，不是静置或同场景基线，不写入验收结果。
- MyGo 官网数字属于作者的 Mac 小应用测试，不是 Windows、ZCode、当前完整版组件或本轮实测。不得用它承诺“原生版只占几十 MB”。
- 框架固定开销、UI 工作集、Host/CLI、工具子进程、图像/字体/终端缓存和运行时数据分别统计；包体小不代表总运行内存小。

## 测量所有者与口径

```text
独立场景驱动器（合成数据、固定动作、计时起止）
  ├─ 原版发行构建 + 隔离数据根
  └─ 原生版发行构建 + 另一隔离数据根
                  │
                  ▼
应用进程树 / 角色采样（Main/UI/Host/CLI/调度器/工具）
  ├─ 系统口径：内存、CPU、句柄、线程、进程退出
  └─ 组件口径：UI/运行时堆、缓存字节、resident、事件与订阅
                  │
                  ▼
相同动作的正确性断言 + 同场景指标比较
```

1. Windows 首测使用进程树的 **Private Working Set** 总和，与任务管理器私有工作集口径核对；另外保留 **Private Bytes/Commit**。不能把含共享页的 Working Set 逐进程相加，冒充独占物理内存。
2. UI 单进程、后台和整个应用分别报数。即使保留 Node sidecar、外部浏览器或原生动态库，也计入功能所需的进程与内存，不能只报主窗口。
3. 不把 GPU 的专用/共享显存混进进程物理内存；需要时单列。Go heap、JS heap、native allocator 与 Private Working Set 不是同一口径。
4. Windows、macOS、Linux 分别建立基线，不跨 OS 把 RSS、活动监视器或 Private Working Set 视为等价数字。
5. 主场景用相同合成历史、文本、图片、终端输出、窗口数量和并发量，所有版本均为 release 构建；开发 watcher、调试器和额外调查子代理不参加正式对比。
6. 分别标识冷启动、热启动与历史恢复；明确首帧可见、输入可用、会话可操作的不同时间点。不能只记录窗口出现。
7. 每个场景至少五轮，交替运行两版本，记录硬件、系统、显示缩放、刷新率、版本/提交和工具链；报告中位数、范围、峰值及异常轮，不挑最快一次。
8. CPU 标明单核百分比或整机百分比、采样窗和绘制是否停止。响应指标记录输入到展示/提交完成的 P50/P95/P99，不把帧率或渲染函数耗时当作全部交互延迟。
9. 凭据、真实对话、内部地址和原版生产数据不进入 fixture、截图或日志。下载和原生插件需要另行固定版本、校验 hash 与许可。

## 必须建立的场景

所有场景均为 **planned / 未执行**。没有原生性能 runner；表中的步骤是验收设计，不是已有命令。

| 场景            | 设置与动作                                                                | 正确性前提                                                               | 指标                                                        |
| --------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- |
| 空壳 / 空闲     | 一窗口、无任务、无终端；展示后静置 60 秒                                  | 没有 watcher 或意外预热任务                                              | 首帧、输入可用、稳态进程树、CPU                             |
| 活跃工作区      | 一 workspace、一 session；固定短历史，发送一轮                            | 队列、权限和结束状态一致                                                 | 总内存、角色占用、首 token 展示、发送响应                   |
| 长聊天          | 合成 1,000 轮及 10,000 行工具/代码混合内容；上下滚动、查找、复制          | 全历史可访问，选区与滚动不丢；不能为省内存删历史                         | 文本/row/caches retained bytes、滚动 P95/P99、峰值          |
| 流式内容        | 固定分片节奏输出 Markdown、表格、代码；同时输入与选取旧文                 | IME 不误发送，选区不被覆盖，不跳到底                                     | 输入延迟、解析/排版、分配率、帧长尾                         |
| 多工作区 / 分屏 | 三 workspace、四 pane；切换、拖拽、关闭                                   | 身份和焦点正确；所有后台任务持续运行                                     | 每新增实例增量、keep-warm、连接和句柄数                     |
| 终端            | 两终端输出合成 10 MB；切换、折叠、关闭非最后/最后底部 tab 和侧栏 terminal | 折叠及最后底部 tab 关闭保活；其他关闭释放正确实例；自然退出按 scope 清理 | scrollback 字节、native/UI占用、PTY/句柄与退出              |
| 子代理 / 工作流 | 固定并行度，重复完成 50 个合成子任务，展开与收起结果                      | 保留可访问结果，不降低并行度或漏终态                                     | parent/child resident、registry/event bytes、峰值和回收斜率 |
| 大图 / 附件     | 打开合成图片与附件，切换、关闭和取消读取                                  | MIME/权限/引用正确，取消不继续读取                                       | 解码缓存、传输临时内存、峰值与关闭后变化                    |
| 设置与模型      | 切换 17 个分区、provider/model 配置及主题/字号，重复打开关闭              | 保存与本地/远端 scope 正确，主题同步无回环，Key 不进入采样               | 输入/切换 P95/P99、缓存字节、连接/订阅和关闭后变化          |
| 插件与能力      | 合成大目录，搜索、详情、配置、安装/启停/卸载，MCP 状态刷新                | hash/信任/来源与运行时能力保持一致，控制面不阻塞聊天                     | 目录/详情延迟、下载/解析峰值、控制面占用和释放              |
| 自动化与历史    | 大量合成 cron/offpeak/saved workflow，翻页/filter、手动运行与取消         | claim/计数/资格正确，不重复派发，不漏历史或产物                          | 查询/更新延迟、列表/journal工作集、scheduler角色占用        |
| 日志与辅助面    | 请求日志/归档/trajectory 分页、搜索/展开，白板绘制与文件树过滤            | 数据来源正确，清理/恢复有确认，选区和引用不丢                            | 分配/retained bytes、绘制/搜索长尾、关闭后残留              |
| 浏览器与文档    | 已批准的保真浏览器后端、PDF/Office/PPTX/图形，导航/选择/导出/关闭         | 阻断先放行，完整功能保持，不用截图或删交互顶替                           | 全后端总占用、解码/布局峰值、输入/滚动/导出与释放           |
| 远控重连        | 同一 attachment 断连恢复，并切 workspace                                  | 不新建业务 session；desktop/replayable 区分                              | 恢复延迟、buffer bytes、重复事件/输入数                     |
| 长时间运行      | 重复开关 pane、终端、session 100 次，并覆盖既有回收窗口                   | 无活跃任务误回收，历史仍可重建                                           | steady-state 斜率、resident与订阅、进程/句柄退出            |

明确未观察到回收不等于泄漏：先核实 eligibility、订阅与 lease，区分仍可达的必要状态、缓存高水位、分配器不立即归还内存和失效资源残留。不能用强制 GC、定时重启或缩短超时掩盖错误的所有权。

## 首批优化取证点

以下是当前源码的保留行为或边界，不是已确认泄漏，也不是本轮要实施的改动：

- `packages/ui/src/v4/ConversationTimeline.tsx` 已使用虚拟滚动；虚拟 DOM 不代表数据对象有界。
- `packages/ui/src/v4/conversationProjectionStore.ts` 的 `loadAllOlder` 为宽屏问题目录补拉完整分支并合并 projection；需分别测目录索引与正文保留。
- `packages/ui/src/v4/sessionDataLayer.ts` 引用归零后默认 keep-warm 30 秒；释放 UI 订阅不等于停止 CLI session。
- `packages/ui/src/lib/shikiHighlighter.ts` 已是 singleton 并限制 token cache 为 128 项；仍需按字节核对大代码块。
- `packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts` 与 `packages/ui/src/Terminal.tsx` 有意保活隐藏终端。侧栏 terminal 和非最后底部 tab 关闭会释放对应实例；最后底部 tab 关闭只收起面板并保活，不能把这类关闭也当作释放样本。
- `packages/services/src/zcode-agent/zcodeAgentService.ts` 的控制面进程有不同 idle 策略；`zcodeAgentProcessManager.ts` 按 workspace key 复用进程。先识别角色，不能把全部 CLI 当作一人一个子代理。
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-resident-pool.ts` 已有 resident 回收条件；16 是高水位，不是会强杀 running/lease 的硬上限。
- `packages/shared/src/zcode-protocol-v4/core.ts` 已限制 snapshot 尾窗、subscriber buffer 和 replay 条数；条数上限不等于累计 payload 字节上限。
- `apps/zcode-cli/packages/core/src/runtime/methods/subagent.ts` 与 `contracts/src/events/in-memory-session-event-store.ts` 的结果/事件保留需要验证终态后数量与字节变化；单看 publisher 清理不能判断全部数据已释放。

## 放行规则

- 初次性能数字只能标为实测结果，不叫目标已达成；测量脚本、场景和样本定义需可复现。
- 第一轮同场景结果建立后再固定数值预算。当前不承诺 44 MB、固定节省百分比或跨平台“最佳性能”。
- 交互/业务断言先通过，再比较性能。高风险交互出现回归，即使内存下降也不放行。
- “优化后的原生版”对外发布前，至少证明关键实际场景总内存下降，输入、滚动、发送与恢复长尾不退化，并完成回收/进程退出验证。
- 只有 UI 变原生且后台仍不变时，报告应明确是 UI 迁移阶段，不宣称全栈原生化。

## 外部资料

- [MyGo 官方基准](https://mygo.run/zh/benchmarks)：框架小应用、Mac 环境，不能代替本项目结果。
- [MyGo v0.10.0 原生 UI 文档](https://github.com/egoist/mygo/blob/v0.10.0/docs/ui/README.md)。
- [MyGo v0.10.0 终端文档](https://github.com/egoist/mygo/blob/v0.10.0/docs/plugins/terminal.md)：有独立 native library 与 scrollback 成本，需计入。
