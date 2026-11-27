# 原生工作台交互对等清单

## 目标与证据等级

本清单属于 [双轨规格](README.md)，对齐 ZCode 4.1.3 基线。目标是相同动作得到相同展示、命令、身份和生命周期结果，不是照搬 MyGo 默认操作。完整任务分工、源码来源和放行条件见 [重构任务书](reconstruction-tasks.md)。

- **accepted**：需要保留的产品行为，后续以当前源码和 fixture 细化验收。
- **undefined**：尚需确定等价实现或产品取舍，不允许静默删除或用弱化方案顶替。
- **planned**：原生验证尚未实施。当前没有 MyGo 单测、原生 E2E 或真实系统输入法结果。
- 原版纯函数测试、React 静态渲染和浏览器组件测试各证明不同层面，均不等于原生版已通过。

## 所有者与验收顺序

```text
输入、鼠标、系统剪贴板 / 输入法
       │
       ▼
原生 UI 草稿、引用、选区、焦点、布局
       │ 用户动作 + workspace/session identity
       ▼
适配端口 → Host owner/lease → CLI CommandInbox
       │                         │
       │                         └─ accepted 状态、事件与持久化
       ▼
原生只读投影对账 → 展示、焦点 / 滚动恢复
```

每个用例分别断言 UI 与权威结果。不能只看截图，或只收到一个 ACK 就认为状态对等；操作过程中切换 workspace/session、断连或运行时换代时也必须正确。

## 代表验收场景

全部原生验证为 **planned**。表中的已有测试只是原版证据，不表示本轮执行。

| 范围与状态                     | 设置与动作                                                                         | 必须断言                                                                                                                   | 原版所有者 / 已有证据                                                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 输入法与发送：accepted         | 中文组合输入，按 Enter 选词；再执行当前发送绑定                                    | 组合阶段不发送；提交后只产生一次输入；Shift+Enter/自定义键位保持规则                                                       | `LexicalChatInput.tsx`、`shortcuts/composerShortcuts.ts`；原生 IME 验证缺失                                                 |
| 引用与触发符：accepted         | `/`、`@`、`$`、`#`、`;` 及已有全角兼容；选择候选、删除、复制、撤销                 | 类型和身份保留，候选只替换当前 token，不吞正文；不把标签降为无语义文本                                                     | `mentions/promptSerialization.ts`；`test/promptInputTriggers.test.ts`、`test/mentionMarkdown.test.ts`                       |
| 附件与草稿：accepted           | 粘贴文本/图片、拖文件；上传时切 session 或取消                                     | 原草稿/附件不进入新 session；取消停止读取与上传；权限和限额不绕过                                                          | `v4/attachmentUploadTransaction.ts`、composer/attachment 现有端口；原生取消验证缺失                                         |
| running 输入与停止：accepted   | 会话运行时再发送；编辑/取消队列项；停止当前工作                                    | accepted 输入归 CLI；UI 不独立维护权威队列；用户重排通过 CLI 命令提交并按事件对账，不重复提交                              | `v4/pendingCommandRegistry.ts`、CLI `command-inbox.ts`                                                                      |
| 审批与计划：accepted           | 权限/提问/计划弹层打开，切换焦点、提交或取消                                       | 只回答对应请求；迟到结果不写新会话；键盘焦点和恢复合理；不新增第二发送入口                                                 | `v4/SessionPane.tsx` 与当前协议交互模型                                                                                     |
| 流式阅读与选区：accepted       | 回复增长时向上滚动、选取旧文、复制；跳到底部                                       | 主动阅读不被拉回；选区稳定；复制跨段内容正确；代码/表格没有破坏性闪动                                                      | `v4/ConversationTimeline.tsx`、`timelineScrollAnchor.ts`、`conversationProjectionStore.ts`                                  |
| 历史分页与恢复：accepted       | 冷开长 session，向上加载、查找、返回；订阅换代                                     | 游标/epoch 校验；旧分支不复活；目录不能只显示尾窗；不因省内存丢历史                                                        | `v4/sessionDataLayer.ts`、`conversationProjectionStore.ts`；原生恢复验证缺失                                                |
| 工作台拖拽与分屏：accepted     | 调整 pane，拖 task/session 到另一组，取消拖拽，关闭焦点 pane                       | 布局和 session 归属正确；焦点只落有效 pane；取消不提交；关闭视图不停止任务                                                 | `v4/workbenchDragDrop.ts`、`workbenchPointerDragDrop.ts`、`paneLayoutStore.ts`                                              |
| 快捷键与覆盖层：accepted       | 编辑输入时触发全局键；对话框打开时触发 pane 键；重绑发送键                         | 输入操作优先，焦点 scope 正确；覆盖层阻断背景危险操作；菜单与键盘只有一次执行                                              | `shortcuts/`、`v4/SessionPane.tsx`；不能以框架默认焦点规则替代                                                              |
| 终端保活与释放：accepted       | 两个 PTY；切 workspace、折叠面板；关闭非最后底部 tab、最后底部 tab 和侧栏 terminal | 切换/折叠保活；最后底部 tab 关闭只收起面板；非最后底部 tab 与侧栏 terminal 关闭释放正确实例；PTY 退出按所属 workspace 清理 | `Terminal.tsx`、`terminal/terminalPanelState.ts`、`terminal/TerminalSession.tsx`、`sidePaneTerminalSessionRegistry.ts`      |
| 终端输入与权限：accepted       | 中文输入、宽字符、emoji、选区、粘贴、OSC 52、链接                                  | 组合定位、字宽、粘贴协议与权限符合原产品；浏览器/系统打开路径仍受安全规则限制                                              | `terminal/terminalLinks.ts`、`TerminalSession.tsx`；MyGo Ghostty 需真实 ConPTY 验证                                         |
| 状态、子代理与工作流：accepted | 发送、展开/关闭状态面板，查看子会话、修订/停止 run、恢复产物                       | 同一 run/session 归属、revision 与终态正确；关闭面板不丢任务；结果仅展示投影                                               | `test/statusPanelSendAutoOpen.browser.test.ts`、`test/orchestrationStatusPanelRender.test.ts`、CLI orchestration 测试       |
| Git 与代码：accepted           | 按当前会话文件范围查看变更，选择/复制 Diff，执行现有 Git 动作                      | 不扩大写入范围；模型选择与会话模型独立；预览不是提交；原生工具动作不绕权限                                                 | `test/gitPaneFileActions.test.ts`、`test/composerModelSelectionPort.test.ts`、`test/gitToolsPanelAlignment.browser.test.ts` |
| 远端与手机重连：accepted       | 相同路径但不同 identity；断连恢复，跨 Host 切换                                    | 隔离 key 正确；remoteSessionId 贯穿；复用 attachment/runtime；两种 delivery 语义不混用                                     | `lib/remoteWorkspaceSessionRuntime.ts`、`v4/transport.ts`、Host connection scope                                            |
| 设置、模型和插件：accepted     | 切主题/语言，改模型，安装/启停/卸载插件，重启                                      | 保留唯一持久所有者，广播不回环；目录语义遵守 `CONTEXT.md`；不随重构改默认行为                                              | 当前 settings/services；`test/modelProviderApiFormat.browser.test.ts`、`test/promptLibrarySettings.test.ts`                 |
| 系统集成与可访问性：accepted   | DPI变化、多窗口、文件拖入、托盘、通知、屏幕阅读器                                  | Windows 首测，macOS/Linux 分别验证；文本可访问、焦点可见；不得静默覆盖原安装/数据                                          | `packages/shared/src/platform.ts`；原生 MyGo 验证缺失                                                                       |
| 内置网页和元素选取：undefined  | 导航真实网页、点选 DOM 加入聊天、Agent 控制同页                                    | 无浏览器引擎时不存在直接等价实现；外置/截图流/删除均未获批准                                                               | `browser-use/UnifiedBrowserView.tsx`、Electron CDP guest                                                                    |
| 复杂内容预览：undefined        | PDF/DOCX/PPTX/Mermaid/公式；搜索、复制、元素引用、缩放                             | 除显示外逐项验证语义；图片替代不算完整功能对等；确认渲染引擎和许可                                                         | 当前 `previewPane*`、`presentation/`、`components/ai-elements/mermaid-block.tsx`                                            |

上述相对 UI 路径均位于 `packages/ui/src/`，`test/` 位于 `packages/ui/test/`。协议与 runtime 路径需从 [总规格](README.md) 的当前公开入口继续核对。

## 已有验证入口与缺口

- 根 `pnpm typecheck` 与 `pnpm lint` 是必须门禁，不等于运行交互用例。
- `node scripts/test-desktop-regressions.mjs --list` 仅列出已登记测试，不启动窗口。
- 当前功能组为 `about / performance / context / git / status`。选择测试必须以真实清单为准；没有统一的原生 Go E2E 或“运行全部 UI 测试”脚本。
- 默认 `pnpm test:desktop-regressions` 含逻辑/React 浏览器回归，但不默认启动 About Electron/OS 采样；`pnpm test:desktop-native` 会开真实窗口，不能在准备阶段或日常后台工作中顺带执行。
- `packages/ui/test/orchestrationStatusPanelRender.test.ts` 是 React 静态渲染；`statusPanelSendAutoOpen.browser.test.ts` 使用真实 React SessionPane 与浏览器 fixture。两者都不能证明 MyGo 的 IME、鼠标选区或原生拖拽正确。
- CLI `orchestrationAdmission.test.ts`、`orchestrationCancellation.test.ts`、`orchestrationRestore.test.ts` 等证明原 runtime 规则。迁移时保留这些规则，但另需跨语言命令、事件和原生 UI 对账证据。
- 本轮不新建一次性测试脚本或伪造 Go 测试入口。正式原生用例在 P1/P2 实现阶段纳入类型/构建和实际执行。

## 维度裁剪与放行

1. 原生桌面首先验证 Windows x64；macOS、Linux 和不同 DPI/输入法为后续平台门禁，不由单平台结果代替。
2. busy/running、权限等待、队列非空、断连、runtime 换代、关闭视图分别保留代表场景，不只覆盖 idle 成功路径。
3. 本地 path fallback 与远端 identity 是不同身份维度；同路径不同 Host 的场景不能裁掉。
4. 非焦点 pane 不消费焦点快捷键，是明确裁剪规则，不是没有键盘测试。
5. 隐藏视图可以不排版/不绘制，但已接受的命令和正在运行的 terminal/session 不能裁掉。
6. undefined 项是发布阻断边界，不视为“暂不测试所以通过”。所有 accepted 场景通过且差异明确后，才能标为交互对等。
