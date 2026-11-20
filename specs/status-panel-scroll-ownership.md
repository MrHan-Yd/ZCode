# 会话状态面板：单一滚动视口与编排计划分区重排

> 状态：已实现（2026-11-20），待桌面 / 移动 Web 手工验收。
>
> 范围：`packages/ui` 右下覆盖式「会话状态」面板（`ConversationStatusPanel`）的布局、滚动所有权、分区头与「编排计划」分区。
>
> 不涉及：协议、RPC、CLI 投影、持久化、编排调度语义、面板宽度与模式选择器。

## 1. 背景

面板原本由外层兜底滚动 + 每个分区各自 `max-h-48/80 + overflow-y-auto` 的滚动视口共同组成，320px 宽度下同时出现三条滚动条（外层、编排计划、智能体）。编排计划分区还额外套了一层带边框的 run 卡片，形成「面板圆角 → run 卡片圆角 → 步骤行圆角」三层描边。每一步的「查看子会话」按钮重复出现，抬高行高并制造第二套打开子会话的交互语言。

## 2. 产品规则

1. **一个面板 = 一条滚动条**：面板内容区是唯一滚动视口。分区不得声明 `max-height` 或 `overflow-y`。
2. **分区标题粘性常驻**：分区头 `sticky top-0`，滚动时始终可见，用不透明 `--color-popover` 背景遮住滚过的内容；非首个分区在头自身上画 1px 上边线，头底部始终有 1px 发丝线。
3. **层级不用边框套边框**：分区之间只用发丝线；run 不再使用卡片描边，靠 run 头、步骤缩进与三级文字色区分层次。
4. **一行只回答一个问题**：状态词回答状态，行尾紧凑时长回答耗时，错误单独一行回答原因。步骤行不再复制「已运行 X」句子；该短语只保留在「智能体 / 终端 / 工作流」分区，那里一行只有一个时长。
5. **移除步骤级「查看子会话」入口**：编排计划是总览，子会话入口保留在「智能体」分区（运行中，整行可点）、「已结束的智能体」目录与时间线 Agent 工具行。步骤行不可点击、不进入 Tab 顺序、无手型光标。
6. **run 头信息不互相挤压**：`planId` 可截断，修订号 `r{revision}` 独立且永远可见；run 状态改纯文本；停止 / 重排改为 24×24 图标按钮，`aria-label` 与 tooltip 复用既有文案。
7. **零协议增量**：只读 `orchestrationState` 既有投影，不新增字段、命令或持久化结构。

## 3. 滚动所有权

```
aside（固定高度 max-h-[min(70dvh,36rem)]，overflow-hidden）
└─ div[data-status-panel-scroll="panel"]        ← 唯一滚动视口
     overflow-y-auto overscroll-contain [scrollbar-gutter:stable] px-2 pb-2
   ├─ StatusSection（goal）
   │    ├─ sticky top-0 h-7 分区头  bg-popover  z-10
   │    └─ CollapsibleContent（无 max-h / 无 overflow）
   ├─ StatusSection（orchestration）
   │    ├─ sticky 分区头（separated → border-t）
   │    └─ run 头 + 步骤行（无内层滚动）
   └─ StatusSection（agent）
        ├─ sticky 分区头
        └─ 智能体行
```

- 折叠只改变内容高度，不产生第二个滚动容器；滚动位置归唯一视口所有，不新增分区级滚动状态。
- `[scrollbar-gutter:stable]` 保证滚动条出现 / 消失时行宽不跳动；`overscroll-contain` 阻止滚动链传回会话时间线。
- 分区级限高来自 `STATUS_SECTION_SCROLL_POLICY`，本变更删除该表；新增分区不需要再配置滚动策略。

## 4. 规格摘要

| 元素     | 规格                                                                                                                                                                 |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 面板     | `w-80`、`max-w-[calc(100vw-1.5rem)]`、`max-h-[min(70dvh,36rem)]`、`rounded-2xl`、`bg-popover`、`shadow-md`                                                           |
| 关闭按钮 | 绝对定位 `right-3 top-3`、`size-6`、`z-20`（高于粘性头）                                                                                                             |
| 分区头   | `sticky top-0 z-10 h-7 -mx-2 px-2 pr-8`、不透明 `bg-popover`；标题 `text-ui-base font-medium`（`foreground-subtle`）；单箭头 `rotate-90` 表达展开，`opacity-60` 常驻 |
| 步骤行   | 三列 grid `[14px minmax(0,1fr) auto]`、`px-2 py-1`、`gap-x-2`、hover `--color-hover`                                                                                 |
| 步骤标题 | `line-clamp-2 leading-5`；未完成 `foreground`，完成 `foreground-subtle` 且**不再删除线**                                                                             |
| 信息行   | `text-ui-sm leading-4`，状态词 / 角色 / 等待依赖 / 重试；运行中状态词 `--color-warning`，失败 `--color-destructive`                                                  |
| 步骤错误 | 独立一行，`col-start-2 col-span-2`，`line-clamp-2`，`--color-destructive`                                                                                            |
| 行尾时长 | 紧凑值（`12秒` / `7分53秒`），`text-ui-xs tabular-nums foreground-subtlest`，仅 running / 有 endedAt 的终态                                                          |
| run 头   | `h-7`，`planId` `flex-1 truncate font-mono text-ui-sm`，修订号独立 `shrink-0`，状态纯文本，动作 24×24 ghost 图标                                                     |
| 语义色   | 统一使用 `--color-destructive`；不使用未定义的 `--color-danger`                                                                                                      |

## 5. 验收场景

1. 展开目标 + 编排计划 + 智能体三个分区并滚动：面板右侧只有一条滚动条。
2. 滚动过程中当前分区标题固定在面板顶部，滚过的行被标题背景遮住。
3. 编排计划步骤达到 8 条以上时，滚动发生在面板视口，分区内部没有第二条滚动条。
4. run 头在 320px 宽度下 `planId` 截断但 `r{revision}`、状态词、两个动作按钮均完整可见。
5. 任意步骤行都不出现「查看子会话」按钮；步骤行不可点击、不进入 Tab 顺序。
6. 运行中步骤行尾显示紧凑时长，且每秒递增；运行中的子会话仍可从「智能体」分区整行打开。
7. 失败步骤的错误文案与 ✕ 图标使用 `--color-destructive`，在浅色 / 深色主题下均为红色。

## 6. 测试与锚点

- `packages/ui/test/orchestrationStatusPanelRender.test.ts`：断言 planId 与修订号分段渲染、停止 / 重排以 `aria-label` 表达、步骤行内不存在「查看子会话」与 button、完成步骤不再有 `line-through` 但仍保留完成图标。
- 保留锚点：`data-testid="chat-status-sections-panel"`、`data-status-section`、`data-status-section-trigger`、`data-orchestration-run-id`、`data-orchestration-run-status`、`data-orchestration-step-id`、`data-step-status`；新增 `data-status-panel-scroll="panel"`。`data-status-section-scroll` 随分区滚动移除。
