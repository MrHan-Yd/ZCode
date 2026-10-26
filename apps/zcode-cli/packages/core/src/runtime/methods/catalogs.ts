import type { SkillLoadOutcome } from "@zcode/contracts";
import type { AgentProfile } from "../../subagent/profile.js";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

export interface AgentCatalogRefreshResult {
  skillsChanged: boolean;
  subagentsChanged: boolean;
}

/**
 * 只比较会影响“模型可见能力”的 Skill 字段。
 *
 * 文件正文变化不改变元数据时无需重建 context prefix：Skill 工具每次调用都会重新读文件，
 * 系统提示词里只需要最新的名称/描述。目录扫描失败（diagnostics 带 skill_scan_failed）
 * 时调用方会保留旧快照，避免一次瞬时 IO 故障清空能力列表。
 */
export function buildSkillCatalogKey(outcome: SkillLoadOutcome | undefined): string {
  return JSON.stringify(
    (outcome?.skills ?? [])
      .map((skill) => ({
        description: skill.description,
        name: skill.name,
        path: skill.path,
        pluginId: skill.pluginId ?? null,
        pluginName: skill.pluginName ?? null,
        qualifiedName: skill.qualifiedName ?? null,
        scope: skill.scope,
        source: skill.source,
        whenToUse: skill.whenToUse ?? null,
      }))
      .sort(
        (left, right) => left.path.localeCompare(right.path) || left.name.localeCompare(right.name),
      ),
  );
}

/** profile 的 systemPrompt 也参与比较：改正文而不改名时，下一次 Agent 派发必须用新内容。 */
export function buildSubagentCatalogKey(profiles: readonly AgentProfile[] | undefined): string {
  return JSON.stringify(
    [...(profiles ?? [])]
      .map((profile) => ({
        background: profile.background ?? null,
        color: profile.color ?? null,
        description: profile.description,
        disallowedTools: profile.disallowedTools ?? null,
        injectAgentsMd: profile.injectAgentsMd ?? null,
        maxTurns: profile.maxTurns ?? null,
        mcpServers: profile.mcpServers ?? null,
        memory: profile.memory ?? null,
        modelSelection: profile.modelSelection ?? null,
        name: profile.name,
        path: profile.path ?? null,
        permissionMode: profile.permissionMode ?? null,
        skills: profile.skills ?? null,
        source: profile.source,
        systemPrompt: profile.systemPrompt,
        tools: profile.tools ?? null,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  );
}

function hasSkillScanFailure(outcome: SkillLoadOutcome): boolean {
  return outcome.diagnostics.some((diagnostic) => diagnostic.code === "skill_scan_failed");
}

/**
 * Composer 打开 `/` 或 `$` 面板时刷新本 Session 的目录快照。
 *
 * 背景：Skill 与 Subagent 都在 runtime 首次初始化时冻结，用户新增文件后旧会话看不到，
 * 只能重启应用。这里在面板打开时重新发现，并只在集合真正变化时更新 snapshot：
 * - Skill 更新 `skillLoadOutcome`；下一次 model step 的 `rebuildContextPrefix` 会带上新清单。
 * - Subagent 更新 `config.subagents.profiles`，并重新注册 Agent/Task 的工具描述；
 *   subagent port 通过 getter 读取同一份 profile，派发不会落到旧数组。
 *
 * 不在方法内重建 context prefix：turn loop 每个 model step 都会重建；面板打开可能发生在
 * 一个进行中的 turn 内，直接 replace message history 的 prefix 会破坏正在流式执行的请求。
 */
export async function refreshAgentCatalogs(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<AgentCatalogRefreshResult> {
  const wasInitialized = this.contextInitialized;
  if (!wasInitialized) {
    // 新 Session 第一次打开面板：ensureContextInitialized 已经用磁盘当前状态完成首轮发现。
    await this.ensureContextInitialized(traceContext);
  }

  let skillsChanged = false;
  if (wasInitialized && this.skillPort) {
    const next = await this.discoverSkillsForContext(traceContext);
    if (
      next &&
      !hasSkillScanFailure(next) &&
      buildSkillCatalogKey(next) !== buildSkillCatalogKey(this.skillLoadOutcome)
    ) {
      this.skillLoadOutcome = next;
      skillsChanged = true;
    }
  }

  let subagentsChanged = false;
  if (this.subagentProfilePort && this.config.subagents?.enabled !== false) {
    try {
      const next = await this.subagentProfilePort.loadProfiles({
        workingDirectory: this.workingDirectory,
        trace: traceContext,
      });
      if (
        buildSubagentCatalogKey(next.profiles) !==
        buildSubagentCatalogKey(this.config.subagents?.profiles)
      ) {
        this.config.subagents = {
          ...this.config.subagents,
          profiles: next.profiles,
          ...(next.builtInModelSelectionOverrides === undefined
            ? {}
            : { builtInModelSelectionOverrides: next.builtInModelSelectionOverrides }),
        };
        subagentsChanged = true;
      }
    } catch (error) {
      // 重新发现失败时保留旧 profile；Agent 工具仍按旧清单可用，比整块清空安全。
      this.logger?.warn("Subagent profile refresh failed", {
        ...traceContextToLogContext(traceContext),
        error: error instanceof Error ? error.message : String(error),
        event: "subagent.catalog.refresh.failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }

  if (subagentsChanged) {
    // Agent/Task 的 provider description 在注册时烘焙；profile 变化必须重注册并丢工具缓存。
    // 重新注册只覆盖内置工具，不触碰 MCP / 插件工具。
    this.refreshBuiltInTools?.();
    this.invalidateToolCache();
  }

  if (skillsChanged || subagentsChanged) {
    this.logger?.info("Agent catalogs refreshed", {
      ...traceContextToLogContext(traceContext),
      event: "agent.catalog.refreshed",
      module: "core.runtime",
      skillsChanged,
      status: "completed",
      subagentsChanged,
    });
  }

  return { skillsChanged, subagentsChanged };
}
