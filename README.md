# ZCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

> **macOS 启动提示「已损坏」？** 发行包未签名，首次打开可能被 Gatekeeper 拦截。执行以下命令清除隔离属性后再打开：
>
> ```bash
> xattr -cr /Applications/ZCode.app
> ```

## 更新

- 2026-10-20：更新至 ZCode v3.18.6 版本，修掉打包失败的问题——v3.18.5 因此没能生成安装包，功能内容与 v3.18.5 相同（见下条），装到 v3.18.6 即可。
- 2026-10-20：更新至 ZCode v3.18.5 版本，「同步配置」支持项目级：子智能体与 MCP 服务器在设置页切到某个项目分区后，可以单独上传/下载该项目的配置，用的是带项目名的独立 Gist（如 `zcode-subagents-config-sync:ZCode`），与用户级配置互不干扰，状态行会显示当前作用在哪个项目；项目级下载会写进项目目录下的 `.zcode/agents` 与 `.zcode/config.json`，应用前自动备份、可从备份还原（同名文件夹的项目会共用一份 Gist）。子智能体的颜色标记从 12 色扩到 16 色（新增深红、深绿、深蓝、深紫），已被自建子智能体用过的颜色会打上圆点，方便新建时避开重复，标记只提示不限制选择，内置子智能体即使占了颜色也不参与统计。归档管理页的项目下拉不再列出「外部已被移除、且当前工作区没有归档记录」的项目。
- 2026-10-19：更新至 ZCode v3.18.4 版本，修掉「同步配置」里上传到 GitHub 私有 Gist 必定失败的问题——子智能体、MCP、模型设置三处上传此前都会停在「同步失败：HTTP 422」，现在可以正常上传了。同时把 GitHub 返回的校验原因一并显示出来，失败时不再只有一句状态码。
- 2026-10-18：更新至 ZCode v3.18.3 版本，「模型设置」现在也能同步到 GitHub 私有 Gist：在模型设置页右上角的「⋯」菜单里上传或下载，供应商、模型列表与调序、模型参数、默认模型选择都会同步，各用一份独立 Gist，与子智能体、MCP 的同步互不干扰。**API Key 不会上传**，下载也不会覆盖本机已有的 Key，换新机器时需要重新填写；下载同样是先给出变更计划再确认，默认只增不删、可显式选择镜像远端，应用前自动备份，也能从本地备份还原。
- 2026-10-18：更新至 ZCode v3.18.2 版本，「同步配置」的下载在应用前会把本地配置整份备份，现在可以直接在设置页的「⋯ → 从备份还原…」里挑一份还原回来：还原前会再给当前状态备份一次，选错可以再还原回去；列表里能看到备份目录路径与每份的条目数，备份最多保留 10 份、超过 30 天自动清理。另外同步的元数据与备份改为跟随设置里的「数据存储路径」，自定义数据目录后不再固定写在 ~/.zcode 下。
- 2026-10-17：更新至 ZCode v3.18.1 版本，在「同步配置」里登录 GitHub 账号后，子智能体与 MCP 服务器的配置可以上传到该账号的私有 Gist，也能从远端下载同步回本地（两者各用一个 Gist，互不干扰）；下载先给出变更计划再确认，默认只增不删、可显式选择镜像远端，应用前自动备份本地配置并在失败时回滚；上传前扫描疑似密钥并提示，私有 Gist 不是加密存储；另外设置页「模型智能配置」的已配置规则列表改为默认收起。
- 2026-10-15：更新至 ZCode v3.18.0 版本，生成提交消息、提示词增强、会话标题这类辅助请求改用流式调用，修掉在部分第三方 API（例如只支持流式取正文的转发网关）上必定失败的问题；聊天里缺文件变更摘要的轮次改为按需回填，冷恢复后不再出现空的文件变更胶囊；会话统计面板补上子会话与子代理的输出速度；冷恢复首帧的三段只读查询改为并发，打开长会话更快。
- 2026-10-15：更新至 ZCode v3.17.9 版本，聊天消息里带行号的文件链接（如 Foo.java:263、Foo.java#L263）点开即定位到该行并高亮，不再停在文件开头；同一文件重复点击复用同一个标签页，滚动离开后再次点击仍会回到目标行；目标行因文件被改动而超出范围时在顶部给出提示，而不是点了没反应。
- 2026-10-14：更新至 ZCode v3.17.6 版本，提交弹窗的提交范围改由逐文件勾选表达，清单按「已暂存的更改 / 更改 / 未进行版本管理的文件」分组，原来的「包含未暂存的更改」开关删除：只勾「已暂存的更改」就只提交索引里已暂存的内容，用 git add -p 只暂存了一部分的文件不再被整份带进提交，未暂存的改动留在工作区；分组可折叠，展开收起带过渡动画。
- 2026-10-12：更新至 ZCode v3.17.5 版本，会话统计面板把「输出速度」拆成两行：「平均输出速度（TPS）」是整个会话的累计口径，「当前输出速度」是运行中的实时估算。两者本来就不是同一个量，并列给出后，工具条上的数字与面板不再看起来对不上。
- 2026-10-12：更新至 ZCode v3.17.4 版本，拉取改到 Git 工具里独立一行（点它即拉取，行尾显示落后多少个提交），不再藏在「提交或推送」的弹窗里；主按钮回到只负责提交与推送。
- 2026-10-11：更新至 ZCode v3.17.3 版本，修复 Git 拉取的若干问题：拉取结果面板不再被随后的刷新冲掉，拉取量稳定可见（提示里同时给出文件数与增删行数）；有上游分支的干净仓库不再隐藏 Git 入口，落后远端但还没 fetch 时也能拉取；远端分支已被删除时给出明确提示；读取分支状态失败时不再误报「已是最新」。
- 2026-10-11：更新至 ZCode v3.17.2 版本，Git 工具新增「拉取」：提交弹窗、主按钮与推送弹窗三处都能一键拉取远端代码，有更新时展示拉到的提交数、文件数与增删行数，没有更新则明确提示「已是最新」；无远程、无上游分支、本地改动会被覆盖、合并冲突、认证失败、网络不可达、超时等情况都有可读提示。内置模型规则补齐 Muse Spark 1.x 家族（1M 上下文 / 131k 最大输出，输入支持图片、视频与音频）。
- 2026-10-11：更新至 ZCode v3.17.1 版本，归档管理页补齐「任务索引里出现过的所有工作区」来源，修复很久没打开的项目里的归档任务在页面上看不到的问题。
- 2026-10-11：更新至 ZCode v3.17.0 版本，归档任务支持「彻底删除」：物理删除会话消息、快照与相关文件并回收磁盘空间（不可恢复），设置页「归档管理」提供单条、按项目、全部三种入口。
- 2026-10-11：更新至 ZCode v3.16.5 版本，自动归档改为扫描所有已知项目并增加常驻定时扫描，修复部分归档任务在列表里看不到的问题；设置页新增按项目分组的「归档管理」，可取消归档、移除或批量删除；`@` 引用文件搜索支持取消被取代的查询，并去掉打开面板时的全量排序。
- 2026-10-9：更新至 ZCode v3.16.2 版本，修复提示词增强必定报错、取消无法真正中断生成的问题；统一记忆与数据目录口径，改过「数据存储路径」后设置页不再看不到已有记忆，且搬移数据目录时会一并带走记忆；历史会话冷恢复期间改为显示加载骨架与上一轮回复预览。
- 2026-10-8：更新至 ZCode v3.16.1 版本，修复提交后 Git 工具入口随工作区变干净而消失、未推送的提交无处可推的问题。
- 2026-10-8：更新至 ZCode v3.16.0 版本，提交弹窗支持勾选本次要提交的文件；Review 面板文件右键可按文件暂存、取消暂存与撤销更改；设置页「记忆」支持在应用内查看正文与删除单条记忆，并在数据目录搬移后提示未生效的旧记忆。
- 2026-10-7：更新至 ZCode v3.15.3 版本，修复 macOS 上更新弹窗一闪而过、点不到「重启以更新」的问题：未签名发行下改为「前往下载」引导到 Release 页手动安装。
- 2026-10-2：更新至 ZCode v3.15.2 版本，降低文件遍历与 Bash 解析的重复开销、收紧代码高亮的内存占用，并缩短强制升级检查的启动等待。
- 2026-9-30：更新至 ZCode v3.15.1 版本，自动更新源与启动强更门禁改用 GitHub Releases；`/` 面板新增 MCP 对话引用；下线登录、升级、推荐提示词与内置预置供应商等入口。
- 2026-9-30：更新至 ZCode v3.15.0 版本，聊天框新增「会话统计」入口（模型用时、工具调用用时、首 token 平均、输出速度）。
- 2026-9-23：更新至 ZCode v3.14.3 版本。

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

第三方声明生成、发行校验流程及声明在发行物中的位置见 [third-party/README.md](third-party/README.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
