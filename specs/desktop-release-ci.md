# 桌面发行 CI 环境与重跑源码绑定

## 背景与范围

2026-11-23，`v4.0.1` 的 macOS 构建成功，Windows 在原生搜索 ZIP 解压阶段失败，导致创建 Release 被跳过。日志先出现 Windows PowerShell 调用 PowerShell 7 归档模块时的 `ExtractToDirectory` 三参数重载错误，随后才出现找不到 `ugrep.exe`。固定仓库归档包含该可执行文件，不能通过替换归档、关闭校验或随意降级 Node 解决。

发行环境修复与后续永久修复均不修改已发布 Git 标签指向、不改运行时业务代码、不更改版本号或强制升级标记。Windows ZIP 解压的永久修复落在所有发行入口共用的预构建归档适配器，不能只依赖工作流中的环境清理。

## 产品和发布规则

1. 正式 Release 需要 Windows x64 与 macOS arm64 两平台完整安装包和更新元数据；单个平台成功只代表构建产物存在，不代表版本已经发布。任一构建失败时继续保留原有 Release gate。
2. 推送标签按该标签构建。手动 `workflow_dispatch` 使用当前选择的工作流定义，但 build 和 release 两个 job 都显式检出输入的已有发行标签；版本校验和强制升级标记也从该标签读取，不能用 main 的源码冒充旧标签安装包。
3. 同一标签的 push 和手动重跑共用并发分组，不取消正在执行的构建；不混用不同运行的产物。
4. Windows 的构建命令使用 Bash 作为外层 shell。重打旧标签时仍保留 Windows PowerShell 自带模块环境准备，避免旧源码的 Expand-Archive 加载 PowerShell 7 模块；该兼容步骤不替代新源码的解压修复。
5. `scripts/prebuilt-binary-extract.mjs` 是预构建归档解压的唯一适配器。Windows ZIP 使用 Windows PowerShell 5.1 可用的 System.IO.Compression.ZipFile 两参数接口，不调用 Expand-Archive，不读取 Archive 模块。启用停止型错误并传播非零退出；损坏归档、解压失败、缺二进制或验证失败不能继续查找、拷贝或发布。读文件、临时目录与拷贝使用异步 IO；SHA-256 和架构校验必须在正式覆盖之前完成，所有出口清理独占临时目录。
6. GitHub Action 自身均使用已核验的 Node 24 版本，包括 Release 创建 Action；项目 Node 24.14.0 与 pnpm 10.33.2 保持不变。正式 YAML 回归枚举所有 Action，未知或不受约束的第三方版本必须失败，不能漏检最后一个 Action。Action 的运行时警告与项目构建版本是两种不同配置。
7. 修复 CI 定义后，使用 main 上的新工作流手动构建原 `v4.0.1` 源码；原标签和版本提交保持不变。不强推标签，不创建只有 macOS 产物的不完整正式版本。
8. 下一次含本修复的新标签，在安装依赖后、bootstrap 与打包前执行发行环境和真实原生工具归档回归。手动重打不含该测试入口的旧标签明确记录跳过；不从 main 覆盖旧标签产品脚本。提交前门禁执行同一正式测试入口。
9. GitHub Actions 依赖通过每周 Dependabot PR 提醒维护。仓库当前没有 PR 触发的 CI，因此合并这类 PR 前必须本地执行与门禁一致的发行回归、类型、Lint 与架构检查（`pnpm verify:pre-push` 已包含发行回归）。不因依赖更新自动打标签、创建 Release 或定时发布。
10. 桌面正式回归入口按组及文件串行执行（Node `--test-concurrency=1`），避免多个独立 Vite / Chrome 冷启动争抢 CPU 后让首个真实交互场景超时；不增加场景超时、不过滤测试、不跳过浏览器或 Windows 原生采样检查。既有用例全部保留，`pnpm verify:pre-push` 使用同一个运行器。

## 所有者与顺序

```text
发行标签（源码/版本/强更声明的唯一来源）
  ├─ push：该标签的工作流定义
  └─ 手动重跑：所选 ref 的新工作流定义 + 显式检出发行标签
                         │
                         ▼
Windows：旧标签模块兼容 → 冻结依赖 → 发包回归 → bootstrap → 打包
macOS：冻结依赖 → 发包回归 → bootstrap → 打包
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
- 桌面回归运行器测试校验每组 Node 测试参数包含 `--test-concurrency=1`，原有正式测试列表和按组串行执行不变，保持 `--experimental-test-module-mocks` 与各组 `TSX_TSCONFIG_PATH`；任一失败仍停止门禁。
- Windows 上模拟继承不兼容 Archive 模块：先复现旧 Expand-Archive 错误，新解压器在不清理 PSModulePath 的条件下直接成功；另保留旧标签环境准备路径的回归。路径覆盖空格、单引号和中文，运行目录全部放系统临时目录并 finally 清理。
- 损坏 ZIP 和缺文件路径：立即失败、不进入二进制验证、不覆盖已有正式文件；SHA-256 不匹配和可执行架构错误也保留目标文件。并发解压使用独占临时目录；成功与失败都清理。
- 读取仓库固定原生工具计划和全部目标归档，校验 SHA-256；各 runner 在新系统临时目录完整准备自身目标两次，第二次复用验证后的缓存，执行 ugrep / ripgrep 等工具版本检查。无网络下载、无真实用户数据。
- 原发行标签 SHA 与版本提交在修复前后不变。手动运行两平台均成功，最终 Release 必须包含 EXE、DMG、ZIP、latest.yml、latest-mac.yml、blockmap 与 force-update.json。
- 正式入口：`pnpm test:release`（`node --test scripts/release-desktop-ci.test.mjs scripts/native-search-tools.test.mjs`）；发布工作流和 `pnpm verify:pre-push` 都执行它。实际执行根 `pnpm typecheck`、`pnpm lint` 和 `pnpm architecture:check --changed`。
