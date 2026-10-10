# @ 文件检索延迟优化（防抖 + 补扫限频）

## 背景

`@` 面板的文件搜索在每次键击时都发起一次 `searchWorkspaceFiles` RPC，Host 侧对全部候选做一次模糊打分；
命中空结果时还会再发一次 `refresh: true` 的补扫，绕过 60s 索引缓存做整树目录遍历
（大工作区的全仓扫描可达秒级）。两条叠加导致大仓 `@` 输入逐键卡顿。

本轮改在 renderer 侧 `useFileMentionProvider` 内加两层节流：键入防抖 + miss 补扫冷却。

## 产品规则

1. 连续键入时文件搜索按防抖窗口（150ms）合成一次，不再逐键发 RPC。
2. 键入期间面板继续展示上一批结果，不逐键闪 loading。
3. 命中空结果的整树补扫加冷却窗口（5s）：冷却内再次落空不再绕过缓存重扫。
4. 语义不变：候选排序、前缀/子序列匹配规则、每工作区显示上限、`entries.length === 0` 时的空态文案均不变。

## 状态所有者

- **防抖查询**：`useFileMentionProvider` 内 `debouncedQuery` state，唯一写入路径是防抖 effect。
- **补扫冷却**：同 provider 的 `scope.lastRefreshAt`（随工作区/连接实例重置）。

## 事件顺序

```text
输入键击 -> 防抖计时重置（150ms）
  -> 计时结束 -> debouncedQuery 更新 -> 发起一次 searchWorkspaceFiles
  -> entries 为空且非空 query -> lastMissQuery 记忆
      -> 冷却窗口内：跳过整树补扫，直接返回空结果
      -> 冷却窗口外：lastRefreshAt 记录当前时间 -> refresh:true 补扫一次
```

## 验收场景

1. 大工作区快速连续输入 5+ 字符：只触发约 1 次文件搜索 RPC（以 Host 日志/RPC 计数为准），面板不逐键闪 loading。
2. 输入落空 query 若干次：5s 内最多发起 1 次整树补扫。
3. 有命中时结果与改动前一致：顺序、上限、空态文案不变。
4. 外部新建文件后，在冷却窗口外重新搜索仍能通过补扫看到（不回归"缓存有效期内永远不可见"的既有契约）。
