# ZCode Native（MyGo）

## 当前状态

这是原生重构版的准备入口，不是可运行应用。

- 技术方向：MyGo / Go 原生 UI，工作台不使用 WebView。
- 当前分支：`native/mygo`。
- 当前工作目录：`F:/Han/demo/test01/ZCode`。
- 原版 worktree：`F:/Han/demo/test01/ZCode-classic`，分支 `main`；原版提交、源码与发行流程保持不变。
- 基线：ZCode 4.1.3，`f78689fd243dc02be37e38d6b34afa2137bdb4ac`。
- 本目录当前只包含说明。没有 `go.mod`、MyGo 依赖、窗口实现、协议适配、Go 测试或原生安装包。

## 规格与阶段

- [完整重构任务书：50 项功能与交互还原任务](../../specs/native-desktop/reconstruction-tasks.md)。
- [双版本、数据隔离与状态所有者](../../specs/native-desktop/README.md)。
- [交互对等清单](../../specs/native-desktop/interaction-parity.md)。
- [同场景性能基线](../../specs/native-desktop/performance-baseline.md)。

准备完成后，按总规格的阶段推进：框架资格验证、协议兼容薄片、交互迁移、生命周期/内存优化、独立双版本发行。当前没有承诺浏览器/复杂预览的替代方案，也没有实测内存收益。

## 工具链准备

2026-11-27 核对本机：

| 工具 | 实际版本             | 结论                                    |
| ---- | -------------------- | --------------------------------------- |
| Node | 24.14.0              | 与根 `mise.toml` 一致                   |
| pnpm | 10.33.2              | 与根 `mise.toml` 一致                   |
| Go   | 1.26.4 windows/amd64 | 低于候选 MyGo v0.10.0 的 Go 1.27.3 要求 |

后续 Go 模块固定 MyGo 版本，并通过独立、受控工具链验证；不升级全局 Go 来影响原项目。原生终端需要 Ghostty native library，版本、hash、许可和 Windows ConPTY/关闭行为必须一并核验。“无 cgo”不等于没有 native 依赖。

本轮不运行 `mygo init`，不下载 MyGo/Go 工具链，不创建原生运行命令。官方能力目前只作为资格验证候选，不能当作本项目已实现的功能。

## 原版与原生分支的操作边界

在任一目录执行写入前先检查：

```sh
git branch --show-current
git status --porcelain -uall
git worktree list
node scripts/check-workspace-freshness.mjs
```

这些是真实 Git 与仓库命令。现有根 `pnpm typecheck` 和 `pnpm lint` 检查 TypeScript 基线，不包含尚未建立的 Go 应用。后续原生构建/测试入口只有在实际实现并纳管后才添加，不能把 `pnpm dev:desktop` 标成 MyGo 启动命令。

- 不在 `main` 修改原生产品；也不自动合并、提交或推送。
- 不复制原版用户数据库、凭据、真实历史作为 fixture。
- 兼容阶段仍可能保留 Node Agent/Host 适配成本；不是一开始就全栈改为 Go。
- 不用简化输入、关闭后台任务、丢弃历史或去掉 owner/lease 来换低占用。

## 官方资料

- [MyGo](https://mygo.run/zh)。
- [v0.10.0 源码与发行说明](https://github.com/egoist/mygo/releases/tag/v0.10.0)。
- [原生 UI](https://github.com/egoist/mygo/blob/v0.10.0/docs/ui/README.md)。
- [流式 Markdown](https://github.com/egoist/mygo/blob/v0.10.0/docs/ui/markdown.md)。
- [终端](https://github.com/egoist/mygo/blob/v0.10.0/docs/plugins/terminal.md)。

示例、框架基准和本项目的交付结果分开记录。

## 准备验证记录（2026-11-27）

- 当前项目已切换到 `native/mygo`；`main` 保留在 `ZCode-classic`，分支引用仍为上述基线提交，原版工作树无 tracked/untracked 改动。
- 当前 `native/mygo` 工作目录执行 `pnpm typecheck` 通过。最初新建工作目录缺少 `@zcode/dynamic-workflow` 的 `dist` 声明，曾出现 TS2307 和连带类型错误；切回已有完整依赖/构建环境后通过，没有为此修改 TypeScript 源码。全新环境仍需按该包的实际 `build` 入口准备生成声明。
- `pnpm lint`：0 errors / 69 个既有 warnings。
- 初次准备的四份 Markdown 格式和 14 个本地链接已验证。完整任务书补齐后，五份 Markdown 的定向 `oxfmt --check` 通过；212 个本地源码/文档链接存在，50 个任务编号无重复或缺失，显式任务依赖无环。
- 移动工作目录后的 pnpm 链接已从本地缓存重新生成；只清理本轮新工作目录类型检查产生的 `dist`、`out` 和 `*.tsbuildinfo`，保留既有目录与开发依赖。
- 没有执行 MyGo 构建、原生交互、性能采样或完整发行回归；没有升级 Go、启动应用、提交或推送。原生交互与性能仍为 planned。
