# 草稿页推荐提示词下线（Draft suggested prompts retirement）

## 背景

新任务草稿页的 composer 下方此前有一行推荐入口，由 `SessionPane` 渲染
`ConversationDraftSuggestedPromptsContainer`，两种模式共用同一个组件：

- **编程模式**（`proactive = false`）：`layout="chips"`，条目来自 Client Scenes 服务
  （`useDraftSuggestedPromptItems`），即截图里的「周报总结 / 报错修复 / PPT 制作 / 闲时任务」。
- **办公模式**（`proactive = true`，且 `proactiveSuggestionsEnabled === true`）：
  `layout="list"`，条目来自本地轮换池 `featureSuggestedPrompts`，带刷新与关闭按钮。

本次把两种模式的推荐区整体下线，并清理只为它存在的开关与文案。

## 产品规则

1. 草稿页 composer 下方不再有任何推荐区：编程模式没有 chips 行，办公模式没有主动推荐列表。
2. 设置页不再有「主动任务推荐」开关；引导（`OccupationOnboarding`）的偏好步不再询问推荐偏好。
3. `proactiveSuggestionsEnabled` 字段保留在 `packages/shared` 的设置校验与引导记录 schema 中，
   但不再有 UI 写入方；引导记录按“未表态”写 `null`，不伪造用户选择。

## 删除范围

整条链路只被这一个渲染点使用，因此按文件整体删除（约 2300 行）：

| 文件                                                                | 作用                                    |
| ------------------------------------------------------------------- | --------------------------------------- |
| `packages/ui/src/v4/ConversationDraftSuggestedPromptsContainer.tsx` | 渲染点：状态机、插件流、点击回填        |
| `packages/ui/src/v4/ConversationDraftSuggestedPrompts.tsx`          | chips / list 两种布局与插件操作 Popover |
| `packages/ui/src/v4/ConversationDraftSuggestedPluginFlow.tsx`       | 插件流阶段与埋点                        |
| `packages/ui/src/v4/useDraftSuggestedPluginActionPopover.ts`        | 插件操作 Popover 状态                   |
| `packages/ui/src/v4/useDraftSuggestedPromptItems.ts`                | Client Scenes → 推荐项                  |
| `packages/ui/src/v4/draftSuggestedPromptItems.ts`                   | 推荐项类型与文案解析                    |
| `packages/ui/src/v4/draftSuggestedPromptPrefill.ts`                 | 插件 mention 回填                       |
| `packages/ui/src/v4/featureSuggestedPrompts.ts`                     | 办公模式本地推荐语料                    |
| `packages/ui/src/v4/featureSuggestedPromptRotation.ts`              | 办公模式轮换与订阅                      |
| `packages/ui/src/v4/useComposerTextInsertApplied.ts`                | 仅被推荐点击回填等待使用                |
| `packages/ui/src/lib/promptTemplateTelemetry.ts`                    | 仅被推荐点击上报使用                    |
| `packages/ui/src/settings/ProactiveSuggestionsSetting.tsx`          | 设置页开关（失去消费者）                |

**保留**：Client Scenes 服务与 `hooks/useClientScenesResource.ts`（自动化模板仍在用）、
`components/ClientSceneLucideIcon.tsx`（闲时/定时模板图标仍在用）、
`lib/zcodeDraftSkillInvalidation.ts`（多个设置页与标题栏入口仍在用）。

同时删除只服务于该功能的文案与样式：

- 文案 key（中英同步）：`chat.officeSuggestions.*`（7 条）、`chat.draft.suggestedPrompt.*`（20 条）、
  `occupationOnboarding.suggestions` / `.suggestionsDescription` / `.suggestionsHeading`。
- `packages/ui/src/styles.css` 的 `zcode-draft-prompt-waterfall` 关键帧、动画类与
  `prefers-reduced-motion` 降级块。

## 状态所有者

- 推荐状态随组件一起删除，不再有 `useSyncExternalStore` 订阅与 pane 注册。
- 「主动任务推荐」偏好不再有写入方；设置项字段与引导记录字段保留兼容，读取方已不存在。

## 验收场景

1. 编程模式新建任务：composer 下方没有 chips 行，composer 与下方元素间距不出现空白槽位。
2. 办公模式（`proactiveSuggestionsEnabled` 为 true）新建任务：composer 下方没有推荐列表，
   也没有刷新/关闭按钮。
3. 设置页「常规」页没有「主动任务推荐」开关；引导偏好步只有工作记忆与数据迁移两项。
4. 引导保存仍成功：设置补丁不再写 `proactiveSuggestionsEnabled`，引导记录该字段写 `null`。
5. 自动化模板、闲时任务模板图标、设置页其它入口不受影响。
