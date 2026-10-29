# Git 远端访问复用设置页 HTTP 代理

## 背景

设置页的 HTTP 代理只覆盖模型、MCP、命令工具与应用渲染层的出口流量。host 启动时会把
`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` 从 `process.env` 剥离，封存进
`ZCODE_TOOL_ENV_PASSTHROUGH_JSON`，只在上述流量的子进程边界恢复原名。

Git 是 host 自己 spawn 的独立子进程，不在那个边界内：它的环境由 `getGitCommandEnv()` 从已剥离的
`process.env` 拼出，因此 `push` / `pull` / `fetch` 一律直连远端。国内网络下表现为

```
fatal: unable to access 'https://github.com/<owner>/<repo>.git/': Recv failure: Connection was reset
```

而同一台机器上用 Bash 工具执行同样的 push 却能成功（工具子进程恢复了代理），用户只能逐个仓库
手工 `git config http.proxy`——新开仓库就要再配一次。

## 产品规则

1. Git 的代理来源与其它出口流量一致：**只读设置页的 `httpProxy` / `httpProxyNoProxy` / `httpProxyCaCertPath`**，不读取用户 shell 的 `HTTP_PROXY` 等变量。
2. 设置页留空 → 不注入代理，git 直连（与其它流量「留空时直连」同一口径）；用户自己在 git 里配的 `http.proxy` 仍然生效。
3. 归一化复用 agent 子进程那一套：裸 `host:port` 补 `http://`，已带 scheme（`http://`、`socks5://` 等）原样保留；`noProxy` 按逗号分段、去空白后重组。设置页的值优先于继承环境里的同名变量。
4. 证书跟随代理：`httpProxyCaCertPath` 同时下发为 `GIT_SSL_CAINFO`，让 git 在代理做 TLS 终结时信任同一份 CA。
5. 生效时机与设置项文案一致：**修改后需重启应用**（host 进程内只解析一次，避免每条 git 命令都读一次设置文件）。
6. 代理只影响与远端通信的命令。本地 `status` / `diff` / `commit` 不因代理缺失或不可用而失败。
7. Web/Server 装配前必须与 desktop Main 一样采集一次 login shell 运行时环境（PATH 等）。server 常由 IDE 或服务管理器拉起，继承不到用户 shell 的 PATH，`git` 会解析失败——此时 `isGitAvailable=false`，UI 按规则把整块 Git 工具隐藏，用户只会看到「Git 不见了」。解析失败时服务端必须留一条 warn（候选列表 + 覆盖变量），不允许静默返回。

## 接口

- `agentProxyEnv.buildGitNetworkEnv(settings)`：把设置页代理翻译成 git 子进程要的环境变量（`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` / `GIT_SSL_CAINFO`）。
- `GitEnvironmentProvider.createCommandEnv()` 改为异步，允许调用方注入网络环境；`getGitCommandEnv(extraEnv)` 把注入值叠加在继承环境之后，保证设置页优先。
- `createLocalServices` 用 `settingService.get()` 构造该 resolver，只装配给本地 Git 服务，不改动其它 service 的环境边界。

## 验收场景

1. 设置页填 `http://127.0.0.1:7890`，在面板里推送一个领先上游 1 个提交的分支 → 成功；host spawn 的 git 进程带 `HTTPS_PROXY=http://127.0.0.1:7890`。
2. 设置页填 `127.0.0.1:7890`（无 scheme）→ 归一化为 `http://127.0.0.1:7890`。
3. 设置页留空、shell 里有 `https_proxy` → host 的 git 不带代理（不读 shell 变量），失败时把 git 的原始错误如实显示在推送弹窗里。
4. 填了 `noProxy` → git 进程带归一化后的 `NO_PROXY`，命中规则的远端直连。
5. 填了代理证书 → git 进程带 `GIT_SSL_CAINFO`。
6. 本地 `status` / `diff` / `commit` 的行为与改动前一致。
7. 由 IDE/服务管理器拉起 web server（PATH 里没有 git）→ 装配时采集到 login shell 的 PATH，`getWorkspaceRepositoryInfo` 返回 `isGitAvailable: true`，Git 工具正常显示；若仍解析失败，日志里有一条带候选列表的 warn。
