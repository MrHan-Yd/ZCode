// 自动归档的常驻扫描：跑在 scheduler 进程里（tasks-index 属主、app 单例），
// 与 AutomationRepo / OffPeakTaskRepo 同库；判定实现与 host 即时路径共享（taskAutoArchive）。
import {
  createSettingService,
  runTaskAutoArchiveSweep,
  TaskIndexRepo,
} from "@zcode/services/node";
import { resolveWorkspaceKey, type PersistedWorkspaceSessionEntry } from "@zcode/shared";

/**
 * 常驻扫描间隔。归档是幂等索引扫描，首次之后基本空跑（单工作区走 partial index）；
 * 1 小时足以让超期旧任务在下一个周期内收敛，又不会频繁唤醒。设更大值可进一步降开销。
 */
const AUTO_ARCHIVE_SCAN_INTERVAL_MS = 60 * 60_000;

type SchedulerLogLevel = "info" | "warn" | "error";

export interface AutoArchiveScanner {
  /** 与 tick 同步调用；内部按间隔节流 + 单飞，错误一律内部收口，永不抛出。 */
  run(now: number): Promise<void>;
}

/** 索引里出现过的工作区 ∪ 最近打开过的工作区（去重按 workspaceIdentity||path）。 */
function mergeAutoArchiveScopes(
  indexed: ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>,
  persisted: ReadonlyArray<PersistedWorkspaceSessionEntry> | undefined,
  recentProjects: ReadonlyArray<string> | undefined,
): Array<{ workspacePath: string; workspaceIdentity?: string }> {
  const byKey = new Map<string, { workspacePath: string; workspaceIdentity?: string }>();
  const add = (scope: { workspacePath: string; workspaceIdentity?: string }) => {
    if (!scope.workspacePath?.trim()) return;
    const key = resolveWorkspaceKey(scope);
    if (key.trim().length > 0) byKey.set(key, scope);
  };
  for (const scope of indexed) add(scope);
  // 索引里暂时没有任务、但最近打开过的项目也要覆盖，避免刚打开过的老项目被漏扫。
  for (const entry of persisted ?? []) {
    add({
      workspacePath: entry.workspacePath,
      workspaceIdentity: "workspaceIdentity" in entry ? entry.workspaceIdentity : undefined,
    });
  }
  for (const path of recentProjects ?? []) add({ workspacePath: path });
  return [...byKey.values()];
}

export function createAutoArchiveScanner(params: {
  log: (level: SchedulerLogLevel, message: string) => void;
}): AutoArchiveScanner {
  const { log } = params;
  const repo = new TaskIndexRepo();
  let settingService: ReturnType<typeof createSettingService> | null = null;
  let lastScanAt = 0;
  let scanning = false;

  // scheduler 的 log 适配成 ServiceLogger，让共享实现按服务日志落盘。
  const serviceLog = {
    debug: () => {},
    info: (_traceId: unknown, ...args: unknown[]) => log("info", args.map(String).join(" ")),
    warn: (_traceId: unknown, ...args: unknown[]) => log("warn", args.map(String).join(" ")),
    error: (_traceId: unknown, ...args: unknown[]) => log("error", args.map(String).join(" ")),
  };

  async function run(now: number): Promise<void> {
    if (scanning) return;
    if (now - lastScanAt < AUTO_ARCHIVE_SCAN_INTERVAL_MS) return;
    scanning = true;
    lastScanAt = now;
    try {
      settingService ??= createSettingService();
      const settings = await settingService.get();
      // 关闭开关时连工作区枚举都跳过，避免无意义的索引扫描。
      if (!settings.taskAutoArchiveEnabled) return;
      const scopes = mergeAutoArchiveScopes(
        await repo.listWorkspaceScopes(),
        settings.lastWorkspaceSession,
        settings.recentProjects,
      );
      const { archivedCount } = await runTaskAutoArchiveSweep({
        taskIndexRepo: repo,
        settingService,
        scopes,
        log: serviceLog,
      });
      if (archivedCount > 0) {
        log(
          "info",
          `auto-archive swept ${archivedCount} task(s) across ${scopes.length} workspace scope(s)`,
        );
      }
    } catch (error) {
      // 常驻任务不能让错误冒泡到 tick 循环；下一轮节流到期后自然重试。
      log(
        "warn",
        `auto-archive scan failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      scanning = false;
    }
  }

  return { run };
}
