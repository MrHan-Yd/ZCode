# 模型供应商重命名（Model provider rename）

## 背景

设置页「模型设置」里，自定义供应商卡片标题右侧的 `...` 菜单提供「重命名」。点击后标题会切换成内联输入框（`TID_MODEL_PROVIDER_NAME_INPUT`），Enter 提交、Esc 取消、失焦提交。

此前实现里，菜单项 `onSelect` 会**立刻**把 `editingName` 置为 true，而 Radix 下拉菜单的关闭收尾（焦点归还触发按钮、关闭动画期间菜单内部重新抢焦）发生在之后若干帧内。名称输入框刚聚焦就被抢走焦点并触发 `onBlur`，而 `onBlur` 被当成「用户结束编辑」处理，于是编辑态立即退出，表现为「点重命名没反应 / 一进去就取消」，且由于是竞态，只在部分时机复现。

内部 `@radix-ui/react-menu` 在 item `pointerleave`、关闭时 `onCloseAutoFocus` 都会主动 `.focus()`；仓库里另一处同类交互（`workspace-grouped-tasks/group-item.tsx` 的分组标题重命名）已用「延后交接 + 焦点保护窗口」解决，本 spec 沿用同一约定。

## 产品规则

1. 只有自定义供应商可重命名。预置供应商传 `nameEditable={false}`，菜单不出现「重命名」项。
2. 点击「重命名」后必须进入编辑态并聚焦输入框，编辑态在菜单关闭收尾结束前**不得**被菜单造成的失焦中断。
3. 编辑态内的 Enter 提交、Esc 取消、点击其他位置失焦提交，语义与既有实现一致（Esc/提交后 `nameEditProviderIdRef` 清空，随后 blur 不补发保存）。
4. 空白名称提交回退为提交前名称，不写入空名。
5. 中文输入法候选确认的 Enter 不触发提交（沿用 `resolveProviderNameEditKeyAction` + composition 状态）。

## 状态所有者

- **编辑态与草稿**：`InlineEditableProviderCard` 的 `editingName` / `nameValue` / `draftRef`，唯一写入路径是菜单交接、输入框事件与供应商切换时的同步 effect。
- **重命名意图**：`ProviderCardHeader` 内的 `renameRequestedRef`，由菜单项 `onSelect` 登记、`onCloseAutoFocus` 消费。
- **焦点保护窗口**：`InlineEditableProviderCard` 的 `nameEditFocusGuardRef` + `nameEditFocusGuardTimeoutRef`（350ms），由 `armNameEditFocusGuard` 唯一写入。

## 事件顺序

```text
点击菜单项「重命名」
  → onSelect 只登记 renameRequestedRef = true（不切编辑态）
  → Radix 关闭菜单
      → onCloseAutoFocus：preventDefault（拦下焦点归还触发按钮）+ 清标志
        → setTimeout(0)：onStartEditName()
            → armNameEditFocusGuard()（350ms 窗口）
            → setEditingName(true) → 挂载输入框 → rAF 聚焦
  → 保护窗口内的失焦：视为菜单收尾焦点竞争 → 保持编辑态并回焦输入框
  → 窗口结束后的失焦：按用户结束编辑处理（提交或回退）
```

## 验收场景

1. 点「重命名」→ 标题变输入框且获得焦点，不发生自动退出。
2. 键盘（方向键移动后回车）触发「重命名」同样进入编辑态。
3. 连续快速点开菜单并选「重命名」，多次操作都能进入编辑态。
4. 输入新名称后 Enter 提交，卡片标题与侧栏名称更新。
5. 输入中按 Esc 取消，恢复原名且不触发保存。
6. 点击别处失焦提交，与 Enter 提交一致。
7. 预置供应商卡片菜单没有「重命名」项。
