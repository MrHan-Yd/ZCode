# 会话引用统一走 `#`（Mention 会话作用域）

## 背景

会话候选在 `#` 与 `@` 两个入口都出现过：composer 的 `@` mention 面板会带「会话」分组，prompt-editor 的
「添加/上下文」菜单（`@` 快捷入口）也会列出会话。会话的 canonical mention 本来就是 `#sess_…`
（`buildSessionMentionMarkdown`），`@` 再选一次会话与 `#` 功能重复。

本轮把会话引用收敛到 `#` 单一入口：`@` 不再返回任何会话候选。

## 产品规则

1. 会话引用统一由 `#` 触发（含 composer `#` 面板、prompt-editor 选会话后插入 `#sess_…` 引用）。
2. `@` 的面板/菜单不再包含「会话」分组或会话候选：
   - composer `@`：保留 Plugins / Files / Whiteboards；
   - prompt-editor「添加/上下文」菜单：保留 Files。
3. 会话候选数据源（`useSessionsMentionProvider`）、`collectSessionMentionItems` 聚合与
   `#` 的序列化/排序语义不变；只调整调用方按触发器路由的范围。

## 状态所有者

- **触发器 → 分组**：`getMentionPanelGroupOrder`（`mentions/mentionPanelRouting.ts`）。
  `@` 用 `CONTEXT_GROUP_ORDER`，不再含 `sessions`；`#` 用 `SESSION_GROUP_ORDER`，保持含 `sessions`。
- **会话候选查询开关**：`MentionPlugin` 里 `useSessionsMentionProvider` 只在
  `isSessionTrigger`（`#`）时启用。
- **prompt-editor 上下文菜单分组**：`ChatPromptActionMenu` 只组装 Files 分组，不再调用会话 provider。

## 事件顺序

```text
输入 @ → MentionPlugin 按 CONTEXT_GROUP_ORDER 组装（plugins/files/whiteboards），会话 provider 不启用
输入 # → MentionPlugin 按 SESSION_GROUP_ORDER 组装会话分组，作用域 same-authority-workspaces
prompt-editor 打开「添加」→ 只出 Files，不出会话
```

## 验收场景

1. composer 输入 `@`：面板出现 Plugins / Files / Whiteboards，没有任何会话候选。
2. composer 输入 `#`：仍能搜到并引用会话（跨同 authority workspace）。
3. prompt-editor「添加」菜单只列文件与命令，不出现会话。
4. 选中会话后插入的 canonical 仍是 `#sess_…`，气泡回显/解析（`parseMentionMarkdown`）正常。
5. 远端与本地 workspace 的 `#` 会话索引行为不变。
