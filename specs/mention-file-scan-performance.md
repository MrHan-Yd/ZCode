# @ 引用文件扫描性能

## 背景

`@` 引用文件走的是 Host 进程内的**内存索引 + 模糊打分**，与 native 搜索工具（bfs/ripgrep/ugrep，只服务
Agent 的 Bash）无关。链路：

```
renderer MentionPlugin → useFileMentionProvider → RPC(IFileService)
  → Host fileService.searchWorkspaceFiles
      → ensureWorkspaceFileIndex（readdir 受限并发遍历 + packed 索引，60s TTL 缓存）
      → buildHostFileSearchCandidates（分批解码，缓存在索引对象上）
      → searchHostFileCandidates（分批 top-K 打分）
```

renderer 侧的两项已经就位（由 `fileMentionProvider` 拥有，本 spec 不再重复实现）：

- `FILE_SEARCH_DEBOUNCE_MS`：键入防抖，把连续按键合并成一次搜索。
- `FILE_SEARCH_REFRESH_COOLDOWN_MS`：无命中补扫的冷却窗口，并且**只有真正补扫过**才记住该 miss query。

本次只补 Host 侧仍然存在的两个热点：

1. **分批打分不可取消**：被更新查询取代后仍会把全部候选算完，快速输入时 Host CPU 被无效查询占满。
2. **空 query 全量排序**：打开 `@` 面板时为了取前 `limit` 条，对全部候选做三趟 `map + sort + map`。

## 产品规则

1. **可取消**：`searchWorkspaceFiles` 按 workspaceKey 维护递增查询 token，传给
   `searchHostFileCandidates` 的 `shouldAbort`；每批打分后检查一次，被更新查询取代即提前返回已得结果。
   过期响应本来就被 renderer 按 query/limit/scope 身份丢弃，因此提前返回部分结果语义安全；
   只有最新查询会完整计算。
2. **空 query 顺序不变**：默认预览顺序为「文件优先、再目录，各自保持索引顺序」。
   索引本身已按「目录优先 + 路径」排序（文件是连续的一段），所以取前 `limit` 个文件、不足再补目录即可，
   与共享的 `sortDefaultWorkspaceFileSearchCandidates` 严格等价，无需全量排序。
3. **Host 不自作补扫限频**：补扫的限频归 renderer 冷却窗口。若 Host 侧「假装扫过」，
   renderer 会把该 query 记为已补扫，新建文件在该 query 下将永远不可见。
4. **不变项**：索引 TTL（60s）、缓存条数（4）、返回上限（1000）、`.zcodeignore` 剪枝语义均不变。

## 状态所有者

- **查询取消语义**：`packages/services/src/file/fileService.ts` 的 per-workspace 查询 token。
- **索引与缓存**：同一文件的 `ensureWorkspaceFileIndex`（唯一扫描入口）。
- **结果顺序与打分**：`packages/services/src/file/workspaceFileSearch.ts` 与
  `packages/shared/src/workspaceFileSearch.ts`（共享纯函数，其他调用方不受影响）。
- **键入防抖与补扫限频**：`packages/ui/src/mentions/providers/fileMentionProvider.ts`。

## 验收场景

1. 在 `@` 后快速连续输入：只有最新 query 完整计算，被取代的查询提前退出。
2. 打开 `@`（空 query）：返回顺序与优化前一致（文件优先、再目录），且不产生全量排序。
3. 常规命中查询：结果与优化前一致。
4. 新建文件后查询它：renderer 冷却窗口过后可见（Host 不吞掉补扫）。

## 已知限制

- 被取消的查询返回的是部分结果。单消费者场景下该响应必然被丢弃；但同一 workspace 同时存在两个消费者
  （例如对话输入面板与提示操作菜单）时，后发查询会中断前者的查询，前者可能短暂拿到不完整列表。
  触发条件很窄（同 workspace + 同一时间窗），且只是候选变少、可再次查询恢复。
- 索引没有文件 watcher，外部改动靠 TTL 或补扫生效，不保证实时。
