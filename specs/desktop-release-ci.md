# 桌面发行 CI 环境与重跑源码绑定

## 背景与范围

2026-11-23，`v4.0.1` 的 macOS 构建成功，Windows 在原生搜索 ZIP 解压阶段失败，导致创建 Release 被跳过。日志先出现 Windows PowerShell 调用 PowerShell 7 归档模块时的 `ExtractToDirectory` 三参数重载错误，随后才出现找不到 `ugrep.exe`。固定仓库归档包含该可执行文件，不能通过替换归档、关闭校验或随意降级 Node 解决。

本次只修复发行环境与工作流控制面，不修改已发布 Git 标签指向、不改运行时业务代码、不更改版本号或强制升级标记。

## 产品和发布规则

1. 正式 Release 需要 Windows x64 与 macOS arm64 两平台完整安装包和更新元数据；单个平台成功只代表构建产物存在，不代表版本已经发布。任一构建失败时继续保留原有 Release gate。
2. 推送标签按该标签构建。手动 `workflow_dispatch` 使用当前选择的工作流定义，但 build 和 release 两个 job 都显式检出输入的已有发行标签；版本校验和强制升级标记也从该标签读取，不能用 main 的源码冒充旧标签安装包。
3. 同一标签的 push 和手动重跑共用并发分组，不取消正在执行的构建；不混用不同运行的产物。
4. Windows 的构建命令使用 Bash 作为外层 shell。调用 Windows PowerShell 5.1 的仓库解压器前，将 PSModulePath 明确绑定到 Windows PowerShell 自带模块目录，并验证 Microsoft.PowerShell.Archive 可加载；不能把 PowerShell 7 的模块注入 5.1。该环境通过 GITHUB_ENV 传递到后续安装、bootstrap 和打包命令。
5. 环境准备脚本显式启用停止型错误。环境校验失败立即终止，不进入原生工具查找、拷贝或安装包发布步骤。原 SHA-256、架构及安装包依赖验证全部保留。
6. GitHub Action 自身升级到已核验使用 Node 24 的官方版本；项目 Node 24.14.0 与 pnpm 10.33.2 保持不变。Action 的运行时警告与项目构建版本是两种不同配置。
7. 修复 CI 定义后，使用 main 上的新工作流手动构建原 `v4.0.1` 源码；原标签和版本提交保持不变。不强推标签，不创建只有 macOS 产物的不完整正式版本。

## 所有者与顺序

```text
发行标签（源码/版本/强更声明的唯一来源）
  ├─ push：该标签的工作流定义
  └─ 手动重跑：所选 ref 的新工作流定义 + 显式检出发行标签
                         │
                         ▼
Windows：匹配 PowerShell 模块环境 → 冻结依赖 → bootstrap → 打包
macOS：冻结依赖 → bootstrap → 打包
                         │
                         ▼
同一次 run 两平台上传成功 → Release job 检出同一标签
                         │
                         ▼
完整安装包、更新元数据和强更声明公开发布
```

CI 环境仅属于当前 runner，不保存应用/会话状态，也不修改标签源码。构建元数据仍能回溯到发行标签对应的真实提交。

## 验收与测试

- YAML 回归校验两个 checkout 的标签绑定、并发分组、Windows 外层 Bash、PowerShell 环境准备顺序、固定工具链和已核验的 Action 版本。
- Windows 上模拟继承不兼容 Archive 模块：先复现旧 Expand-Archive 的非终止错误，再运行工作流环境准备脚本，使用仓库原解压器成功读取 ZIP 中的嵌套文件。路径覆盖空格、单引号和中文，运行目录全部放系统临时目录并 finally 清理。
- 原发行标签 SHA 与版本提交在修复前后不变。手动运行两平台均成功，最终 Release 必须包含 EXE、DMG、ZIP、latest.yml、latest-mac.yml、blockmap 与 force-update.json。
- 正式入口：`node --test scripts/release-desktop-ci.test.mjs`；实际执行根 `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed`。
