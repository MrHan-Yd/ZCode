# 会话 render units 增量构建

## 背景

`packages/ui/src/v4/conversationTurnRenderUnits.ts` 的
`buildConversationTurnRenderUnits`（现增量入口在
`conversationTurnRenderUnitsCache.ts`）此前每次调用都对全量 rows 重跑
「turn 分组 → materialize → keep → 位置归一化」。流式期间
每个 `row.delta` 都会换 `rows.window` 数组引用，SessionPane 与 ConversationTimeline 的
`useMemo` 因此每帧各触发一次全量重算（后者在流式长会话下是卡顿主因之一）。

## 行为

增量入口是工厂 `createConversationTurnRenderUnitsBuilder()`（住在
`conversationTurnRenderUnitsCache.ts`；原实现保留为
`buildConversationTurnRenderUnitsUncached`，作为语义基线与差分测试对照）：

- **每个调用点各持一份缓存槽**：工厂闭包封装 `rows` / `nowMs` / `sessionPhase` / turn 顺序 /
  每 turn 的 materialized unit。**必须**按调用点隔离——同一棵 React 树里 SessionPane 用空
  options、ConversationTimeline 用实时 `nowMs`，每帧各调一次同一份 rows；共用模块级单槽会让
  后渲染者覆写前者基线，增量路径永远落空（每帧仍是两次全量重算）。
- **完全命中**（rows 引用相同且 options 相同）→ 直接按序返回缓存 unit。
- **增量路径**：公共前缀/后缀 diff（行引用比较）找出变化区间 → 变化行所属 turn 全部
  标记 dirty；仅 dirty turn 重建 draft 并 materialize，其余 turn 复用缓存 unit
  （对象引用不变）。
- **全量回退**：options（`nowMs`/`sessionPhase`）变化或 snapshot 整体替换
  （前缀后缀为 0，diff 自动退化）时走 uncached 路径。

## 不变量与正确性论证

- **输出逐字段等价**：增量结果 ≡ uncached 结果（差分测试
  `packages/ui/test/conversationTurnRenderUnitsIncremental.test.ts` 以随机行操作序列
  逐步 deepEqual 断言）。
- **materialize 语义封闭**：`materializeDraftUnit` 只读单个 draft 的字段与 options，
  不跨 turn；turn 行集合一致 ⇒ 输出一致。
- **index/total 口径**：materialize 的 `isLastTurn` 仍按 keep 前的 draft 序号/总数传入，
  再由 `normalizeRenderUnitPosition` 修正 keep 后位置——与原全量路径口径相同；
  normalize 对位置属性未变的 unit 返回原引用（既有短路），未受影响 turn 因此保引用。
- **turn 行集合聚合**：按 turnId 从新 rows 全量收集（顺序无关，与 uncached 的逐行
  getOrCreateUnit 语义一致，兼容旧投影的 turn 交错）。
- **keep 过滤**：`shouldKeepRenderUnit` 只读 unit 自身字段；上次被过滤且行未变的 turn
  维持被过滤，dirty turn 重建后重新判定。
- **引用稳定收益**：未变 turn 的 unit 对象引用不变，下游 memo 化组件与
  `splitConversationTimelineLiveTail` 等派生计算对未变 unit 跳过工作。

## 失败语义

- 缓存为纯派生数据，无持久化、无 IO；任何输入变化都由 diff 正确覆盖或退化为全量。

## 验收

- 差分测试全绿（随机 append/upsert/delta/removed 序列 × 300 轮，含头部裁剪与整 turn 移除）；
  另有固定用例覆盖「同一帧两个调用点以不同 options 各持缓存槽」的引用稳定性。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
