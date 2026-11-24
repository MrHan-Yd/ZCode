# 上游严重修复：挂起目录读取不再持续占用线程

## 直接官方依据

- 官方 `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`（v3.17.1）和 `a4b4445141eb7d3b3e99eada9292775383bfc44e`（v4.0.0）的 `packages/services/src/file/fileService.ts` 都包含 `inFlightDirectoryReads` / `readDirectoryEntries`。
- 官方中文原因注释引用 `ZCT-2113660144497782784`：系统权限授权或无响应网络盘可能令 `readdir` 不返回；底层无法取消，重复调用可占满 libuv 默认 4 条线程，阻塞同一进程其它文件操作。
- 官方使用 30,000ms 的目录无响应阈值；该共享常量所属远端准备接口在本地不存在，不为本修复恢复远端接口。
- 当前本地 `IFileService.readdir` 直接调用 `node:fs/promises.readdir`。文件树的强制刷新、目录浏览器的再次导航等入口真实可达；Renderer 请求序号和 Promise 超时只丢弃展示结果，不会取消底层文件 I/O。

## 范围与产品规则

1. 仅适配官方 `IFileService.readdir` 的原始目录枚举保护，不替换整个官方文件。
2. 同一宿主进程、同一原始 `path` 已有读取达到 30,000ms 且仍未 settle 时，后续调用复用该读取，不再发起新的 OS 枚举。
3. 阈值前的并发读取保持原行为；记录的是最早仍在途的读取，后续健康并发读不覆盖它。
4. 首个受追踪读取成功或失败后立即按 promise identity 删除记录。下一次请求必须重新读取，不缓存旧目录内容、不把权限错误变成空目录。
5. `includeHidden`、符号链接分类、目录优先排序仍由每个调用独立处理；共享的只有原始 Dirent 读取。
6. 不添加 timeout 成功结果、AbortSignal 假取消、永久内容缓存、全局线程池设置或同步 I/O。
7. 保留本地 workspace 索引作用域、TTL、`.zcodeignore`、显式 refresh 和最新搜索 token 取消等功能。

## 唯一所有者与事件顺序

```text
Desktop 文件树 / Web 目录浏览 / 手机既有 attachment
  → 当前 IServiceAccessor 的 IFileService.readdir(path, includeHidden)
    → 宿主进程内原始读取记录 Map<path, { startedAt, promise }>
      ├─ 无记录：开始 OS readdir，登记最早读取
      ├─ 未达阈值：按原行为开始独立读取，不替换记录
      └─ 已达阈值：等待同一 promise，不增开 OS 读取
        → 每个调用自己的隐藏项过滤 / symlink 分类 / 排序
        → 原有 UI 请求代际裁决
原始记录 promise settle → identity 相等才移除 → 下次重新读
```

- 记录按物理文件操作的原始路径隔离，不按 workspace 身份混合其它业务状态；不同进程不共享 Map。
- 不修改 workspace owner/lease、远端 session 路由或 Desktop continuous / Web replayable 传输。
- 同一底层挂起 promise 的等待本身不保证目录可用。本修复确认的是阻止阈值后重复占线程，不承诺解除系统挂起，也不覆盖其它路径同时挂起或阈值前大量并发。

## 正式回归

`packages/services/test/upstreamDirectoryRead.test.ts` 使用 Node `node:test`，mock `node:fs/promises.readdir` 和可控时钟，不连接真实网络盘。

1. 挂起读取达到阈值后，多次请求（含第二个 service 实例）不增加底层枚举次数。
2. 阈值前的健康并发不合并，旧并发读 settle 不清理仍挂起的原记录。
3. 成功 settle 后下一次读取能看见新目录；失败 settle 后下一次能恢复。
4. includeHidden、directory/file/symlink 标记及排序不变。
5. 旧记录 settle 的 identity 清理不能覆盖另一条当前记录；全部 deferred 在 finally settle，mock 时钟与 I/O 恢复。

测试必须先在未修复实现上出现行为断言失败，再实现最小修复。正式测试纳入现有 `packages/services/tsconfig.test.json`。

## 验证入口

- `node --experimental-test-module-mocks --import tsx --test packages/services/test/upstreamDirectoryRead.test.ts`
- `pnpm --filter @zcode/services typecheck:test`
- 根 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`；记录实际结果，不把计划用例当成已执行证据。
