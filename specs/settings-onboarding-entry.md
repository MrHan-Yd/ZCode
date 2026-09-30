# 设置页的「引导」入口（Settings onboarding entry）

## 背景

设置页此前有两处「引导」入口，作用相同：把 Zustand store 的 `newUserOnboardingOpen` 置为 `true`，
由 `packages/ui/src/onboarding/OccupationOnboarding.tsx` 接管，弹出"重新选择职业、界面模式和使用偏好"
的引导。

1. 侧栏尾部的独立按钮：带虚线边框与火箭图标（`SettingsPage.tsx` 侧栏 `<nav>` 内，位于分组列表之后）。
2. 「常规」页底部的整卡行：标题「引导」、描述「重新选择职业、界面模式和使用偏好。数据迁移可在迁移设置中操作。」、
   按钮「打开引导」（`settingsPageHelpers.tsx` 的 `GeneralSectionContent` 末尾）。

两处都已删除，设置页不再有引导入口。

## 产品规则

1. 设置页侧栏只渲染 `settingsSectionGroups` 里的 section 项，尾部没有额外按钮。
2. 「常规」页底部不再有引导卡片；该页最后一张卡片是"数据目录"分组。
3. 引导本身照旧存在，只是入口不在设置页：
   - 首次启动时由 `useSettingsSync` 的发现结果触发；
   - 键盘快捷键 `CmdOrCtrl+Shift+O`（`packages/shared/src/shortcutCommands.ts`）可开关；
   - 新用户欢迎弹窗 `OnboardingDialog`（`Root.tsx`）与迁移向导不受影响。

## 状态所有者

- **引导开关**：Zustand store 的 `newUserOnboardingOpen`（`packages/ui/src/store/index.ts`）。
  设置页删除入口后，写入方只剩 `OccupationOnboarding` 自身与首启同步逻辑。
- **迁移入口请求**：store 的 `onboardingDialogRequested` / `requestOnboardingDialog(entry?)` 是另一条
  独立路径（由 `OccupationOnboarding` 用于跳迁移），与本次删除的同名局部回调无关，保持不动。

## 接口变更

- `GeneralSectionContent` 去掉 `onOpenOnboardingDialog` prop。
- `SettingsPage` 不再订阅 `setNewUserOnboardingOpen`，局部 `requestOnboardingDialog` 一并删除。
- `packages/ui/src/lib/userActionTraceCatalog.ts` 的 `settings.navigation` 不再声明 `open_onboarding`；
  `open_section`、`back_to_workspace` 保留。
- 删除失去引用的文案 key：`settings.onboarding`、`settings.onboardingDescription`、
  `settings.onboardingOpen`（中英同步）。

## 验收场景

1. 打开设置页：侧栏从「常规」到「快捷键」全是分组 section 项，尾部没有虚线边框的「引导」按钮。
2. 「常规」页滚到底：最后一张卡片是"数据目录"，没有「引导 / 打开引导」行。
3. 快捷键 `CmdOrCtrl+Shift+O` 仍能开关全屏引导；首次启动流程不变。
4. 侧栏分组、选中态、键盘导航与 `data-testid` 行为不受影响。
