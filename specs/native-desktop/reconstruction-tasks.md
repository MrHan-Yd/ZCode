# ZCode 原生重构任务书：完整功能与交互还原

## 1. 文档性质与完成目标

- 日期：2026-11-27。
- 原版参考：ZCode 4.1.3，`f78689fd243dc02be37e38d6b34afa2137bdb4ac`。
- 工作分支：`native/mygo`，当前目录 `F:/Han/demo/test01/ZCode`。
- 原版：`main`，独立目录 `F:/Han/demo/test01/ZCode-classic`；不改原版源码、分支引用、版本或发行流程。
- 目标技术：MyGo / Go 原生 UI，工作台不使用 WebView，不用 HTML/React 页面包装成原生版。
- 本文是重构任务与验收合同，**不是实现完成报告**。目前没有 Go 模块、MyGo 窗口、原生测试或原生安装包。
- 当前工作只写文档；任务中的模块结构、适配器、测试和命令均为待建立项，不能据此宣称仓库已经提供。

**完整还原是硬目标，不是“核心功能能用即可”。**阶段交付可以不完整，但最终完整替代版必须覆盖所有当前可达功能、交互、异常分支、权限、持久化、恢复和平台行为。不能因为框架没有现成组件就删除功能、换操作方式或把真实交互降为截图。

配套合同：[双轨规格](README.md)、[交互验收](interaction-parity.md)、[性能验收](performance-baseline.md)、[原生应用入口](../../apps/zcode-native/README.md)。本任务书是执行总入口；若与配套清单冲突，以当前源码核实产品语义并同步修订，不能选对实现最省事的表述。

### 1.1 “还原”包含六个层面

1. **入口和设计**：原来的功能放在原来的产品位置，保留信息密度、主题、字号、间距、图标、菜单顺序、可见条件和空态。不默认套用 MyGo 主题。
2. **鼠标和键盘**：点击、双击、右键、拖拽、选区、焦点、快捷键、输入法、复制粘贴、滚动与缩放保持原有含义。
3. **业务结果**：相同输入和操作产生相同的会话、工具、权限、队列、计划、文件/Git 副作用，而不是只画出相同状态。
4. **生命周期**：切工作区、隐藏面板、关闭标签、重连、运行时换代、应用退出分别保留原语义，不为省资源误停任务。
5. **数据和兼容**：保留身份隔离、持久化来源、配置继承、历史可访问性、幂等、错误和恢复规则。
6. **跨平台与性能**：Windows 优先验证，macOS/Linux 分别放行；不能用删功能、减少并发或不计侧车来证明更省内存。

字体栅格化等平台差异需要基于同平台基线设定合理视觉容差，不承诺跨 OS 每个像素相同；布局、可读性、命中区域、交互和业务结果不能以此为由放宽。

### 1.2 范围内与范围外

**范围内**：本任务书列出的当前功能全集；原生客户端/宿主适配；原有 Node 业务的兼容复用；后续有证据的生命周期优化；双版本独立分发和数据策略。

**不能自行开展**：在 `main` 实现；删除原产品；全盘重写模型/插件/工作流引擎；修改远端协议；覆盖生产数据库；自动分享、上传或发版；恢复当前已移除的模块；全局升级 Go；把完整还原改成精简版。

复用现有 Agent 业务是第一阶段降低行为偏差的策略，不等于最终禁止后台原生化，也不等于后台迁移已被批准。进一步 Go 化要在等价实现和性能证据齐备后另写实现规格。

## 2. 必须先解决的阻断项

阻断不等于删除范围。所有功能继续在验收账本中，未解决不能把原生版标为完整替代版。

| 编号 | 问题                                                                        | 当前处理                                                                                         | 放行所需证据                                                                            |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| B01  | 任意网页、DOM 选取和 CDP 依赖真实浏览器；与“整个应用完全没有浏览器引擎”冲突 | 不默认外置浏览器、不用截图流顶替、不删除浏览器任务；先固定“不用 WebView”的精确边界并研究保真后端 | 用户明确技术边界；同页导航、选择、Agent 控制、Cookie、弹窗、截图/录制、关闭恢复均可验收 |
| B02  | PDF、DOCX/DOC、Excel、PPTX 当前使用浏览器/JS/WASM 排版                      | 建立原生格式引擎资格验证，不能把简单文本抽取或转图当作完整预览                                   | 当前格式样本的排版、导航、选择/链接及已有导出/引用行为等价；native 依赖与许可明确       |
| B03  | Mermaid、公式与特殊富内容没有证实的原生等价渲染                             | MyGo 扩展接口仅作接入点，不当成已有渲染器                                                        | 当前语法、错误态、主题、选择/复制与预览行为逐项验证                                     |
| B04  | MyGo v0.10.0 要求 Go 1.27.3，本机为 1.26.4                                  | 仅记录前置条件；之后为原生项目固定独立工具链                                                     | 不影响原版工具链，能在干净机器重现构建；不以 `@latest` 作为发行依赖                     |
| B05  | 原版与原生版共存、历史读取/导入与外部深链接路由尚未确定                     | 实验数据隔离；禁止两版直接并发写同一数据库                                                       | 独立身份、启动路径、更新、凭据和历史兼容规格；失败可回滚，无生产数据自动迁移            |
| B06  | 原生输入法、富文本、终端和平台组件仅有官方资料                              | 不把框架示例、文档或基准称为本项目实测                                                           | Windows 真实 IME/ConPTY/拖放/剪贴板证据，macOS/Linux 各自验证                           |
| B07  | 框架和兼容桥的长期维护边界未固化                                            | 固定版本、保留许可，新增 Go 模块纳入架构与测试                                                   | 干净构建、可重复验证、版本升级回归和公开接口维护策略                                    |

B01 的事实来源：[UnifiedBrowserView](../../packages/ui/src/browser-use/UnifiedBrowserView.tsx)；B02 的入口：[PreviewPaneContent](../../packages/ui/src/previewPaneContent.tsx)；B03 的入口：[MermaidBlock](../../packages/ui/src/components/ai-elements/mermaid-block.tsx)。完整还原不能通过把阻断项标成“可选”获得。

## 3. 重构与保留的架构分界

### 3.1 哪些必须重做

| 现有层                                                                           | 原生版工作                                                         | 必须保留的语义                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------- |
| React/DOM、Tailwind、Radix、Lexical、虚拟列表、拖拽与图形组件                    | MyGo 原生组件、设计 token、编辑器、选择/焦点、绘制和虚拟化全部重建 | 设计、命中、快捷键、选区、滚动、异常和可访问性    |
| Electron Main、BrowserWindow、preload/contextBridge、utilityProcess、MessagePort | 原生窗口/OS/进程与本机传输适配                                     | 每窗口 Host、可信 scope、退出顺序、错误与安全边界 |
| Electron 浏览器 guest/debugger、媒体和打印实现                                   | 独立格式/浏览器后端方案，受 B01–B03 约束                           | 页面、文档、引用、截图/导出和权限结果             |
| Electron 打包/更新与应用身份                                                     | 原生独立分发路径                                                   | 双版本不覆盖，可信更新、回滚、平台资源完整        |

### 3.2 第一阶段复用什么

| 现有层                                             | 处理                                                         | 禁止做法                                                           |
| -------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `packages/shared` 的协议、类型、纯规则             | 作为跨语言合同来源；建立校验和 golden vectors                | 手写宽松 Go map，另造版本/身份格式                                 |
| `packages/services`、RPC、client、server、远端连接 | 优先通过公开端口与兼容 Node 进程复用；替换 Electron 平台依赖 | UI 直连 Repo；误当普通 JSON-RPC；跳过服务权限                      |
| CLI/Agent、CommandInbox、工具、权限、插件与工作流  | 保留业务 owner 和执行语义，适配原生展示和宿主端口            | 新建第二条 accepted queue；把脚本翻成 Go 后移除 sandbox/capability |
| `packages/web` 与手机 remote                       | 保持现有 Web UI和恢复链路，连接原生宿主已有 attachment       | 为手机另起 Host、Agent 或远程业务会话                              |
| 现有测试、设计与规格                               | 保留作行为证据；另加原生测试与跨语言对账                     | 把 React 测试通过当作 MyGo 通过；删除基线回归                      |

### 3.3 目标模块布局（提案，尚未创建）

```text
apps/zcode-native/
  cmd/zcode-native/             应用入口
  internal/app/                生命周期与窗口协调，不拥有会话业务
  internal/platform/           Windows/macOS/Linux、系统原生能力
  internal/ports/              平台、服务、传输公开接口
  internal/transport/          兼容桥、连接、取消、认证与顺序
  internal/protocol/           合同生成/解码/验证，不放业务 IO
  internal/projection/         会话只读投影、pending 对账
  internal/workbench/          workspace、pane、group、tab、焦点、布局
  internal/composer/           草稿、引用、附件与提交意图
  internal/features/           按任务域隔离的原生用户面
  internal/design/             token、基础控件与交互规范
  internal/content/            Markdown/代码/文档/媒体渲染端口
  internal/persistence/        仅原生客户端自己的布局/草稿配置
  testdata/                    合成与受许可 fixture
  原生测试与构建入口           在实现时实际建立并纳管
```

Node 兼容桥的包位置与构建纳管由 ND04 固定，不能为了方便从 Go 直接引用 TypeScript 内部实现。新增 Go 源文件、正式测试、第三方 native 库分别纳入类型/构建、架构和许可检查。

### 3.4 唯一所有者及事件顺序

```text
原生窗口/OS：窗口、菜单、输入、显示与进程监管
   │
   ▼
原生工作台：草稿 / 引用 / 布局 / 焦点 / 选区
   │ 构造命令并冻结 workspace + session + commandId
   ▼
原生传输适配：严格校验、取消、分片、ACK 前通知屏障
   │
   ▼
窗口级 Host：attachment、可信 scope、owner/lease、跨 Host 路由
   │
   ▼
CLI CommandInbox：admission、幂等、accepted queue
   │
   ▼
Agent/服务：执行、权限、持久化、工具与工作流
   │
   └─ 权威事件 → snapshot/delta → 原生只读投影 → UI 对账
```

- 原生客户端只拥有未提交草稿与 pending overlay；accepted 输入/队列归 CLI，任务/会话不归窗口主循环。
- 同一窗口本地 workspace 共享窗口级 Host 边界；远端连接在该窗口注册，不建立额外 Desktop Remote Host。
- identity key 为 `workspaceIdentity?.trim() || workspacePath`；路径只用于 cwd、文件、Git 和展示。`remoteSessionId` 贯穿请求与恢复。
- V4 物理 wire 版本是 3，snapshot 版本是 1；RPC socket 编码是另一协议，不能与 V4 混成一套 JSON。
- `desktop-continuous` 与 `web-remote-replayable` 由可信宿主上下文决定；客户端不能自行降级配置以简化实现。
- 连接关闭、视图隐藏、session 停止、数据库关闭和进程退出分别建模；过期 command、frame、run 回报不可写新 scope。
- 时间戳按当前 CLI 合同处理；性能计时独立使用本机单调时钟，不用本机墙钟直接减 CLI 时间戳。

## 4. 任务总表与依赖顺序

所有 ND 任务当前均为 **未开始**，状态由原生实现证据更新；本任务书完成不等于这些任务完成。任务可并行的前提是独立 owner、稳定端口、正式 fixture 和无重复状态。

| 阶段                      | 任务      | 交付门槛                                                                                                             |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| P0 资格与合同             | ND00–ND06 | 基线账本、阻断处理、独立工具链、设计与传输合同、数据隔离                                                             |
| P1 原生宿主、工作台与聊天 | ND07–ND20 | 先打通一个真实 session 的创建/发送/审批/排队/停止/重连，再完成草稿、输入、历史、分享、侧聊与状态；不可只显示静态消息 |
| P2 专业内容与工作流       | ND21–ND30 | 文件/Git/终端、全部预览、浏览器及编排/工作流执行与详情，依赖已放行的内容引擎                                         |
| P3 设置、自动化与辅助面   | ND31–ND43 | 17个设置分区、引导/账户、自动化/闲时、Bots、导入、反馈与辅助视图                                                     |
| P4 全面恢复和优化         | ND44–ND48 | 远端/手机/崩溃恢复、日志安全、真实交互矩阵与同场景性能                                                               |
| P5 双轨发行               | ND49      | 全部功能账本放行、独立产物/身份/更新、数据兼容与回滚                                                                 |

P3 中受 B01–B03 阻断的内容，必须早在 P0/P1 做资格试验，不能拖到 UI 全写完后才发现不可实现。阶段顺序是集成顺序，不是推迟验证重大风险的理由。

每项执行前补目标模块 spec、场景和测试；之后实现并实际验证。任何任务的公共完成条件见第 8 节。

## 5. 详细重构任务

### ND00 基线冻结、功能与交互账本

**依赖：**无。**归属：**规格与验证。

- 对基线的入口注册、侧栏/菜单/快捷键、平台显隐和协议命令建立可追踪账本：入口、动作、参数、owner、结果、异常、持久化、清理、测试层级。
- 本文是当前可达功能的总范围；实现前逐项补读 callback/handler/fixture，不能把一次扫文件当作所有分支审计完成。
- 账本区分已实现、仅框架支持、缺原生证据、阻断、当前隐藏/不可用，不允许用“主要功能完成”覆盖遗漏。
- 接收新主线基线时记录新增/删除/行为变化并更新账本，保留原生分支的本地工作，不自动合并 `main`。
- **验收：**所有导航、命令、side-pane 类型、设置与条件入口都能映射到本文任务及正式场景；遗漏是失败，不是默认不支持。
- **证据：**[App](../../packages/ui/src/App.tsx)、[Settings 注册](../../packages/ui/src/settings/settingsPageConfig.ts)、[Side Pane 合同](../../packages/ui/src/lib/workspaceSidePane.ts)、[Command 合同](../../packages/shared/src/zcode-protocol-v4/command.ts)。

### ND01 MyGo 与原生能力资格验证

**依赖：**ND00。**归属：**平台与内容。B01–B04、B06–B07 是本任务要研究和验证的开放问题，不是启动前必须已解决的依赖；B05 的产品与数据方案由 ND06 负责。

- 固定 MyGo 版本、独立 Go 工具链和第三方来源；本机版本不足时不用静默降级依赖。
- 建立真实 Windows 原生试验：中文 IME 选词/取消/焦点切换、引用标签、跨段选区、流式增长、可变行高虚拟列表、DPI、系统剪贴板/拖放、Ghostty/ConPTY。
- 同时验证文档、Mermaid/公式、浏览器后端的保真路径；没有等价方案则保持阻断，不启动大量 UI 翻译。
- MyGo 原生窗口、渲染、数据线程和平台回调的 ownership 在此固定；不得阻塞 UI 线程等待网络/磁盘/模型。
- **验收：**每项有可重复正式 fixture、原生事件、业务/生命周期断言；官网能力和小程序基准不能放行。
- **证据：**[工具链记录](../../apps/zcode-native/README.md)、MyGo 固定版本官方文档。

### ND02 应用模块、构建和架构纳管

**依赖：**ND01。**归属：**基础设施。

- 在 `apps/zcode-native/` 建立独立 Go module、应用入口、正式测试和资源；新增启动/构建命令不得覆盖 `pnpm dev:desktop`。
- 明确第 3.3 节模块的依赖方向和公开端口；协议包只放合同/纯函数，UI 不直接依赖 Repo或具体 Runtime。
- 将 Go 模块和兼容桥纳入现有架构策略，补 Go 侧构建、静态检查和边界检查；TypeScript 门禁不能代替。
- 明确编译产物、生成合同、测试 fixture与临时数据位置；一次性脚本放系统临时目录并清理。
- **验收：**干净机器从固定版本构建，正式测试可执行，跨包边界受控，原版入口/根工具链未被改写。
- **证据：**[AGENTS](../../AGENTS.md)、[根脚本](../../package.json)、[mise](../../mise.toml)。

### ND03 设计体系、基础控件与可访问性

**依赖：**ND01–ND02。**归属：**原生 design/UI。

- 将 `DESIGN.md` 的语义颜色、`text-ui-*` 字号尺度、代码/Diff/终端独立字体、4px间距节奏、圆角层级、密度和 icon 映射为原生 token。
- 复建 Button/Input/Select/菜单/Popover/Dialog/Tooltip/Toast/Toggle/Tabs/可调整面板；保留禁用、hover、focus、选中、错误、loading、菜单顺序与快捷键提示。
- 交互覆盖层必须高于 passive tooltip，边缘碰撞/子菜单/滚动/返回焦点正确，不用默认控件改交互。
- 主题、系统外观、语言扩展、缩放和高 DPI必须正确；屏幕阅读器的名称、角色、状态、选区及焦点独立于绘制。
- **验收：**同平台视觉对比、键盘和辅助技术动作矩阵通过；原生样式不能只“差不多”。
- **证据：**[DESIGN](../../DESIGN.md)、[基础控件目录](../../packages/ui/src/components/ui)。

### ND04 Go 与 Node 服务兼容桥、公开端口

**依赖：**ND02。**归属：**transport/ports。

- 明确纯原生客户端与保留 Node services/Host/Agent 的边界；独立 Node runtime/bundle 需打包，不能继续靠 Electron 内置 Node冒充去 Electron。
- 复用公开 `services`、client、server 与 CLI端口；定义调用/事件/取消/错误/版本握手/关闭合同，不把现有 RPC 当作通用 JSON-RPC。
- 只暴露当前公开且授权的能力，不透出 Repo、凭据对象、Host 内部控制器或任意求值接口。
- Go 与 Node 的模型、数组、nullable、optional、二进制、整数/长度、错误码和订阅行为必须跨语言一致。
- **验收：**一条服务调用和事件流能完整取消/关闭、错误保真；服务无重复写入 owner；Node 开销明确计入性能。
- **证据：**[services exports](../../packages/services/package.json)、[client exports](../../packages/client/src/index.ts)、[Agent 启动](../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts)。

### ND05 RPC/V4 编解码、订阅与恢复

**依赖：**ND04。**归属：**protocol/transport/projection。

- 为当前 RPC socket 与 V4物理帧、logical frame、snapshot/delta 分别建立 golden vectors；按真实端序/标签/校验/长度实现，不猜格式。
- 合同来源统一，Go 运行时校验严格；覆盖 wire3/snapshot1、CRC/base64、分片/组装、实际字节限额、失败原子性和序列水位。
- 实现 subscribe → ACK → activate 屏障；ACK前通知保序释放；支持 unsubscribe、same-sub resync、query commands、epoch变化和runtime换代。
- 队列/权限/产物等投影共享同一会话数据源，不为每个pane保存完整权威副本。引用计数和keep-warm由数据层管理。
- **验收：**乱序、重复、超限、损坏、半帧、重连、旧subscription、旧epoch、取消均不污染有效projection；desktop/mobile两种语义分别通过。
- **证据：**[RPC protocol](../../packages/rpc/src/protocol.ts)、[V4 core](../../packages/shared/src/zcode-protocol-v4/core.ts)、[wire codec](../../packages/shared/src/zcode-protocol-v4/wire-codec.ts)、[现有 transport](../../packages/ui/src/v4/transport.ts)。

### ND06 双版本身份、数据隔离与兼容

**依赖：**ND00、ND02。**归属：**app/persistence/release。B05 是本任务负责解决的开放问题；方案未放行时只能使用隔离实验数据，不能启动生产数据共享或迁移。

- 固定原生版应用名、安装/AppID、配置/凭据/运行时/缓存根、更新通道与深链接分流；不覆盖原版注册或安装目录。
- 区分固定 home启动定位设置、自定义数据根、项目/workspace文件、CLI本地运行状态和UI布局/草稿；不把它们全部迁到新单根。
- 定义原版历史只读读取、显式导入、独立副本及schema兼容方案，需备份、校验、取消、错误与回滚；不默认两版双写。
- 普通workspace编辑与Git仍使用用户选定的同一工作路径；身份隔离不应伪造另一套项目路径。
- **验收：**两版并存、单实例判断、登录/更新/链接不互相劫持；导入不会丢历史或覆盖原版；关闭/失败后可安全回滚。
- **证据：**[paths](../../packages/services/src/paths.ts)、[roots resolver](../../packages/services/src/storage/adapters/rootsResolver.ts)、[记忆目录连续性](../memory-data-root-continuity.md)。

### ND07 原生窗口、启动、系统行为与退出

**依赖：**ND03–ND06。**归属：**app/platform。

- 替换Electron窗口、标题栏/系统控件、拖动区、窗口尺寸/最大化/全屏/缩放/多显示器状态；保留平台布局差异。
- 复刻单实例、打开路径/深链接、首次启动、错误隔离、loading和启动阻塞；工作区未准备好不能开放写操作。
- 原生化菜单、托盘、通知/声音、全局键、文件对话框、剪贴板、系统打开/Reveal、编辑器检测、防休眠和显示/辅助权限。
- 退出区分关闭到托盘、关闭窗口、重载/重接与真正quit；先阻止新工作，再解除attachment、完成必要持久化和子进程退出。
- **验收：**Windows关闭到托盘保持当前任务；quit无孤儿/重复Host；多窗口/DPI/深链接/失败恢复符合原版。
- **证据：**[Main入口](../../packages/desktop/src/main/index.ts)、[Host启动](../../packages/desktop/src/main/desktopHostProcess.ts)、[窗口生命周期](../../packages/desktop/src/main/desktopWindowLifecycle.ts)、[platform合同](../../packages/shared/src/platform.ts)。

### ND08 窗口级 Host、CLI 与控制面进程

**依赖：**ND04–ND07。**归属：**host/transport。

- 每窗口Host与attachment registry仍是路由owner；保留scope、requestId、attachmentId、clientMode与可信来源。
- 本地workspace按identity复用CLI；保留启动中的Promise/admission、启动失败、重启、watchdog和退出；不把每个session/pane都变成独立进程。
- plugin与mcp-status控制面不堵塞聊天队列；保持独立作用和当前idle策略。默认子代理在既有CLI中运行，不能错误按“一人一个CLI”设计。
- renderer重载替换为原生视图重接时优先attachment到已有Host，不直接重建业务runtime。
- 为后续自动化提供最小 scheduler 接入：替换 Electron utility 启动器，保留已有 Node scheduler 的事务 claim → main 路由 → Host 执行 → 回报 → settle。该接入在 ND40 前完成；ND46 负责跨进程故障与崩溃恢复增强，不反向阻塞基础到期执行。
- **验收：**同路径不同identity不串线；多pane共享数据；控制面慢请求不阻塞chat；退出/重启后lease与回报正确。
- **证据：**[attachment registry](../../packages/desktop/src/host/windowHostAttachmentRegistry.ts)、[Host](../../packages/desktop/src/host/index.ts)、[process manager](../../packages/services/src/zcode-agent/zcodeAgentProcessManager.ts)、[agent service](../../packages/services/src/zcode-agent/zcodeAgentService.ts)。

### ND09 workspace、任务列表、导航与全局搜索

**依赖：**ND03、ND05、ND08。**归属：**workbench。

- 复刻项目/普通聊天workspace选择、打开文件夹、最近项目、远端项目、创建草稿、会话标题/状态、分组、筛选、固定与归档入口，以当前菜单注册为准。
- 保留前后导航、任务内查找、全局Command Center的命令/会话/文件结果、snippet、搜索历史、展开、键盘选择和跳转高亮。
- 索引、服务端任务事实、sidebar投影与UI选中是不同owner；历史结果不可当作当前running状态。
- 恢复未打开workspace、不可访问目录、已删除/已归档任务、远端断线要显示真实状态，不自动替换identity。
- **验收：**命令中心选择与键盘动作和原版一致；跨workspace结果打开正确scope；数据源慢/失败不污染当前查询。
- **证据：**[WorkspaceSidebar](../../packages/ui/src/WorkspaceSidebar.tsx)、[Command Center](../../packages/ui/src/command-center/CommandCenterDialog.tsx)、[Task Find](../../packages/ui/src/quickpick/TaskFindDialog.tsx)。

### ND10 多pane、group、side-pane及布局恢复

**依赖：**ND03、ND09。**归属：**workbench。

- 复刻pane树、workbench group、split比例、焦点、会话绑定、跨group拖入/移动/取消、布局坍缩与恢复；group叶子的操作条件不与普通pane混同。
- side-pane标签支持激活、横向溢出/总览、拖拽排序、关闭当前/其他/全部、重新打开、按workspace/session展示；保持每种标签的身份和保活策略。
- 会话frame、底部terminal、side-pane分别独立，保留4px resize命中区、最小尺寸、hover/focus/drag反馈。
- 标签覆盖browser、Git、preview、treemapping、whiteboard、trajectory、developer-tools、terminal、bash-output、subagent、selection-side-chat、plan与全部workflow视图。
- **验收：**拖拽取消不改布局/业务；焦点pane关闭后选中有效落点；隐藏/关闭视图不等同停止运行；所有标签类型有验收，不漏长尾。
- **证据：**[WorkspaceShellLayout](../../packages/ui/src/app-shell/WorkspaceShellLayout.tsx)、[V4WorkspaceChatArea](../../packages/ui/src/v4/V4WorkspaceChatArea.tsx)、[布局store](../../packages/ui/src/v4/paneLayoutStore.ts)、[侧栏布局](../../packages/ui/src/app-shell/AnimatedSidePanePanel.tsx)。

### ND11 本地草稿、编辑状态与scope转移

**依赖：**ND05、ND09–ND10。**归属：**composer/persistence。

- 草稿保留文本、富编辑状态、mentions、mode、plan、模型、编排/team意图与变更标记，不缩成一个string。
- 按workspace identity + session隔离；新任务 `__draft__`、主/侧聊、分屏与workspace转移保留各自规则。
- 分享导入上下文准备期间不被空snapshot覆盖；新session取得ID后再进行原子草稿/附件移交。
- 不假设附件blob已经支持跨重启持久化；实现前核实现有范围，缺原生证据显式登记，不凭模型推断。
- **验收：**切换/重挂/重启/发送失败后草稿正确；迟到异步结果不写新scope；关闭会话与普通视图切换不同。
- **证据：**[composerDraftStore](../../packages/ui/src/v4/composer/composerDraftStore.ts)、[workspace transfer](../../packages/ui/src/v4/composer/composerDraftWorkspaceTransfer.ts)、[ConversationComposer](../../packages/ui/src/v4/ConversationComposer.tsx)。

### ND12 富文本输入、输入法和快捷键全集

**依赖：**ND03、ND11。**归属：**composer/platform。

- 复刻Lexical输入的光标、选区、自动高度、长文本滚动、撤销/重做、混合引用、粘贴、编辑历史及禁用态。
- 输入法preedit/commit、Enter选词、Escape取消、Process/Dead/229等边界不能触发发送、全局键或停止。
- 发送/换行由当前生效键位决定，支持非Enter绑定；换行优先；改绑后裸Enter回落保持原规则。
- 全局/窗口/pane/composer/菜单scope分别处理；长按与按键释放、focus变化、popup与dialog拦截不可产生重复动作。
- **验收：**微软拼音等真实输入法、中英文混输、emoji/代理对、不同键位及多pane/覆盖层矩阵通过；不把原生TextArea默认行为当等价。
- **证据：**[LexicalChatInput](../../packages/ui/src/LexicalChatInput.tsx)、[composerShortcuts](../../packages/ui/src/shortcuts/composerShortcuts.ts)、[bindings](../../packages/ui/src/shortcuts/bindings.ts)。

### ND13 mentions、能力发现与所有结构化引用

**依赖：**ND11–ND12、ND04。**归属：**composer/features。

- 保留 `/`、`@`、`$`、`#`、`;` 与当前全角/日元等兼容别名；中文alias依起始/组合态规则匹配。
- 候选组覆盖插件、文件、会话、白板、Skills、Subagents、commands及当前MCP引用；`+`入口与slash/@各自的分组/筛选以当前接线为准。
- 候选发现走Host有界文件搜索和各公开catalog；路径显示不是身份；选择只替换当前token和匹配尾部。
- 原生编辑模型必须保存引用类型/目的地/元数据，复制/粘贴/删除/撤销和发送序列化与原版一致。
- 四类上下文引用分开：代码评论、Web元素、PPTX元素、会话选区；保留单项/全部移除、预览定位、scope与stale标记。
- **验收：**候选/IME/取消/正文边界、引用往返、非法目的地、远端同路径与元数据全部验证；标签不得降为普通文本。
- **证据：**[MentionPlugin](../../packages/ui/src/mentions/MentionPlugin.tsx)、[SlashCommandPlugin](../../packages/ui/src/SlashCommandPlugin.tsx)、[Action Menu](../../packages/ui/src/prompt-editor/ChatPromptActionMenu.tsx)、[mention tests](../../packages/ui/test/mentionMarkdown.test.ts)、[trigger tests](../../packages/ui/test/promptInputTriggers.test.ts)。

### ND14 附件选择、上传、读取与取消

**依赖：**ND05、ND11–ND13。**归属：**composer/content。

- 复刻文件选择、粘贴、拖入、预览chip、移除、错误/重试与发送门禁，保留MIME、大小、视频/PDF规则。
- begin/chunk/commit/abort、采用已归session的附件、授权read/range与总字节边界严格遵循协议。
- 新session预热/创建、跨workspace转移、上传中切换、取消/关闭和runtime重启不串scope。
- 队列编辑恢复ready附件不可二次上传或adopt；引用元数据与附件字节分开持有。
- **验收：**合成大文件、分片失败/重复/超限、取消与恢复正确；关闭后无在途读取/临时buffer残留；本地与远端授权等价。
- **证据：**[useComposerAttachments](../../packages/ui/src/v4/composer/useComposerAttachments.ts)、[attachment transaction](../../packages/ui/src/v4/attachmentUploadTransaction.ts)、[transport读取端口](../../packages/ui/src/v4/transport.ts)。

### ND15 创建、发送、队列、指导与未知结果对账

**依赖：**ND05、ND08、ND11–ND14。**归属：**projection/composer，CLI仍是owner。

- 新session的create与send分别处理ACK；创建成功不等于首发成功。捕获提交时模型/mode/plan等意图，不能从之后的UI状态补读。
- 保留busy输入的startNow/queue/guide、session followup与单次覆盖、held queue清空/保留选择，expectedHeldQueueItemIds用于并发校验。
- 复刻队列编辑、移除、重排、立即发送、autoDrain和pending guides；只调用既有命令，不在Go重新接纳accepted输入。
- unknown ACK按commandId查询对账；只有原引擎判定可重放才重发，不因timeout盲目新建session或丢草稿。
- **验收：**重复点击/断网/重启/移动scope/同时手机操作不重复执行；创建与发送分阶段失败可恢复；held队列不误处理未确认项。
- **证据：**[Command payloads](../../packages/shared/src/zcode-protocol-v4/command.ts)、[CommandInbox](../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts)、[SessionPane](../../packages/ui/src/v4/SessionPane.tsx)、[Recovery Banner](../../packages/ui/src/v4/PendingCommandRecoveryBanner.tsx)。

### ND16 权限、提问、elicitation、Plan审批与Hook信任

**依赖：**ND03、ND05、ND15。**归属：**interaction UI；权威在broker。

- 分别复刻PermissionDialog、AskUserQuestion/schema输入、elicitation、plan approval/ExitPlanMode、workspace hook review，不统一成textarea加允许/拒绝。
- 选项、多选/自由文本/注解、prefix scopes、工作流/保存脚本专属权限内容、preview及请求关联按原schema展示和提交。
- resolveInteraction保留first-wins/迟到noop；自动结束/首次有效操作snooze、取消、错误、重连/换代保持当前行为。
- Hook启停、信任审查/revoke、内容digest与损坏fail-closed不降级；UI不能自行持久“已授权”或直接执行工具。
- **验收：**多个请求、多pane、IME、窗口关闭、重复答案、schema无效、手机同时操作和stale interaction均有原生/协议证据。
- **证据：**[V4InteractionDialogs](../../packages/ui/src/v4/V4InteractionDialogs.tsx)、[PermissionDialog](../../packages/ui/src/PermissionDialog.tsx)、[ElicitationDialog](../../packages/ui/src/ElicitationDialog.tsx)、[permission broker](../../apps/zcode-cli/packages/core/src/permission/broker.ts)。

### ND17 消息、工具块、Markdown与特殊内容呈现

**依赖：**ND03、ND05、ND14–ND16、B03。**归属：**content/UI。

- 复刻用户/助手、推理、工具输入/输出、并行工具、后台Bash、子代理、错误/retry、token/速度/耗时、折叠与分组及文件摘要。
- Markdown覆盖当前标题、列表、引用、表格、任务、代码、文件链接、媒体与特殊块；流式未闭合语法、代码高亮/复制和完成态行为正确。
- 原生绘制保证跨块选择、链接安全、右键与一键复制；可见/隐藏/展开影响渲染，不修改权威内容。
- Mermaid/公式/HTML特殊块接独立受控renderer；MyGo默认显示源码不等价于原版图形/公式结果，受B03约束。
- **验收：**固定输入/事件形成相同结构与操作；流式不中断选区、不闪错态；大工具输出遵循原显示限额但不丢执行事实。
- **证据：**[message](../../packages/ui/src/components/ai-elements/message.tsx)、[ToolCallBlocks](../../packages/ui/src/ToolCallBlocks)、[ConversationRowView](../../packages/ui/src/v4/ConversationRowView.tsx)、[shiki](../../packages/ui/src/lib/shikiHighlighter.ts)。

### ND18 时间线、分页、查找、分叉与文件回滚

**依赖：**ND05、ND10、ND17。**归属：**projection/content。

- 原生可变行高虚拟化、live tail、测高缓存、滚动anchor、跳到底部、冷开预览/骨架、历史分页与目录完整性分别实现。
- 用户上翻或选取旧文时不被流式内容拉回底部；窗口/字体/分屏resize后阅读位置正确。
- 复刻任务内查询、命中数/导航、高亮、已加载历史边界及失效清理；不凭MyGo全量search补造原版没有的语义。
- `forkAssistant`、`editUserQuery`、`retryTurn`、`applyFileRewind`、反馈保持rowId+entityId稳定目标，revision/epoch拒绝stale操作；文件preserve/rewind明确。
- **验收：**长聊天/分页/重连/branch切换/旧row目标、滚动恢复/文件回滚预检通过；不靠自动加载全部正文解决目录。
- **证据：**[ConversationTimeline](../../packages/ui/src/v4/ConversationTimeline.tsx)、[projection store](../../packages/ui/src/v4/conversationProjectionStore.ts)、[timeline anchor](../../packages/ui/src/v4/timelineScrollAnchor.ts)、[command targets](../../packages/shared/src/zcode-protocol-v4/command.ts)。

### ND19 消息选区、侧聊、分享/导入与反馈

**依赖：**ND12–ND18。**归属：**composer/features/services。

- 复刻跨段选区、加入主聊/侧聊、引用上下文、复制与clear；结构化定位指向正确parent/workspace。
- `createSelectionSideSession`复用父配置，pending创建只做在途去重，不能变成每父会话永久仅一个child。
- 会话分享选择、预检、access mode、确认、发布进度/失败requestId、成功link复制、只读回放和导入provenance全链路保留。
- 发布、反馈上传等外向动作保留用户确认与数据筛选；不能把“复制链接”按钮变成隐式上传整个会话。
- 共享上下文只通过当前允许的context ref提交，完整正文由runtime provenance解析；导入等待态/丢弃保持权限和恢复。
- **验收：**主/侧聊多scope不串引用；分享选择/权限/附件/失败恢复真实；导入不会重复创建或自动发送。
- **证据：**[selection runtime](../../packages/ui/src/lib/selectionSideChatRuntime.ts)、[selection tooltip](../../packages/ui/src/v4/ConversationSelectionTooltip.tsx)、[share store](../../packages/ui/src/store/conversationShareSelectionStore.ts)、[SessionPane分享链路](../../packages/ui/src/v4/SessionPane.tsx)。

### ND20 模型意图、模式、目标、状态与子代理

**依赖：**ND15–ND19。**归属：**composer/features，runtime事实只读。

- 复刻provider/model/thought、模式和Plan、followup、上下文使用/速度/余额/配额提示；下次提交意图不混同运行中配置。
- Office/Coding界面模式与permission/submission mode是不同维度；Office草稿的插件入口、Coding的Git入口等当前显隐保留。
- 目标发起、暂停/恢复、验证状态、状态panel自动打开/折叠、按section展示和停止动作遵循当前owner。
- 子代理运行/终态/历史目录、查看child、速度/usage、SendMessage与停止；经典与编排角色/工具面保持当前注册，不凭历史恢复旧角色。
- **验收：**模型和Git提交模型互不干扰；停止带expectedForegroundExecutionId不误杀后续run；closing panel不停止任务；所有统计来源真实。
- **证据：**[ConversationStatusPanel](../../packages/ui/src/v4/ConversationStatusPanel.tsx)、[composer](../../packages/ui/src/v4/ConversationComposer.tsx)、[Subagent pane](../../packages/ui/src/app-shell/SubagentSessionSidePane.tsx)、[Office gate](../../packages/ui/src/hooks/useInterfaceMode.ts)。

### ND21 文件树、搜索、外部编辑器和代码评审

**依赖：**ND09–ND10、ND13、ND17。**归属：**files/UI/platform。

- 复刻懒加载层级、虚拟列表、sticky目录、路径选择/定位、搜索/已改文件过滤、刷新/watch、删除文件状态与图标。
- 保留workspace文件搜索范围、`.zcodeignore`和远端有界搜索；设置入口隐藏不等于规则失效。
- 文件预览/目录面包屑/复制绝对或相对路径/文件管理器/已安装编辑器/远端打开上下文仍走服务与平台端口。
- 代码只读preview、行anchor、行/gutter选取、评论加入聊天/移除、工具生成diff与review区分；MyGo有editor不意味着原版预览变成可写编辑器。
- **验收：**远端不能打开成同名本地文件；文件消失/太大/变更时提示真实；取消watch/读取无stale结果；评论scope与范围正确。
- **证据：**[WorkspaceFileTree](../../packages/ui/src/workspace-file-tree/WorkspaceFileTree.tsx)、[PreviewPane](../../packages/ui/src/PreviewPane.tsx)、[code viewer sources](../../packages/ui/src/lib/codeViewer.ts)、[file service](../../packages/services/src/file/fileService.ts)。

### ND22 Git 工作区、提交/网络和历史图谱

**依赖：**ND04、ND10、ND20–ND21。**归属：**Git UI，services/Git事实权威。

- 复刻Git浮层：更改、分支、图谱、提交或推送、拉取；源区分last-turn、staged、unstaged等当前dataset，不扩大当前session文件范围。
- 保留展开diff/搜索、stage/unstage、discard显式确认、复制/定位、刷新和每source缓存revision；删除文件/untracked/空仓/不可写状态不丢。
- AI提交信息的模型选择、文件选择、格式/流式结果与会话模型独立；Git网络代理、认证和安全规则继续由服务执行。
- 图谱有分页、过滤、分支/历史结果和commit详情，异步旧查询不污染新filter。
- **验收：**合成Git仓库覆盖真实磁盘结果与UI；重连/刷新竞争、不可写、discard取消/确认和选中文件范围全部通过。
- **证据：**[GitToolsPanel](../../packages/ui/src/v4/GitToolsPanel.tsx)、[GitPane](../../packages/ui/src/GitPane.tsx)、[GitGraph](../../packages/ui/src/git-graph/GitGraphPane.tsx)、[Git动作测试](../../packages/ui/test/gitPaneFileActions.test.ts)、[提交范围测试](../../packages/services/test/gitCommitMessageFileScope.test.ts)。

### ND23 底部/侧栏终端、后台 Bash 与PTY

**依赖：**ND01、ND07–ND10、ND12。**归属：**terminal/UI；服务拥有PTY。

- MyGo终端引擎需适配已有终端服务：create/write/resize/data/exit/dispose以及远端上下文；不能为显示已有命令另起shell。
- 复刻字体、theme、链接、scrollback、搜索（以原版已提供入口为准）、选区/矩形/双击、复制/粘贴、中文IME、宽字符、鼠标报告与full-screen程序。
- **底部终端例外必须保留**：最后一个tab的关闭是收起面板并保活；多个tab中关闭一个才移除其session；PTY退出删除对应tab，只有当前workspace最后一个退出才收起面板。
- side-pane terminal关闭释放其持久实例/PTY/订阅；切workspace仅detach/保活。两种终端资源不共享同一registry。
- 后台Bash输出复用既有work/session事件，支持查看、取消和继续读取；关闭输出pane不等于终止work。
- OSC 52等剪贴板策略、链接/外部打开和环境/远端路径不因Ghostty默认行为而变化；默认buffer大小按产品验收，不直接照框架默认10MB。
- **验收：**真实ConPTY和UnixPTY、两终端、最后tab关闭、进程自然退出、resize竞争、切换/关闭/reload、后台输出和退出清理通过。
- **证据：**[Terminal](../../packages/ui/src/Terminal.tsx)、[terminal state](../../packages/ui/src/terminal/terminalPanelState.ts)、[persistent registry](../../packages/ui/src/terminal/sidePaneTerminalSessionRegistry.ts)、[terminal service](../../packages/services/src/terminal/terminalService.ts)、[Bash pane](../../packages/ui/src/app-shell/BackgroundBashOutputSidePane.tsx)。

### ND24 PreviewPane 总路由、文本、图片与媒体

**依赖：**ND10、ND14、ND17、ND21。**归属：**content/UI。

- 保留source判别：file、code-review、text、patch、multi-file-diff、image、media、pdf、pptx，scope与sourceKey复用规则不得改。
- 原生内容框架保留路径面包屑、源文件打开、source/preview切换、wrap、代码主题/字号、加载/缺失/过大/解码错误态和关闭取消。
- SVG源码/预览、图片缩放与展示、视频/音频播放/暂停/进度/音量/全屏/元数据和安全链接以当前控件能力为基线；不增加未经要求的编辑功能。
- 隐藏重内容/resize可减少绘制，不能打断仍在操作的媒体或丢失播放/阅读状态；本地授权URL、远端字节和fallback区分。
- **验收：**每种source及大图/媒体/损坏/切换/全屏/取消均有正式fixture；不只支持纯文本。
- **证据：**[PreviewPaneContent](../../packages/ui/src/previewPaneContent.tsx)、[Image](../../packages/ui/src/previewPaneImageContent.tsx)、[Media](../../packages/ui/src/previewPaneMediaContent.tsx)、[重内容gate](../../packages/ui/src/app-shell/animatedSidePanePanelModel.ts)。

### ND25 PDF 原生排版、导航、选择和range读取

**依赖：**ND14、ND24、B02。**归属：**content engine。

- 替换react-pdf/pdf.js/worker的实现，保留当前页数、输入跳页、前后页、缩放/anchor、文本/链接层和读取失败行为。
- 支持本地/授权range/远端source；停止后不继续range读取；旧render完成不覆盖新倍率/新文档。
- 原版是否提供全文查找/导出等入口必须先核实，不能因框架有能力把新增功能冒充复刻；所有已有选择/复制仍需等价。
- 原生引擎需要内存、线程、安全解析、跨平台与许可资格验证，不限定必须由纯Go自行写PDF parser。
- **验收：**分页、大PDF、中文字体/嵌入字体、旋转/链接/选择/缩放、取消和损坏样本正确。
- **证据：**[pdf-viewer](../../packages/ui/src/components/ui/pdf-viewer.tsx)、[PDF route](../../packages/ui/src/previewPanePdfContent.tsx)。

### ND26 Word与Excel只读预览

**依赖：**ND24、B02。**归属：**content engine。

- 保留 `.docx`、`.doc`、`.xlsx`、`.xlsm`、`.xls` 分流；DOCX section/page/margin/header/footer/footnote、表格/图形、宽度适配不能降为文本。
- Excel多sheet导航、键盘Home/End/左右、表格显示/选择/滚动及只读边界；不随原生组件增加保存/编辑入口。
- legacy DOC仍走真实解析/完整分页；不能用轻量preview丢掉原版排版。
- OOXML relationship链接必须安全清洗；控制字符/危险scheme拒绝，可信文档锚点及Web外链按原合同。
- **验收：**多section Word、复杂表格/中文/损坏、旧doc、多个Excel sheet与公式显示样本保真；宏文件不获得执行权限。
- **证据：**[格式规则](../../packages/ui/src/lib/officeFilePreview.ts)、[DOCX](../../packages/ui/src/previewPaneOfficeDocxContent.tsx)、[DOC](../../packages/ui/src/previewPaneOfficeLegacyDocContent.tsx)、[Excel](../../packages/ui/src/previewPaneOfficeXlsxContent.tsx)。

### ND27 PPTX、元素引用、watch与PDF导出

**依赖：**ND13–ND14、ND24–ND26、B02。**归属：**presentation engine/UI。

- 替换浏览器版pptx-renderer；保留slide页数/大小、缩略图、页输入/前后页、zoom、链接与渲染错误。
- 原生document/element模型保持slidePart/nodeId/nodePath/nodeType/bounds/zIndex及table cell身份；屏幕命中与文档坐标转换正确。
- 元素选择、选中文字、AI edit评论、加入对话、取消与反向打开引用保持scope/fingerprint；文件修改/页不存在提示真实，不能将元素选取变成截图矩形。
- 文件watch处理不完整写入、重试/重新解析、stale generation和当前引用；关闭必须dispose render handles和watch。
- PDF导出保留保存确认、分页/字体/图片完整性和错误/取消/成功路径；不继续使用DOM print host或Electron打印却声称全原生。
- **验收：**形状/图片/图表/表格/中英字体、多个元素叠层、source变更、AI引用往返和导出PDF逐项对比。
- **证据：**[presentation contract](../../packages/ui/src/presentation/types.ts)、[PPTX viewer](../../packages/ui/src/components/ui/pptx-preview-viewer.tsx)、[element ref](../../packages/ui/src/lib/pptxElementReference.ts)、[PDF print](../../packages/ui/src/presentation/presentationPdfPrintExport.ts)。

### ND28 内置浏览器、人类与Agent浏览器及数据设置

**依赖：**ND05、ND07–ND10、ND13、B01。**归属：**browser backend/UI。

- 保留人类导航、前后/刷新、地址/标题/favicon、new/close tab、网页popup/dialog/下载/权限、Cookie/session、响应式viewport/zoom与滚动链。
- 人类viewport偏好与Agent固定viewport不同owner，不能把用户缩放存为Agent执行尺寸；browser ambient context与用户claim/handoff/deliverable保持当前scope。
- Agent methods按当前公开metadata逐项覆盖：snapshot/DOMref、click/fill/type/press/scroll/hover/select/check/drag、evaluate/wait/playwright、截图、录制、tab ownership、cancel与finalize。
- 元素picker加入chat保留DOM身份/选中文字/定位，不能用像素点击替代DOM语义。
- residency的suspend/restore/ready ACK、debugger detach、generation/stale回报和后台tab保活保持次序；浏览器真实内存计入总占用。
- 设置保留Browser Use插件启停、Chrome数据导入、清cache/清all确认、证书例外的明确scope，不把全局TLS放行作为替代。
- **验收：**B01先放行；同一个页面同时可供用户与Agent操作，恢复/隐私/权限/数据清理与录制不丢功能。无法达到则整项保持blocked。
- **证据：**[UnifiedBrowserView](../../packages/ui/src/browser-use/UnifiedBrowserView.tsx)、[browser命令](../../packages/shared/src/browser-use/command-metadata.ts)、[Browser settings](../../packages/ui/src/settings/BrowserSettingsSection.tsx)、[guest manager](../../packages/desktop/src/main/browserView/browserGuestManager.ts)。

### ND29 编排与动态工作流执行合同

**依赖：**ND04–ND08、ND15–ND16。**归属：**runtime兼容与projection。

- 复用当前orchestration和动态workflow引擎、工具面、脚本校验、权限、capability/realm、并发、依赖、取消、修订/恢复及journal。
- 编排team/enable配置、下一turn生效与活动run输入、cancelOrchestrationRun按runId保持语义；不会因一个panel新建另一执行owner。
- Create/Amend/Resume/Save/Eval等工具及设置命令按实际运行态和拒绝词表处理，不能把errored/user-cancelled任意重启；保存权限与作用域不省略。
- 子Agent仍由原runtime执行；不把UI任务列表变成可执行DAG，不在MyGo每帧执行脚本。
- **验收：**业务fixture在原runtime与原生提交端同结果；取消/失败/修订/恢复/跨scope/no capability不产生重复run或遗留work。
- **证据：**[dynamic-workflow](../../apps/zcode-cli/packages/dynamic-workflow/package.json)、[runtime child](../../apps/zcode-cli/packages/dynamic-workflow-runtime/src/child-source.ts)、[command合集](../../packages/shared/src/zcode-protocol-v4/command.ts)、[orchestration tests](../../apps/zcode-cli/packages/core/test/orchestrationAdmission.test.ts)。

### ND30 工作流目录、详情、Actor、Workspace和产物

**依赖：**ND10、ND17、ND21、ND24、ND29。**归属：**workflow UI。

- 复刻run卡、因果图、时间线、阶段/节点/日志、pending问题、取消/恢复/配置修订、来源provenance及真实状态。
- side-pane包括workflow-directory/run/actor-session/workspace/artifact；身份是run/node/artifact，不仅是工具调用row。
- 已结束run被实时8-run窗口淘汰或父对话edit/retry后，已打开详情不能自动关闭；journal可查，缺实时状态和缺图要诚实区分。
- 产物区分用户面artifact与脚本顶层返回值；metadata/spec/body、live/journal、loading/unavailable/missing/invalid分别处理。
- chart/table/metrics/board四种看板，分页item、更新、版本选择、内容字节、文件打开/Reveal/复制及子会话保留；新版本不能强行打断用户正在看旧版本。
- **验收：**run恢复、冷开、结果被淘汰、父分支改变、产物版本/大正文/数据分页/问题回答全部有真实协议证据。
- **证据：**[WorkflowRun pane](../../packages/ui/src/app-shell/WorkflowRunSidePane.tsx)、[artifact pane](../../packages/ui/src/app-shell/WorkflowArtifactSidePane.tsx)、[preset render](../../packages/ui/src/app-shell/workflow-artifacts/ArtifactPresetBody.tsx)、[SidePane run合同](../../packages/ui/src/lib/workspaceSidePane.ts)。

### ND31 设置导航、常规、外观与快捷键

**依赖：**ND03、ND06–ND07、ND12。**归属：**settings UI，settingService权威。

- 按当前可见17分区复刻导航、breadcrumb、上次section和兼容aliases；不恢复移除的引导卡、provider默认入口或隐藏设置。
- general保留语言/interface mode、网络代理/bypass/CA、搜索增强、通知/声音、关闭托盘、防休眠、硬件加速、更新、交互自动处理、完整IO留存、消息/tool分组、自动归档与数据目录。
- appearance保留当前主题、字体/代码/显示选项；shortcuts保留搜索、重绑、冲突、恢复默认、scope与平台键名。
- 保存草稿与持久设置、平台sync、广播同步区分；回环防护和失败恢复不能从一个全局Go struct直接覆盖。
- **验收：**每个控件有字段/服务/持久化/副作用映射，重启和多窗口同步正确，删除的UI写入口仍保持旧配置读取兼容。
- **证据：**[settings config](../../packages/ui/src/settings/settingsPageConfig.ts)、[SettingsPage](../../packages/ui/src/SettingsPage.tsx)、[settings helpers](../../packages/ui/src/settingsPageHelpers.tsx)、[navigation gate](../../packages/ui/src/lib/settingsNavigation.ts)。

### ND32 模型供应商、目录与请求参数

**依赖：**ND04、ND20、ND31。**归属：**provider settings/services。

- 模型设置sidebar当前只列custom provider；保留添加模板、API类型、地址/Key、模型发现/手工管理、测试和详情参数；无供应商显示当前空态。
- 模型完整ID、provider/API格式、reasoning/tool/多模态、默认继承、上下文/token限制依当前catalog与适配器合同，不凭框架擅改模型列表。
- settings的base/local provider服务与当前workspace的执行模型服务区分，不能在远端项目中误写远端/全局配置。
- 供应商异常、认证、模型不存在、连接测试的错误与取消正确；Key展示/编辑/删除不得进日志或fixture。
- **验收：**自定义OpenAI/Anthropic/Gemini等当前支持API的fixture保真；settings与发送命令捕获一致，能力不误标。
- **证据：**[model entry spec](../model-settings-provider-entries.md)、[model settings](../../packages/ui/src/SettingsPage.tsx)、[API format browser test](../../packages/ui/test/modelProviderApiFormat.browser.test.ts)。

### ND33 同步配置、GitHub账户与敏感数据

**依赖：**ND06、ND31–ND32。**归属：**sync/services/platform。

- modelSmartConfig当前名称为同步配置，保留GitHub登录/device flow、配置远端读取、上传/下载、差异/冲突和失败取消。
- provider profile同步明确不上传API Key，下载后补回本机Key；记忆/提示词等按当前同步范围，不能默认全目录同步。
- 实现设备授权轮询single-flight、过期/取消、logout和本地加密credential服务；不把配置展示缓存当在线认证。
- **验收：**网络断连、Key隔离、登录失效、多窗口和取消不泄露或重复RPC；原生版凭据与原版数据策略经ND06明确。
- **证据：**[GithubAccountSection](../../packages/ui/src/settings/GithubAccountSection.tsx)、[credential service](../../packages/services/src/credential/credentialService.ts)、[GitHub flow test](../../packages/ui/test/githubAuthFlowModel.test.ts)。

### ND34 插件商店、来源与完整生命周期

**依赖：**ND04、ND13、ND31。**归属：**plugin UI/services。

- 复刻公开/个人、精选、已安装条、详情、管理已安装、筛选、来源管理、配置、启停、手动刷新/后台目录刷新、检查更新/升级/卸载/恢复。
- Official Marketplace含内置和CDN，不混同作者归属；zip/hash/下载/原子安装/取消/错误不因原生化放宽。
- 内置卸载写播种抑制，重启不自动重装；删除来源不卸载已有插件，orphan可继续用/配置/卸载，重新添加同源恢复关联。
- manifest带来的commands/skills/agents/hooks/MCP随启停更新catalog和runtime；示例提示词只新建并预填，不自动发送。
- **验收：**每一生命周期步骤同时断言UI、磁盘与runtime；离线/失败/取消/重启和来源差异不丢语义。
- **证据：**[CONTEXT](../../CONTEXT.md)、[PluginStorePage](../../packages/ui/src/settings/PluginStorePage.tsx)、[plugin store](../../packages/ui/src/store/pluginManagementStore.ts)。

### ND35 Skills、Subagents、commands与MCP配置

**依赖：**ND04、ND13、ND31、ND34。**归属：**capability settings/services。

- 四个独立设置分区完整复刻：列表/发现、详情、来源、搜索、配置、启停、创建/编辑/删除/恢复及当前readonly限制。
- 保留user/workspace/builtin/plugin覆盖顺序、Markdown/JSON实际存储格式、模型继承和运行中/下一turn生效规则；不得统一成全局一张表。
- MCP服务器status、启动/握手/失败详情、参数/环境变量、认证、启停和专用status进程独立；探测慢不能卡插件卸载或chat。
- 自定义commands与prompt library分别是执行动作和插入文本；子代理定义与运行态child分别是配置和结果，不混同。
- **验收：**本地/远端/workspace作用域、格式无效/文件变动、能力刷新/已移除项和权限完整；配置保存后菜单及执行事实一致。
- **证据：**[SettingsPage资源路由](../../packages/ui/src/SettingsPage.tsx)、[Subagents](../../packages/ui/src/settings/SubagentsSection.tsx)、[capability stores](../../packages/ui/src/store)、[service exports](../../packages/services/src/index.ts)。

### ND36 Hooks与workspace信任管理

**依赖：**ND16、ND31、ND34–ND35。**归属：**hooks/services。

- 保留hooks列表、声明来源、启停/修改/删除、workspace review、内容digest、单项选择/撤销信任、解释和拒绝状态。
- 执行owner与trust store保持fail-closed；原生保存/编辑不等于授权执行，UI不得自动补信任。
- 同步/插件更新改变声明时重审规则与runtime guard保持一致。
- **验收：**修改后旧信任不能复用；损坏store/未授权/同时手机回答保真；审查UI操作与执行结果都验证。
- **证据：**[hooks contract](../../packages/services/src/hooks/hooks.ts)、[resolve/review commands](../../packages/shared/src/zcode-protocol-v4/command.ts)、[SettingsPage](../../packages/ui/src/SettingsPage.tsx)。

### ND37 记忆、提示词库与使用偏好

**依赖：**ND06、ND13、ND31、ND33。**归属：**memory/prompt services/UI。

- memory总开关的SharedSettings与onboarding偏好双写由当前service顺序完成，不在两个UI路径重复维护。
- 记忆列表/项目、查看/编辑/删除、当前生效根与inactive root提示、copy/move连续性按当前规格，Settings必须展示模型真正使用的数据。
- prompt library列表/搜索/创建/编辑/删除、插入、trigger、i18n、同步与旧service缺能力提示保留；与command执行区分。
- Settings页面使用base/local服务，不跟随远端workspace误读远端home；工作区引用仍遵循scope。
- **验收：**数据根变化、无文件/旧根、读取失败、同步/取消、模板插入只填不发；未启用memory不能错误宣称已参与注入。
- **证据：**[记忆根规格](../memory-data-root-continuity.md)、[Memory Settings](../../packages/ui/src/settings/MemorySettingsSection.tsx)、[prompt store](../../packages/ui/src/store/promptLibraryStore.ts)、[memory root test](../../apps/zcode-cli/packages/bootstrap/test/memoryStorageRoot.test.ts)。

### ND38 使用统计、请求日志、存储和归档

**依赖：**ND06、ND09、ND20、ND31。**归属：**usage/storage services/UI。

- usage按当前来源/套餐tabs与应用统计、请求logs分页/filter、时间/provider/model/status/error/费用等现有字段保留；当前环境和远端事实范围明确。
- 模型完整I/O留存开关、请求统计、model trajectory是不同数据来源，不能改成同一日志cache。
- storage分类、大小、清理/取消、路径/Reveal、统计与真实磁盘变化保留；不能清未归本版的原版数据。
- archive跨workspace列出归档任务，恢复/删除/自动归档天数和确认保留；`deleteSession`仅关闭/保历史与`purgeSession`物理不可逆不同。
- **验收：**大分页、条件变化竞争、无来源、网络失败/旧CLI、真实清理/恢复和确认；日志不泄凭据，归档不意外重启任务。
- **证据：**[SettingsPage](../../packages/ui/src/SettingsPage.tsx)、[request log seeds](../../.agents/skills/feature-boundary-planner/references/zcode-feature-graph.yaml)、[storage services](../../packages/services/src/storage)、[session commands](../../packages/shared/src/zcode-protocol-v4/command.ts)。

### ND39 首次引导、OAuth、账户/订阅与quota

**依赖：**ND06–ND07、ND20、ND31–ND33。**归属：**onboarding/account services/UI。

- 保留首次OccupationOnboarding、职业/interface mode/偏好、跳过/完成/再次打开快捷键和独立迁移请求；不恢复设置页已移除的引导卡。
- OAuth保持state注册→外部授权→深链接/轮询→校验/交换→credential→登录态事件；缓存恢复与远端验证区分。
- 账户/来源、余额、购买/升级、订单/协议、配额/reset、购买后刷新等仅按当前可达条件复刻；默认provider入口移除不等于登录/收费服务全部删除。
- quota banner/context meter/刷新/等待/错误和eligibility由服务裁决；UI不能伪造额度、价格或自动购买。
- **验收：**登录失败/取消/过期、来源切换、购买确认/完成刷新、断网、旧配置和quota限制保持业务与数据安全。
- **证据：**[OccupationOnboarding](../../packages/ui/src/onboarding/OccupationOnboarding.tsx)、[OAuth](../../packages/services/src/oauth/oauthService.ts)、[升级dialog](../../packages/ui/src/settings/CodingPlanUpgradeDialog.tsx)、[引导入口规格](../settings-onboarding-entry.md)。

### ND40 定时任务、闲时任务与已保存工作流中枢

**依赖：**ND09、ND15、ND29–ND30、ND39。**归属：**automation UI；scheduler/services权威。

- 在 ND08 的最小 scheduler 接入上验证基础到期、手动派发与重启再登记，具备 claim/dispatch/settle 后再联调 UI；不等待 ND46 才第一次启动调度器。
- 自动化当前在workspace主视图，不放回Settings侧栏；保留breadcrumb、分类tabs、搜索/filter、模板、聊天创建、编辑/启停/删除、手动运行和history/session跳转。
- 普通calendar/interval/相对一次性、有限次数、timezone及状态显示按当前命令/记录规则；不自算时间偷偷偏移schedule。
- offpeak独立排队、资格/额度、创建/编辑/删除、history、init/resume与状态；不是没有clock的cron，也不新建同名accepted queue。
- saved workflow列表/作用域/args/运行/历史/产物/脚本，使用startSavedWorkflow等当前命令，不用合成聊天文案绕过协议。
- **验收：**重复点击、到期/停用/取消竞争、无Host、断连与重启、有限run计数、服务拒绝/eligibility变化不重复执行或丢历史。
- **证据：**[AutomationsSection](../../packages/ui/src/settings/AutomationsSection.tsx)、[workspace入口](../../packages/ui/src/app-shell/WorkspaceShellLayout.tsx)、[automation store](../../packages/ui/src/store/automationManagementStore.ts)、[offpeak store](../../packages/ui/src/store/offPeakTaskStore.ts)。

### ND41 Bots、手机配对面与渠道配置

**依赖：**ND06–ND08、ND15、ND39–ND40。**归属：**bots services/UI/platform。

- 保留WebRemoteControlDialog的二维码/配对/连接状态/渠道入口与BotsDialog，不只复制弹窗外观。
- 当前implemented provider为weixin、feishu、lark、telegram、webhook；dingding、discord、wecom保持当前未实现状态，不能在任务书冒充已可用。
- 保留创建/rename/secret/删除/启停、扫码注册/轮询/绑定码/TTL、允许workspace/commands、reply mode与运行status；敏感secret只走credential端口。
- Bot请求由可信Host注入来源和delivery target；不能由UI伪造Bot身份或跨workspace执行。
- **验收：**绑定过期/取消、QR重复启动、登录/secret失败、workspace权限及删除/重启、UI状态与实际渠道服务一致。
- **证据：**[WebRemoteControlDialog](../../packages/ui/src/WebRemoteControlDialog.tsx)、[BotsDialog](../../packages/ui/src/BotsDialog.tsx)、[provider gates](../../packages/ui/src/botsUi.ts)。

### ND42 导入/迁移、帮助、更新、反馈与错误入口

**依赖：**ND06–ND07、ND09、ND31、ND39。**归属：**auxiliary UI/services/platform。

- 保留引导迁移请求与实际外部Agent/AGENTS导入格式、预检、目标路径、确认、备份和失败规则；Settings无sidebar不等于handler删除。
- 帮助/产品文档/社区/About、头像菜单/缩放、命令中心入口按当前平台可达条件，链接仍由安全平台端口打开。
- 更新检查/自动下载/安装/发布说明/错误/重启，旧receivePreviewUpdates配置读取继续生效但不恢复已移除UI开关。
- 反馈中心/tickets/feature request、描述/contact偏好、截图选择/预览、模型context、进度/后台上传/重试/取消、错误转反馈保持确认与敏感数据过滤。
- **验收：**迁移不可覆盖错文件；退出/更新/上传失败可恢复；未确认不对外上传或发布；About和菜单是真实原生行为。
- **证据：**[MigrationSection](../../packages/ui/src/settings/MigrationSection.tsx)、[FeedbackCenter](../../packages/ui/src/feedback/FeedbackCenter.tsx)、[App辅助面](../../packages/ui/src/App.tsx)、[更新通道规格](../settings-update-channel.md)。

### ND43 白板、Treemapping、模型轨迹与Developer Tools

**依赖：**ND10、ND13、ND17、ND21、ND38。**归属：**canvas/diagnostic UI。

- 白板rename、笔/橡皮/颜色/粗细、pointer capture、撤销/redo/clear、加入chat与workspace存储保留；高DPI坐标和取消手势不提交误笔画。
- Treemapping按当前/指定消息构建文件目录/事件视图，点击路径和关联preview、历史来源与active scope保持正确。
- ModelTrajectory完整记录/角色/工具payload、分类展开/全部展开、搜索/命中导航、刷新、源目录打开和空/错误态复刻；不混同请求logs。
- DeveloperTools只在当前visibility gate启用时展示，保留network请求/retry/stall/错误字段与诊断范围，不为原生化把敏感raw数据默认展示。
- **验收：**canvas操作与数据、消息源变化、轨迹大数据/搜索/展开、隐藏/关闭和日志安全均有证据。
- **证据：**[WhiteboardPane](../../packages/ui/src/WhiteboardPane.tsx)、[TreemappingPane](../../packages/ui/src/TreemappingPane.tsx)、[ModelTrajectoryPane](../../packages/ui/src/ModelTrajectoryPane.tsx)、[DeveloperToolsPane](../../packages/ui/src/DeveloperToolsPane.tsx)。

### ND44 SSH/WSL/Docker/远端服务全生命周期

**依赖：**ND04–ND08、ND09、ND21–ND23。**归属：**remote services/transport/platform。

- 保留目标发现/配置、SSH认证/主机校验/部署、WSL与Docker环境检测、server资产版本、部署锁、连接注册、workspace选择与取消。
- Agent CLI与server CLI虽都可能叫zcode，实际入口/参数/运行资源不同；文档/打包/握手不得混用。
- 同路径不同host/identity、remoteSessionId、文件/Git/终端/模型服务路由从头贯穿；网络重连不重建重复业务session。
- 主窗口不保存远端queue/snapshot；断线/关闭/失败释放连接/子进程与lease，保留旧回报guard。
- **验收：**合成远端与实际SSH/WSL/Docker代表环境，部署失败/版本不匹配/认证丢失/取消/重启/同路径隔离全部验证。
- **证据：**[remote backend](../../packages/server/src/remote/create-backend.ts)、[server HTTP](../../packages/server/src/http.ts)、[client端口](../../packages/client/src/index.ts)、[remote runtime UI](../../packages/ui/src/lib/remoteWorkspaceSessionRuntime.ts)。

### ND45 手机remote、relay、认证与replayable恢复

**依赖：**ND05、ND08、ND41、ND44。**归属：**attachment/remote services；Web UI保留。

- 手机继续使用已有Web client，连接桌面原生版已有Host attachment，不为手机另启Host/Agent/remote session。
- relay/原生Main只做认证、配对、心跳、转发/attachment调度；不得保存accepted queue、业务snapshot或复制runtime。
- 一次性host capability与长期OAuth身份区分；过期/错scope/重复attachment/owner变化fail-closed。
- replayable断连恢复、seq/epoch/快照/队列对账与桌面continuous同时测试；命令只能在恢复正确scope后执行。
- **验收：**桌面重接、手机切后台/重连、网络掉线、同路径远端、多个连接及跨Host路由不重发/串线/重复启动。
- **证据：**[host capability](../../packages/server/src/hostCapability.ts)、[Host attachments](../../packages/desktop/src/host/windowHostAttachmentRegistry.ts)、[delivery profiles](../../packages/shared/src/zcode-protocol-v4/core.ts)、[边界要求](../../AGENTS.md)。

### ND46 Scheduler、崩溃恢复、持久化与业务一致性

**依赖：**ND05–ND08、ND15、ND29、ND40、ND44–ND45。**归属：**scheduler/services/runtime。

- 在 ND08 的最小 scheduler 接入和 ND40 的到期/手动运行基础上增强跨进程故障恢复。scheduler认领与结算仍是唯一owner，窗口main路由、Host执行；不另建调度业务路径。
- 保留tasks-index事务claim、cron/offpeak状态、派发/回报/settle、retry/cancel与窗口全关/Host死亡恢复，不能另建原生定时器重复dispatch。
- 整体启动顺序：数据根/存储preparation → services/Host → attachment/协议 → admission；数据库坏/迁移失败不开放写入。
- UI布局/草稿、index、log、snapshot、journal、queue、临时文件分别恢复；不把pending optimistic恢复成accepted事实。
- **验收：**进程中断/断电代表fixture、数据库事务失败、claim孤儿、重启与迟到回报不丢输入/重复run；退出等待真实物理进程终点。
- **证据：**[scheduler](../../packages/desktop/src/scheduler/index.ts)、[Cron launcher](../../packages/desktop/src/main/desktopCronScheduler.ts)、[storage startup](../../packages/services/src/storage-startup.ts)、[tasks database](../../packages/services/src/session/tasksDatabase)。

### ND47 性能、资源所有权与后台原生化评估

**依赖：**ND07–ND46 的相关功能与交互已验收。**归属：**performance/runtime。模块可以提前采样和优化，但 ND47 的整体放行必须覆盖全部当前可达能力；B01–B03 未解决的内容不能从总占用和性能验收中排除。

- 使用[同场景合同](performance-baseline.md)测全进程树Private Working Set/Commit、UI/native/Go/JS heap、缓存字节、resident、PTY/handle、帧与输入P95/P99。
- 除聊天/终端/工作流，还要测模型与设置切换、插件目录/安装/配置、MCP状态、自动化/闲时/已保存工作流历史、请求日志/归档、模型轨迹、白板/文件树、浏览器与各类大文档的操作和关闭。不能以ND12–ND30的局部测试代替完整产品资格。
- 先证明数据/订阅/结果的必要保留，再有界缓存、按需正文与索引、隐藏绘制、idle生命周期；不能用定时GC/重启掩盖同步错误。
- 宽屏目录全量history、多个完整projection、子代理event/task结果保留、控制面/工作区process、终端scrollback是取证项，不是既定泄漏。
- 若Node成本仍大，逐模块评估Go化；必须有跨语言fixture/等价权限/恢复/依赖闭包与rollback，不一次重写Agent/工具引擎。
- **验收：**相同功能/历史/并发/窗口、至少五轮release结果；长时开关循环后无失效资源增长，活跃任务不误回收；性能数字不是空壳测量。

### ND48 正式测试、交互对照与覆盖账本

**依赖：**ND00；最终整体放行等待 ND01–ND47 完成及全部产品阻断处理。**归属：**verification。测试合同设计从 ND00 开始并贯穿所有任务，提前建立 fixture 或跑过局部回归不等于完成本任务。

- 每个ND任务写逻辑/协议/组件/native E2E/文件或网络结果，状态明确planned/passed/failed/blocked，不把文件存在当覆盖。
- Go单测、race/取消/cleanup、协议golden、MyGo无窗口view测试与真实OS输入/辅助技术/ConPTY分别建立；原版React/browser测试保留。
- 原版命令来自当前package.json和runner；原生命令在真正实现后加入，不能虚构 `pnpm test:native` 或不存在的Go统一测试脚本。
- 代表维度覆盖idle/running/held/permission、断连/换代、主/侧聊、多pane、local/remote identity、每个平台及内容引擎；不做无限笛卡尔积但不能删高风险状态。
- fixture为合成数据，真实user数据不入库；临时目录用finally清理，不终止用户生产进程，真实窗口测试需显式无干扰执行。
- **验收：**第8节全部检查；新Go/bridge已纳入架构；原版已有失败真实报告，不能修无关代码或降低断言让其通过。
- **当前入口：**`pnpm typecheck`、`pnpm lint`、`node scripts/test-desktop-regressions.mjs --list`。默认回归与显式原生About测试有不同范围，见[现有runner](../../scripts/test-desktop-regressions.mjs)。

### ND49 双版本打包、安装、更新与最终放行

**依赖：**全部accepted任务、B01–B07已处理、ND47–ND48。**归属：**release/platform。

- 原版发行不变；建立原生独立版本/产物/元数据/更新channel，不复用原版v\*触发器造成错误公开发版。
- Windows/macOS/Linux按目标范围分别打包MyGo/native库、Node sidecar与公开工具/资源；hash、许可、依赖closure、字体、数据库/终端引擎完整。
- 安装/卸载/更新/回滚不覆盖原版/数据/深链接；签名、公证/未签声明、更新可信校验与失败恢复按实际实现，不仅有build成功。
- release检查版本/源码绑定、完整多平台产物、干净机器启动、首发/历史恢复、系统集成与性能报告；不打标签、不提交/推送直到用户要求。
- **验收：**完整功能账本没有静默遗漏；blocked能力未解决不叫完整替代版；原版可独立运行并继续维护，原生版发布说明真实列出经批准的差异。
- **证据：**[原版release](../../.github/workflows/release-desktop.yml)、[bundle入口](../../packages/desktop/scripts/bundle.mjs)、[licenses](../../scripts/third-party-notices.mjs)、[发行规格](../desktop-release-ci.md)。

## 6. 设置与特殊能力的防遗漏矩阵

### 6.1 当前17个可见设置分区

| 分区ID           | 原生任务        | 必须区分                                           |
| ---------------- | --------------- | -------------------------------------------------- |
| general          | ND31、ND06–ND07 | UI草稿/setting持久化/平台副作用                    |
| appearance       | ND03、ND31      | UI字号与代码/Diff/terminal字号，系统主题与用户选择 |
| modelProvider    | ND32            | 当前custom导航、API类型、模型能力与Key             |
| modelSmartConfig | ND33            | 配置同步与GitHub登录，不上传API Key                |
| browser          | ND28            | 插件启停、浏览器数据操作与TLS scope                |
| shortcuts        | ND12、ND31      | 用户override与平台/焦点scope                       |
| memory           | ND37            | 当前生效memory根、总开关与偏好记录                 |
| subagents        | ND35、ND20      | 定义配置与运行child状态                            |
| plugin           | ND34            | 官方/个人、生命周期、抑制状态与孤立安装            |
| mcp              | ND35            | 配置、握手/status进程与执行能力                    |
| skill            | ND35            | 来源、发现、启停和scope                            |
| commands         | ND35            | 可执行能力，不等于prompt插入                       |
| promptLibrary    | ND37            | 插入文本、存储/同步与旧service能力                 |
| hooks            | ND36            | 声明启停与workspace信任/实际执行                   |
| usage            | ND38–ND39       | 应用统计、请求事实、套餐来源与额度                 |
| requestLogs      | ND38            | filter/分页/环境与完整IO留存不同源                 |
| archive          | ND38            | 跨workspace恢复/删除，关闭session与物理purge不同   |

### 6.2 隐藏、兼容与不可用项

- `automations`不再是Settings可见分区，但workspace主视图提供完整入口（ND40），不能删除。
- `workspaceFileSearch`设置隐藏，`.zcodeignore`仍生效（ND21），不恢复隐藏页面或丢规则。
- `computerUse`隐藏，当前`zcode-cua`为unavailable/fail-closed占位，不把旧桥代码当作已启用能力；保持当前失败/不可用语义，恢复功能需另立项。
- `migration`没有Settings侧栏项但保留引导/handler路径（ND42）；旧`plugins`section映射`plugin`。
- Settings引导卡、默认BigModel/Start Plan模型导航、receivePreviewUpdates写入口已移除；首次引导/既有provider执行、收费服务和已存更新通道读取不能因入口移除而一并删掉。
- Bots未implemented品牌保持未实现，不自动启用；所有平台/developer/feature gates按源码记录。

这些不是原生版可任意裁剪的功能，而是必须忠实保持的当前状态。

## 7. 关键时序与错误分支的专项任务

### 7.1 输入创建、首发与附件

```text
冻结草稿scope/模型/mode/plan/附件
  → 需要时createSession
  → create ACK分配sessionId
  → 附件上传/移交完成且scope仍有效
  → sendText(commandId)
  → admission ACK / unknown查询对账
  → 权威row与queue投影出现
  → 结算pending；按真实成功规则清草稿
```

create后send失败不能重新create；新scope、旧frame或迟到附件结果不能清当前草稿。附件的实际上传/预热先后以现有链路为准，图仅表达原子归属和成功边界。

### 7.2 权限和停止

```text
runtime生成interaction/foreground execution identity
  → 原生展示正确请求与schema
  → 用户编辑/选择（可snooze自动结束）
  → resolveInteraction / stop(expectedExecution)
  → broker校验并first-wins
  → 事件更新；UI恢复焦点
```

重复答案、已结束run、手机同时回答与新foreground出现均不能把旧结果应用到新工作。

### 7.3 终端与窗口退出

```text
隐藏/切workspace：保留PTY与资源owner，仅减少绘制
底部最后tab关闭：收起面板并保活
底部多个tab中关闭一个 / side terminal关闭：释放该实例及订阅
PTY自然退出：按对应workspace删descriptor，不关闭其他workspace的面板
真正quit：拒绝新输入 → 解除attachments → 结算/持久化 → 关闭PTY/子进程 → OS退出
```

最后tab例外来自当前源码，不是原生版新设计。不得写一个统一“关闭就kill”的dispose分支。

### 7.4 Scheduler与远控

```text
scheduler事务claim → main路由 → 原Host执行 → run回报 → scheduler settle
手机配对/认证 → 既有attachment → replay/seq对齐 → 同一CommandInbox
```

Main/relay不建第二业务队列。失效owner/lease、Host死亡、cancel/retry竞争与stale回报均需正式fixture。

## 8. 公共完成定义与最终验收

每个任务只有同时满足以下条件才能勾选完成：

- [ ] 对应spec、入口、owner、公开端口、持久化和cleanup已核实，新增/删除不与main混用。
- [ ] 所有原版动作、键盘与可见gate均有任务映射；框架默认差异已实现适配，不默认接受。
- [ ] 逻辑/协议单测、native view/native E2E及真实服务/文件结果按风险实际运行；只有源码或测试路径证据仍是未验证。
- [ ] 正常、失败、取消、切scope、断连/换代、重启及stale/重复结果均有代表断言。
- [ ] 本地与远端identity、主/侧聊、多pane、desktop/mobile语义无串线，无第二accepted queue。
- [ ] 长数据、流式选区、IME、DPI、辅助技术、PTY和文档引擎在相关平台通过。
- [ ] 隐藏/关闭/quit的行为和资源释放不同，活跃任务不会因优化误回收。
- [ ] 新Go/bridge正式测试、架构/依赖/许可纳管；现有TypeScript typecheck/lint真实通过或已有失败被明确报告。
- [ ] 视觉基线与DESIGN的token/布局/字号/overlay行为通过；不新增未经批准操作入口。
- [ ] 没有真实用户数据/凭据/内部地址泄露，没有遗留临时脚本、截图、日志或构建包。

最终完整替代版额外要求：

1. ND00账本的全部当前可达功能有原生实现与证据；没有默认为不支持的遗漏。
2. B01–B07已按用户技术/产品约束解决；任何批准差异有单独记录。未解决的浏览器/预览阻断不能藏在“完整还原”声明中。
3. 同场景release性能报告证明总占用改善，输入/滚动/发送/恢复长尾不退化；不能只测空壳。
4. 原版main与独立发行持续可用，原生版不覆盖其安装、数据和更新通道。
5. 本文规划完成与产品实现完成分开报告；未经用户要求不提交/推送/打标签/发布。

## 9. 当前验证与实施缺口

- 本轮只对当前源码入口/规则作分域盘点并生成任务书。所有ND任务为planned，没有MyGo实现或原生性能结果。
- 原版logic/browser/static render各有正式测试，覆盖范围需实现时逐体核对；目录/名称不能推断完整覆盖。
- 现有真实参考包括：[输入触发](../../packages/ui/test/promptInputTriggers.test.ts)、[引用](../../packages/ui/test/mentionMarkdown.test.ts)、[状态发送浏览器](../../packages/ui/test/statusPanelSendAutoOpen.browser.test.ts)、[编排静态渲染](../../packages/ui/test/orchestrationStatusPanelRender.test.ts)、[Git操作](../../packages/ui/test/gitPaneFileActions.test.ts)、[Git图谱浏览器](../../packages/ui/test/gitGraphFilters.browser.test.ts)、[runtime admission](../../apps/zcode-cli/packages/core/test/orchestrationAdmission.test.ts)、[runtime取消](../../apps/zcode-cli/packages/core/test/orchestrationCancellation.test.ts)、[runtime恢复](../../apps/zcode-cli/packages/core/test/orchestrationRestore.test.ts)。本轮未运行这些交互用例。
- 本轮实际执行根 `pnpm typecheck` 与 `pnpm lint`，结果在原生入口的验证记录中写明；这些仅验证原有TypeScript基线，不能代表ND48通过。
- MyGo官方组件是候选实现底座，不是ZCode交互通过证明；Node侧车、native库、外部格式引擎及浏览器后端都必须纳入依赖和性能边界。
- 受控feature graph只是发现索引，尚无原生代码，不新增不存在的Go节点；当前graph不覆盖全部上述功能，引用graph不得代替ND00账本。
