# 上下文容量：子代理来源分类

## 行为与范围

输入框工具栏的“上下文容量”浮层在来源明细末行、平均缓存命中率之前增加“子代理”（英文 `Subagents`）。只在实际请求包含子代理派发工具定义且字符数大于 0 时显示，其他分类仍按占用降序排列；顶部用量、缓存命中率和浮层交互不变。

“子代理”统计父会话实际提供给模型的 `Agent` 工具合同，以及仍可能存在的兼容 `Task` 工具合同，包括可见子代理目录、调用说明、输入/输出 schema。它从既有“系统工具”分类拆出，不能重复计数。只统计传给当前模型请求的工具，不扫描未注入的 profile 正文，不累加子会话推理 token。子代理返回给父会话的结果正文仍按原规则属于“消息”。`SendMessage` 等控制工具仍属于系统工具。

## 所有者与接口

- 唯一统计所有者是 CLI runtime 的 `buildContextUsageSnapshot()`；使用已有 `isSubagentDispatchToolName()` 判定 `Agent` / `Task`，不另造工具别名清单。
- 派发工具与其他系统工具、MCP 工具互斥分组；MCP 命名优先，`mcp__server__Agent` 仍属于 MCP。
- 扩展 `ContextUsageBreakdownSource` / `zcodeContextUsageBreakdownSourceSchema` 为 `subagents`。`ContextUsageCategory.source` 复用 contracts 类型，不再维护独立重复联合。
- `ContextUsageToolDetail.source` 继续表示工具注册来源，派发工具仍是 `system_tool`；展示分类由互斥数组与 `categorySource` 表达。
- 完整诊断快照增加 `subagentTools`，分类贡献者使用现有 `toolContributor()`；紧凑日志增加 `subagentToolCount`。既有估算方法、字符与 token 算法不变。
- UI 使用已有 `ChatContextUsage`、Progress、语义颜色和 `text-ui-*`。`subagents` 末行仍参与 `chars / totalChars` 比例与进度条，不单独构建接受状态。
- 调试页面识别同一来源并显示“子代理”，不降级成“其他”。
- 不改 provider 调用、session 所有者、队列、持久化格式版本或 workspace 身份。旧快照缺少新分类时按原样展示，不伪造 0%。

## 事件顺序与传递边界

```text
当前请求实际可见 tools
  → runtime 按系统 / 子代理派发 / MCP 互斥分组
  → categories + contributors（总字符与总估算 token 保持不变）
  → contextUsageBreakdown / main_turn usage
  → CLI session projection
  → shared schema 校验
  → UI 纯派生末行“子代理”与分段进度条

Desktop：desktop-continuous 实时投影 ─┐
                                    ├─ 同一 usage schema 与统计事实
手机：web-remote-replayable 快照恢复 ─┘
```

`main_turn` 的上下文用量边界不变。子会话 usage 不能更新父会话上下文总量；派发定义重新分类也不能改变 provider 实测 `used` 与 `size`。

## 验收

1. 实际 `Agent` / 兼容 `Task` 合同各按原序列化估算进入 `subagents`，从 `system_tool_schemas` 移除；两者合计与原工具总量相等。
2. 没有派发合同（禁用、子会话工具面或请求过滤后）不生成子代理分类；未注入 profile 不计量。
3. MCP `mcp__fixture__Agent` 不误算为子代理；普通 Read / SendMessage 保持系统工具。
4. `categoryBreakdown` 与紧凑日志保留子代理来源和实际贡献者；未知类别、无效字符值继续按原规则过滤。
5. 新来源通过 legacy session runtime 与 V4 continuous/replayable snapshot 共享校验；旧来源与缺失 breakdown 仍通过。
6. 真实浮层在中英文、Zai Light/Dark、桌面 hover/focus、手机 touch 下显示正确占比；子代理占比最大时仍在明细末行。
7. 更新明细会重算各分类百分比，合并重复来源，不改变顶部上下文用量与缓存命中率；分类缺失/0 时不展示，不出现 NaN。
8. 浏览器验证不访问外部网络、不修改用户设置或实际会话，临时文件在 finally 中清理。
9. 新 runtime 测试纳入 `pnpm typecheck` 与 `test:upstream-fixes`，新 UI 浏览器测试及 fixture 纳入 UI test tsconfig 与 `test:desktop-regressions`；实际执行 `pnpm typecheck`、`pnpm lint`、架构检查和目标回归。

## 当前文件边界

- `apps/zcode-cli/packages/core/src/runtime/methods/context-usage.ts`
- `apps/zcode-cli/packages/core/src/runtime/types.ts`
- `apps/zcode-cli/packages/core/src/runtime/methods/context-usage-log-compact.ts`
- `apps/zcode-cli/packages/contracts/src/events/session.events.ts`
- `packages/shared/src/zcode-protocol-legacy-types.ts`（legacy 与 V4 共用）
- `packages/shared/src/zcode-protocol/index.ts`（公共 schema 导出）
- `packages/ui/src/chat-input-toolbar/contextUsage.tsx`、中英文 locale
- `apps/zcode-cli/packages/debug/src/shared.ts`、`App.tsx`、`server/analyzer.ts`

现有 feature graph 没有上下文容量来源统计节点；本次作为 graph-drift-candidate 记录，不扩展无关功能图。
