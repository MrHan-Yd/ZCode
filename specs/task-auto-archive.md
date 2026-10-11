# 自动归档旧任务

## 背景

设置项 `taskAutoArchiveEnabled` / `taskAutoArchiveOlderThanDays` 控制「自动归档旧任务」，
但原实现只在 `listGroupedTaskViewStructure`（renderer 打开分组任务视图时）调用
`runWorkspaceTaskAutoArchive`，且传入的 workspaceScopes 只来自**当前窗口已打开的本工作区标签**：

- 不打开分组视图、或任务所在工作区没有作为标签打开时，这些工作区里的旧任务永远不会被扫描；
- 设置文案写的是「定时扫描最近打开过的工作区」，但代码里没有任何定时器；
- 归档写入不带 provider 过滤（归档全部历史 provider），而归档列表按 provider 过滤，
  导致非 ZCode provider 的行归档后在普通列表和归档列表里都看不到。

本次修正扫描范围与触发时机，并统一归档可见性边界。

## 产品规则

1. **判定条件不变**（`taskIndexRepo.archiveStaleTasks`）：
   `deleted = 0` 且 `archived = 0` 且 `pinned = 0` 且 `unread_at IS NULL`
   且 `updated_at < now - olderThanDays * 24h` 且 `task_status = 'completed'`。
2. **开关与保留期**读 `~/.zcode/v2/setting.json`：
   `taskAutoArchiveEnabled`（默认 `false`）、`taskAutoArchiveOlderThanDays`（默认 `7`，范围 `1..365`）。
   关闭时任何扫描路径都直接跳过。
3. **扫描范围**（常驻扫描路径）为全部已知工作区：
   - tasks-index 里出现过、且未删除的工作区（`listWorkspaceScopes`，轻量 `DISTINCT`，不带 `meta_json`）；
   - 并集 `setting.json` 的 `lastWorkspaceSession` / `recentProjects`（覆盖索引里暂时没有任务的项目）。
4. **触发时机**：
   - 常驻 scheduler 进程启动后扫一次；
   - scheduler 既有 tick 内按 `AUTO_ARCHIVE_SCAN_INTERVAL_MS`（默认 1 小时）节流再扫，单飞（在跑则跳过本轮）；
   - 保留 renderer 分组视图触发（`listGroupedTaskViewStructure`）作为「立刻生效」路径，只扫本次传入的 scopes。
5. **归档是软状态**：只把 `tasks.archived` 置 1，不删除会话数据、不释放磁盘空间。
   释放磁盘空间由「彻底删除」单独负责（另见后续 spec）。
6. **归档可见性不带 provider 过滤**：`listArchivedTasks` 与归档 membership 返回归档分区全部 provider 的行，
   与归档写入口径一致。普通（active）主列表的 provider 边界保持不变。
7. **归档管理页的项目来源必须覆盖「任务索引里出现过的所有工作区」**：只列打开的标签与
   「最近项目」（有上限）会漏掉很久没打开的项目，那些项目里的归档任务在页面上看不到——
   这正是归档页要解决的问题本身。页面通过 `listKnownWorkspaceScopes` 补齐第三个来源；
   枚举失败时降级成前两个来源，不阻塞页面。

## 状态所有者

- **`tasks.archived` / `tasks.deleted` 等任务元数据**：`tasks-index.sqlite`，唯一事实源。
- **周期扫描**：`packages/desktop/src/scheduler`（常驻 utility 进程，tasks-index 属主）。
- **即时扫描**：`packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`（renderer 打开分组视图时）。
- **设置的读取**：两处都经 `ISettingService.get()`，读写同一份 `setting.json`。
- **扫描判定的唯一实现**：`packages/services/src/session/taskAutoArchive.ts`，供上述两条路径共用。

## 时序

```
scheduler 启动 / tick 到期
  → 读 setting.json：taskAutoArchiveEnabled ? olderThanDays : 跳过
  → 枚举工作区：listWorkspaceScopes() ∪ lastWorkspaceSession ∪ recentProjects
  → 逐工作区 archiveStaleTasks（索引扫描，幂等）
  → 命中 N>0 → 发 task_meta_changed 事件 / 通知 main→host 刷新列表

renderer 打开分组视图
  → listGroupedTaskViewStructure(scopes = 当前打开的本地标签)
  → 同一判定逻辑只扫这些 scopes（即时生效路径）
```

## 验收场景

1. 开关关闭：任何路径都不归档。
2. 开关开启、保留期 7 天：某个**未作为标签打开**的项目里的 `completed` 且 7 天前的任务，
   在 scheduler 一轮扫描后被归档。
3. `error` 状态 / 有未读 / 已置顶 / 非 `completed` 的旧任务不被归档。
4. 归档后：任务从普通列表消失、出现在归档列表；非 ZCode provider 的归档行同样可见；
   `unarchiveTask` 可恢复。
5. 自动归档前后磁盘占用不变。

## 已知限制

- 周期扫描有节流，最坏情况下任务要在下一个周期后才被归档。
- 扫描覆盖的是本机 tasks-index 中记录的工作区；索引里完全不存在的项目无从枚举。
- checkpoint 是 workspace 级、无 taskId 归属，自动归档不涉及、也无法按任务精确清理。
- 本 spec 只覆盖归档；「彻底删除并释放空间」是独立能力。
