# 官方诊断凭据泄露的最小修复

## 授权与直接依据

仅修复当前本地可达、官方 `zai-org/ZCode` 已修复的两类凭据泄露，不移植官方整文件或新增功能。最终官方参照是 `a4b4445141eb7d3b3e99eada9292775383bfc44e`；以下同步 SHA 是公开修复证据，不声称是内部修复 PR。

1. `a9fe401eede6e6e5e01be9048679c206fe6f02d9` 的 `apps/zcode-cli/packages/adapters/src/mcp/index.ts:2507-2529`：先去 ANSI，再识别 `API_TOKEN` / `VE_SPEECH_MCP_TOKEN` 等前缀键，整体遮盖含空格或转义引号的值。对应官方 `adapters/tests/mcp.test.ts:729-754`。
2. `b95ebaffeab641907b38652f45c1502bd762972d` 的同文件 `2497-2520`：有界 stderr 截断会切掉键名；截断后的第一行残片不得交给脱敏。CR 也是行边界；没有完整行时 fail closed。对应官方测试 `758-823`。
3. `b95ebaffeab641907b38652f45c1502bd762972d` 的 `packages/shared/src/agent-crash-diagnostic/agentCrashDiagnostic.ts:240-278`：services 与 main 共用凭据规则，Bearer/Basic 必须先于赋值替换；Cookie 多段整体遮盖，保留引号保证幂等。官方 `packages/desktop/test/agent-crash-diagnostic.node.test.ts:171-246` 验证 services → main 串联不泄露。

## 本地确认与产品规则

- 本地 MCP `attachStdioLogging` 把原始 chunk 先加入 4000 字符尾部再脱敏，键名可能已经丢失；debug 又按任意 chunk 脱敏，跨 chunk 的凭据缺失上下文。现有对象型 `DefaultLogRedactor` 不清洗 `stderr` 字符串内容。
- 本地 Agent `redactAgentDiagnostic` 与 main `sanitizeAgentCrashDetail` 都先替换赋值，再遮 Bearer；`Authorization: Bearer synthetic-token` 实际变为 `Authorization: <redacted> synthetic-token`。该值会进入生产退出日志、Host 生命周期 IPC、`perf_agent_crash` 的 `error_stack` 与独立 exception。
- MCP 的现有状态错误文案、失败分类、请求 ID、连接代际、OAuth、权限与请求日志功能不变；不移植官方将 stderr 新展示到设置页的功能。
- Agent 的尾部仍是最多 20 行、每行最多 1000 字符加现有截断标记；结构化 name/message/stack 仍按既有协议上限限长。main 保留原有 workspace/home/path 遮盖、归因、指纹和生命周期去重。
- 所有凭据遮盖先于输出限长。不能从被切掉键名/引号的后缀尝试恢复凭据边界；超长未闭合行丢弃到下一 CR/LF，保留之后的完整诊断。
- 嵌套 Bearer、带引号及转义引号的值作为同一修复的负面/幂等回归，不增加“官方已修复独立 bug”计数。非敏感近似键、错误码、正常文本、UTF-8 和换行保留。

### 独立复核确认的 MCP 跨行回归收尾

逐行 `emitLine → sanitizeMcpStdioStderr` 丢失了原有正则 `\s*` / `\s+` 跨 CR/LF 的待值上下文：`API_TOKEN=\n<假值>`、`Authorization: Bearer\n<假值>` 和 JSON 键/值跨行会把第二行当普通文本送到 debug、failed、connection_lost。原本地与最终官方对完整文本的 sanitizer 均能遮盖这些值；这是本次 buffer 粒度引入的同批准漏洞回归，不另计新漏洞。

- 仍由同一个 bounded buffer 维护一个有界的“下一非空行属于凭据值”标志，判定复用 MCP 既有敏感键定义；不得另建原始数据 buffer、脱敏 owner 或日志 sink。
- 已确认缺值的键/Authorization/Bearer 前缀跨 CR/LF 后，后续非空 continuation 行整体 fail closed；空白行不消费该标志。值行消费一次后恢复普通诊断，保留后续 `ECONNRESET` / `real failure`，不无限吞后文。
- debug 与失败/断连读取都必须消费该上下文；仅最终 tail 再做正则不能撤回已经泄露的 debug。
- 原始待行和输出仍各按既有 4000 字符预算；超长空白 continuation 不可清掉待值标志，超长实际值丢弃完整行后恢复。EOF、无 EOF 失败快照和 5 字节跨 chunk 均适用。
- 本次收尾只修改 MCP `index.ts`、对应 `upstreamMcpStderr.test.ts` 与本规范；不改 Agent、分类、日志等级、status、runner 或 tsconfig。

## 所有者与接口

架构策略选择 `zcode-cli`、`services`、`desktop`、`shared`（当前均 legacy/unmanaged）；架构检查的零新增违规不等于这些模块已受完整边界检查。

- Agent 凭据规则的唯一 owner 是现有 `packages/shared/src/process-diagnostic.ts` 增加的纯函数 `redactAgentDiagnosticSecrets(value: string): string`。沿已有公开 `@zcode/shared/process-diagnostic` 入口复用，services 与 main 不再各自保留凭据正则；不新建官方 agent-crash-diagnostic managed 模块，不搬入归因实现。
- MCP 沿用现有适配器内 `sanitizeMcpStdioStderr`，负责其特有的环境变量、URL query/userinfo 与 ANSI。原有 bounded buffer 成为该连接唯一 stderr 行组装/已脱敏尾部 owner，debug 与失败日志消费同一结果；不新增第二条日志写入路径。
- 既有通用 telemetry redactor 继续仅负责遥测副本（路径、URL、身份与上限），不能用它替换本地日志诊断规则或改变遥测开关。

```text
MCP stderr bytes → 同连接 StringDecoder/有界完整行组装 → MCP sanitizer → 有界安全尾部
                                                             ├→ 既有 Logger.debug
                                                             └→ failed / connection_lost Logger.warn

Agent stderr → 既有行读取 → shared 凭据 redactor → 20×1000 安全尾部 → 生产日志
                              └→ 严格 process diagnostic → Host lifecycle reporter/IPC
                                                                     ↓
main 保留路径规则 + 同一 shared 凭据 redactor → 原有归因/指纹 → ARMS port
```

进程身份、workspaceIdentity、owner/lease 与退出 stderr drain 顺序不变。不添加超时处理同步问题。

## 正式回归与验证

新增正式 `test/upstream*.test.ts`，只用虚构凭据。SDK、spawn、协议旁路、Electron 与 ARMS 接口以 Node `mock.module`/内存流替代，禁止真实 Agent/MCP 进程、真实用户数据或遥测。测试必须动态导入 `src`，不得用旧 dist 证明修复。

- MCP：前缀键、大小写、裸/JSON/单引号/双引号、空格与转义引号、ANSI 插在键名或 token 内、Bearer/query/userinfo；完整行跨 chunk、UTF-8 跨字节；4000 字符截断切键、长引号值含空格/逗号/分号/&、CR-only、EOF 最后一行；debug/failed/connection_lost 均不含秘密残片且保持 4000 上限。
- Agent：未加引号 Authorization/Proxy-Authorization、嵌套 Bearer、带引号与转义引号、Cookie 后续段、裸 sk key；services 首次遮盖后 main 再次处理不变；name/message/stack 的协议上限、20 行尾部与1000字符截断保持；普通错误码、非敏感近似键及缺失/空值负控。
- main：ARMS 仅内存桩，检查最终 `sendCustom`/`sendEvent` 参数；保留原有错误归因/路径遮盖/指纹/去重，不修改默认日志或遥测策略。

先执行新增回归确认修前失败，再实现与执行修后测试。正式统一入口 `pnpm test:upstream-fixes` 使用 `--experimental-test-module-mocks --import tsx --test`；类型纳入与 package scripts 由主代理统一更新，services 沿用全量 `tsconfig.test.json`。

执行定向类型/Lint、必要既有回归，以及根 `pnpm typecheck` / `pnpm lint` / `pnpm architecture:check --changed`。已有失败、未执行与环境限制如实报告。无真实凭据/遥测输出，不留下临时脚本、截图、日志、配置或编排变更。

## 明确不移植

官方 MCP Apps/elicitation/resource subscriptions、workspaceKey/worktree 授权新链路、OAuth 家族、installer/Windows runtime host、AgentStderrCollector 重构、native OOM/errno 白名单与摘要归因重构，以及任何 UI、遥测策略、默认日志等级或发行功能。保留所有既有二开与未提交编排文件。
