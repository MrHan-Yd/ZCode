/**
 * 冷启动 / 全盘扫描时 Git 命令可能连续超过 15s 超时，协调器的内联重试（1.5s / 4s）
 * 覆盖不到这种持续负载。当本轮工作区从未成功读到仓库时，再按下面的低频节奏补偿刷新；
 * 次数有上限，避免对真正不可用的仓库（git 缺失、权限拒绝）无限轮询。
 *
 * 说明：补偿刷新只负责「让入口自己回来」，不占用任何 await —— 已展示错误/失败的
 * 调用方不会被拉长等待。见 `specs/git-tools-entry-visibility.md` 规则 11。
 */
const GIT_REPOSITORY_HEAL_DELAYS_MS = [10_000, 30_000, 60_000] as const;

/** 第 `attempt` 次补偿刷新前等待多久；超出上限返回 null（停止补偿）。 */
export function nextGitRepositoryHealDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) {
    return null;
  }
  return GIT_REPOSITORY_HEAL_DELAYS_MS[attempt] ?? null;
}
