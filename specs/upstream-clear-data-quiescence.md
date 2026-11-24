# 上游严重修复：清数据前先停止写入方

## 直接官方依据与本地差异

- 官方 `a4b4445141eb7d3b3e99eada9292775383bfc44e`（v4.0.0）在 `packages/desktop/src/main/desktopCommandHandlers.ts` 增加 `beforeClearAllData: () => Promise<void>`；用户确认后先 await 此回调，再删除数据。
- 官方 `packages/desktop/src/main/index.ts` 将回调接到既有 `prepareAppQuit("desktop-command-clear-all-data")`。官方原因注释明确指出：直接 `exit` 跳过进程收尾，清目录后可能晚写。
- 本地 Help 原生菜单和托盘仍能到达 `DesktopCommandIds.ClearAllData`；当前直接 `rm(credentialsDir)` → 异步清 Electron storage → `app.relaunch()` / `app.exit(0)`，没有先停 Host / Agent / Cron。
- 本地已有 window-scoped Host、Host `Dispose`、service `disposeAllAndWait`、CLI stdin EOF / process-tree cleanup。复用这些 owner，不恢复官方 installer、preinstalled process、plugin sandbox 或其它已移除架构。
- 本地普通退出有 fail-open 策略：Host waiter 超时 resolve、Cron 强杀 timer 后 resolve，`prepareAppQuit` 日志后吞清理失败。这些路径可用于普通退出，不足以证明清数据安全。本次只为 ClearAllData 增加严格的物理退出确认；ordinary / update-install 语义保持。

## 数据边界保持不变

- `credentialsDir` 名称虽窄，实际是 `getCredentialsDir() = getAppConfigDir() = <当前 dataBaseDir>/.zcode/v2`，包含 credentials、tasks-index.sqlite、旧 task snapshots 与 logs 等。
- 不扩大为整个 `.zcode`、用户项目、Electron userData 根、CLI db / memories / artifacts 或远端服务器目录。
- `setting.json` 有独立 bootstrap 语义，固定在 home 的 `.zcode/v2`；custom dataBaseDir 下本次不额外删除 home 设置，也不改变优先级。
- 清现有 Electron session 的 storage，并保留已有 coding-plan partition 清理；不增加官方不存在于本地的 partition 或 sandbox。

## 唯一 owner 与状态

Main 清理入口只有一条；并发菜单 / 托盘 / IPC 请求共享一次 clear attempt（包括确认框）。Host / Agent shutdown、Cron shutdown、Main settings 写队列仍分别由现有 owner 持有。

```text
idle
  → confirming ── Cancel → idle（没有任何清理副作用）
  → preparing（关闭本次 app 生命周期的写/启动 admission）
      ├─ 既有 prepareAppQuit → Dispose 所有窗口 Host / remote attachments / Cron
      ├─ Host 严格等待：真实 exit(code=0)，无强杀；code!=0 / force / deadline → reject
      │   └─ Host 既有 service shutdown → CLI EOF + 既有进程树清理 → Host exit（后代核验限制见下文）
      ├─ Cron 严格等待：真实 exit(code=0)，无强杀；异常 / deadline → reject
      └─ Main settings 私有 quiesce：禁止新写，等待已接受写队列和真实底层 IO
      → 所有屏障成功
      → 停止窗口 Renderer（取消 auto-persistence，禁止重建 Host）
      → 停止 Main 文件日志（只留 console，删除后不再 mkdir 日志目录）
      → clear 已捕获 Electron sessions / coding-plan partition
      → rm 原 v2 目标
      → relaunch 一次 → exit 一次
```

- Main clear-specific admission 在第一个异步 wait 之前生效，阻止 clear 期间新建窗口、dom-ready 晚到重新 spawn Host，以及其它会写设置的 Desktop command；显式 RelaunchApp 作为失败恢复入口保留。
- Renderer 的 auto-persistence 不变成服务端事实或第二条接受队列。Host 接口关闭后不再接受新的文件写；严格屏障成功后才关闭窗口，取消其 timer 和 localStorage effects。准备失败时不销毁现有窗口。
- Main settings 用现有 factory 的私有 lifecycle 句柄，不增加 RPC 方法或共享状态字段。`setting/settingsQuiescence.ts` 仅收口该 factory 的 admission、在飞真实 IO 与 drain；既有 updateQueue / commitQueue 和设置业务逻辑仍属于原 factory，不建立第二条写队列。除了 clear 调用该句柄，普通设置 get/update、generation / atomic rename、超时语义均不变。
- `prepareAppQuit` / 已在 disposing 的物理进程仍幂等复用；不能凭 PID 缺席、`kill()` 返回或普通 wait Promise 已 resolve 推断 Agent 已退出。
- 任何截止时间只能 reject 清理，不能伪造退出、文件 I/O settle 或清理成功。Main 将设置 drain 包在现有退出预算的失败截止时间内；底层仍在飞时只报告失败，late exit / late IO 仍由原 owner 收口，失败 attempt 不会在它们晚到后自行继续删除。
- 普通/更新退出已进入准备时，清数据入口拒绝开始，不能与 fail-open quit 的 finally 竞争。清数据 admission 关闭后，before-quit 同步 preventDefault；运行中不能用 RelaunchApp 与 pending 准备/清理竞争，只有清理操作已明确失败、且用户显式 RelaunchApp 设置的独立恢复意图才允许正常重启。成功 clear 仍由同一操作在删除后直接 relaunch/exit。

## 失败与恢复

1. 用户取消：不清 coding-plan、localStorage、任何目录，不启动 shutdown。
2. shutdown / Main quiesce 异常、Host 非零退出、强杀、未观察到退出或 drain 超时：不进入任何数据清理，不 relaunch、不 exit；现有窗口保留，原生错误框说明本次未清数据，并提示用户使用已有“重启应用”动作恢复。
3. 已开始 terminal shutdown 的 owner 不原地复活；失败后不保证已停止的 task runtime 可以继续发送。保留窗口与草稿，用户显式正常重启恢复，避免双 owner / 新旧写入同时恢复。
4. 清理自身失败：向上报告，不继续 relaunch / exit，不声称全部数据已清空。文件删除和 storage clear 不具备事务回滚，本次不增加备份或恢复目录。
5. clear commit 开始后 Main logger 不再向目标落盘，否则一次成功 info 就会重建 `.zcode/v2/logs`；失败提示仍可使用 console / native dialog。

## 已知证据限制

`requireCleanExit` 只核实 utility Host/Cron 的实际 `exit(code=0)`、没有 Main 强杀和没有等待截止时间失败，不等于绝对证明所有 Agent 后代都已经核验。现有 Windows stdio transport 在进程树快照身份不可用、且根进程随 EOF 退出时，`remainingPids` 可以为空；本次不改进程树协议，不声称修复该既有限制。已知成员的清理失败仍会通过既有 service shutdown 向 Host 非零退出传播。

## 正式确定性回归

Desktop 测试为 `packages/desktop/test/upstream*.test.ts`，先 mock Electron 和 direct side-effect imports，再动态加载真实 owner 模块；禁止加载 Main 主入口或真实调用正在运行的应用。

- Command：Cancel 无副作用；deferred beforeClearAllData 未 settle 时没有 storage / rm / relaunch / exit；成功顺序；失败零清理 / 零退出；清理失败不退出；并发调用只确认 / 清理一次；删除后无文件 logger 复活。
- Host：真实 exit 前严格 Promise pending；exit(0) 成功；非零、强杀、deadline 拒绝；late exit 不使已失败 clear 恢复；同进程的 Dispose / cleanup timer 幂等；普通 waiter 的 deadline resolve 保持。
- Cron：清理 timer 的 kill 不等于物理退出；严格模式拒绝强杀 / 非零 / deadline；正常模式保留既有 fail-open。
- Main settings：`packages/services/test/upstreamSettingsQuiescence.test.ts` fake 文件 I/O / atomic write，quiesce 等待真实底层 write（包括超时 race 后仍在运行的 write）；禁止 fence 后新写；底层失败传播；普通 factory 未 quiesce 时设置行为不变。

所有 mock / deferred / timer 在 finally 清理；若需要真实 fixture，只允许系统临时目录且 finally 删除。正式 Desktop tests 由 `tsconfig.upstream-test.json` 纳入根类型检查。

## 验证

- Desktop `node --experimental-test-module-mocks --import tsx --test packages/desktop/test/upstream*.test.ts`。
- Services 同命令执行上述 `test/upstream*.test.ts`，现有 `tsconfig.test.json` 全纳入。
- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；Main 按现有 `tsconfig.main.json` 加 `--noEmit --incremental false --composite false` 做定向只读类型验证，结果如实报告。
- 不执行真实 clear/reset、应用退出、安装器、网络盘挂起或生产 Host 停止。保留本地编排改动，不触及已修改的 Host Controller / CLI orchestration / UI 文件。
