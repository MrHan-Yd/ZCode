import type { ModelSmartConfigView } from "@zcode/services";

/**
 * 「已配置规则」卡片的呈现状态。
 *
 * 规则明细默认收起：同步回来的规则常有几百条，展开会把设置页撑得很长，所以默认只显示条数。
 * 但只有 `list` 提供展开控件——规则为空时没有可展开的内容，本地文件解析失败时更要让错误直接可见，
 * 都不能被默认收起藏起来。
 */
export type ModelSmartConfigListState = "list" | "empty" | "error";

/**
 * 判定顺序与改动前的渲染分支一致：解析失败优先于条数判断，读取中（`view` 为 null）按空状态呈现。
 * `entries` 在这里只回答「有没有内容可展开」，具体条目仍由组件渲染。
 */
export function modelSmartConfigListState(
  view: ModelSmartConfigView | null,
): ModelSmartConfigListState {
  if (view?.error) return "error";
  if (!view || view.entries.length === 0) return "empty";
  return "list";
}
