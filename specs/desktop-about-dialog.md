# Desktop About Dialog — 同窗口关闭与白闪修复

## 问题与范围（2026-11-24）

Windows 自绘 About 过去创建 `transparent:true + modal:true` 的独立 BrowserWindow。点击确定后销毁子窗口并恢复 Acrylic 父窗口的 native enabled/focus，用户报告偶发白色闪帧。源码与安装包路径已确认，尚未将白帧归因为显卡、系统主题或某一 Chromium 缺陷。修复移除整个独立透明 modal 边界，而不是追加定时重绘或重启 renderer。

## 产品规则

- 保留 `DesktopCommandIds.ShowAbout`。工作区/设置页帮助入口与 macOS 原生菜单都经同一 command 发出打开请求，不增加另一条 UI 写入路径。
- About 使用当前主 renderer 中的共享 Dialog；不创建 About BrowserWindow，不禁用父 native 窗口，不切换窗口材质、全局主题或会话状态。
- 内容仍为 ZCode 品牌图标、`ZCode Desktop App`、真实 app 版本、版权年份与 Apple Silicon 条件文案。中英文随窗口 intl，明暗随当前 renderer 主题；不另维护主题副本。
- 确定/OK、Enter、Escape 关闭；不新增 X 按钮或点击外部关闭语义。关闭完成后恢复有效的 DOM 焦点，帮助菜单和会话输入立即可用。焦点恢复不调用原生 window focus。
- 同一 renderer 重复打开是 ensure-open，不 toggle，不产生多个弹窗。关闭时保留内容直到退出动画结束，避免先清空内容露出空白。
- 弹窗在数据库启动画面、设置页和无 workspace 状态也可打开。bootstrap 与业务 Root 使用同一稳定 About host，不依赖 Host、Agent、登录或业务服务已准备。
- main 只发布最小展示数据（`appVersion`、`optimizedForAppleSilicon`），不发布 hostname、路径、日志、凭据等 diagnostics 信息。现有 `createAboutSnapshot` / 日志导出仍保留。

## 所有者与接口

- **唯一展示 owner**：UI `AboutDialogHost` 的窗口内 React 状态。只存 open 与最近展示 payload，不进 Zustand/服务端持久化。
- **事实 owner**：Electron main 的 app 版本和平台条件。`ShowAbout` 通过 `OpenAboutDialog` platform IPC 发给目标主 renderer。
- **平台契约**：共享严格 schema `DesktopAboutDialogPayload`；`IPlatformService.onOpenAboutDialog` 可选订阅，Desktop preload 校验后转发，Web 不实现。UI 仅通过平台接口，不访问 `window.zcode`。
- **早到请求**：preload 未有订阅时保留一个尚未消费的 payload；首次订阅消费即清空。重复请求覆盖单槽，dispose 精确移除 listener；不永久回放已关闭弹窗。
- **目标窗口**：优先有效的 command sender 主窗口，其次 focused 主窗口，再其次现有主窗口；辅助资源窗口不是 About owner。不广播。无主窗口时复用现有 primary-window coordinator，不另立窗口生命周期 owner。
- command 返回仅表示已发布打开请求，不等待用户关闭，不新增 close ACK 或 main open 状态。
- 此接口属于 platform IPC，不改 Agent stdio 协议、session queue、workspace identity、desktop-continuous 或 web-remote-replayable 语义。

```text
Help / macOS menu → ShowAbout command → main 选择主 renderer、构造最小 payload
                                             ↓
                                OpenAboutDialog（平台 IPC）
                                             ↓
                              preload 校验、未消费单槽
                                             ↓
                     IPlatformService → AboutDialogHost（唯一展示 owner）
                                             ↓
                             同文档 Dialog / 当前主题
                                             ↓
                     OK / Enter / Escape → DOM 关闭、恢复 DOM 焦点
```

## 验收与证据

1. 正式测试验证 payload 校验、真实版本/平台、目标窗口选择、未订阅单槽消费、重复打开与 disposer。
2. 真实 UI / Electron 隔离测试覆盖中英文、浅/深色、普通/最大化窗口，依次以 OK/Enter/Escape 反复关闭。各次仅一个 Dialog，主 BrowserWindow 数量、enabled、bounds、webContents、导航计数保持不变。
3. 打开期间背景不可交互，外部点击不关闭；关闭后帮助按钮、输入框可交互，焦点回到仍存在的原控件。
4. startup → Root 切换期间不丢掉已打开 About；无 workspace、设置页及多个窗口的请求保持窗口隔离。
5. Windows 白闪验收使用隔离 Acrylic Electron fixture 的 OS 屏幕采样，不把 CDP/page screenshot 当成 DWM 证据。worker 唯一拥有 GDI handles 与累计统计，只采指定 native window 的物理内容 ROI；以每 4 像素采样的 RGB 均 ≥250、近白比例 >0.8 判定大面积白帧。`DwmFlush` 按实际桌面刷新采样并记录帧数/间隔；窗口被遮挡或 ROI 归属不明时失败，不抓生产窗口。先用 ≥100ms 的合成全白覆盖校准必须检出，再观察暗色正常/最大化窗口关闭前后 0 白帧。只返回数字不保存图。不能将有限次数无闪帧称为所有机器绝对保证。
6. Electron profile、Vite root/cache、构建 fixture、日志/截图全部在系统临时目录，由 `finally` 清理；不启动、重启或改写当前生产 app。

## 验证入口（2026-11-25）

About 单元回归继续进入默认桌面门禁；需要真实窗口、置顶和无遮挡桌面的 Electron/OS 采样改为显式 `pnpm test:desktop-native`。日常与 About 无关的改动不反复执行该场景。未使用的 fixture 原生命令按钮删除，真实主侧 `invokeCommand()` 验证保留。旧运行记录不代表当前默认门禁仍包含原生采样。

## 已执行验证（2026-11-24）

- 正式入口 `pnpm test:desktop-regressions` 最后一轮完成：107 passed、0 failed、1 非 Windows 分支 skipped。该入口同时纳入 About 与会话速度回归，并接入 `verify:pre-push`。
- 隔离 Electron 41.0.3 的中英文 × 明暗主题共 124 次 OK/Enter/Escape 关闭：只保留一个 BrowserWindow，无新增导航，主窗口 ID/webContents/bounds/enabled 保持不变，DOM 焦点恢复、输入可用。
- Windows 原生屏幕校准检出 7 个近全白帧；暗色普通窗口 30 次关闭采到 648 帧、最大化窗口 30 次关闭采到 550 帧，均为 0 白帧。物理内容中央 90% 区域保持 HWND 遮挡检查，采样间隔实际约 34ms / 43ms，最大间隔约 74ms / 81ms；这是此次机器上的有界屏幕采样证据，不是每次 DWM present 或所有机器的保证。
- 独立复核发现的 await 期间窗口销毁与隐藏/最小化 fallback 主窗问题已修复，并有正式回归覆盖；复核未再发现 blocker。
- `pnpm typecheck`、`pnpm lint`（69 warnings、0 errors）、`pnpm architecture:check --changed`（0 violations）、发行与已有 upstream 回归通过。曾尝试的完整 Desktop main/preload/renderer 额外类型工程有存量错误；本次正式测试工程及根门禁通过，不将该额外检查写成通过。
- 未重启、替换或更新正在运行的安装版；临时 fixture/profile、缓存与解压 runtime 已清理。修复落在源码，安装版需使用包含本次源码的构建。

## 不做的改动

不更改共享窗口材质/透明根背景，不加 modal-close 超时重绘，不关闭硬件加速，不新建主进程业务状态；不复原旧原生 message box 或双平台回退链路。旧 About HTML generator 无调用后清理其生产引用与过时说明。
