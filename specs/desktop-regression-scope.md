# 桌面回归：按功能选择与原生屏幕测试边界

## 背景

2026-11-25，上下文来源增加“子代理”时无条件执行完整 `verify:pre-push`，触发与该功能无关的 About Electron 回归。该用例反复开关真实窗口、置顶并执行 OS 屏幕采样；当其他窗口覆盖 ROI 时按既有安全规则失败。用户要求停止反复运行无关测试并清理未使用内容。

问题是验证入口的范围和干扰边界，不是已上线功能的所有回归都失去价值。保留有效断言，清理已确认没有调用的 fixture 控件，不通过删除防回归断言掩盖失败。

## 规则

1. `pnpm test:desktop-regressions` 默认执行现有单元和 headless 浏览器回归，不启动需要用户桌面的 About Electron/OS 采样用例。
2. `--suite <name>` 或 `--suite=<name>` 只选对应功能，支持重复指定多个功能，保持原分组、文件顺序和 `--test-concurrency=1`。功能为 `about / performance / context / git / status`。
3. `pnpm test:desktop-regressions --suite context` 用于本次上下文浮层验证；日常代码验证选择相关测试并执行必要的类型、Lint 和架构门禁，不把提交前全量门禁当作每次编辑的必经步骤。
4. `pnpm test:desktop-native` 显式选择 About 与原生采样场景。运行前输出真实窗口/置顶/无遮挡桌面要求；不在日常默认或 `verify:pre-push` 中暗中启动。
5. `--list` 只打印选中的项目与文件，绝不启动浏览器、Electron 或测试进程。未知选项、未知功能和缺失参数失败，不能静默回退到全量。
6. 完整非原生测试、类型检查以及原生测试断言继续保留；不降低采样遮挡检测、不增加超时、不将原生检查替换成截图。原生测试保持显式按需入口及类型检查。
7. About fixture 的 `native-menu-about` 按钮没有测试调用，删除控件和仅供它使用的 import。真实原生命令由 Electron 主侧的 `invokeCommand()` 验证，不依赖该按钮。
8. 测试编排仍由现有 `scripts/test-desktop-regressions.mjs` 单一拥有，不建立另一个测试目录或重复清单。筛选结果共享给运行器单测和发行入口回归。

## 验收

- 默认清单保留全部非原生已登记文件，且不包含 `aboutDialog.browser.test.ts`。
- About 显式原生入口包含该文件，默认 About 功能只包含相关非原生断言。
- Context 功能仅选择上下文浮层浏览器回归，不能顺带打开 About、Git 或状态面板 fixture。
- 所有功能并集与默认清单一致，显式原生并集与原登记清单一致，文件不重复执行。
- `--list`、参数错误路径及筛选逻辑由正式 Node 测试覆盖；测试入口自检不启动真实桌面窗口。
- About 未使用按钮删除后仍保留帮助菜单与 native command 断言。
- 实际运行筛选入口测试、相关 context/runtime 回归、`pnpm typecheck`、`pnpm lint`、架构检查。旧全量门禁的原生遮挡失败如实记录，不称为全量通过。
- 检查无任务遗留的 Electron/Chrome/Node fixture 进程及系统临时目录；不终止用户生产进程。
