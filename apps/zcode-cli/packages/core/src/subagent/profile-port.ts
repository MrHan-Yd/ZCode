import type { TraceContext } from "../runtime/deps.js";
import type { AgentProfile, BuiltInSubagentModelSelectionOverrides } from "./profile.js";

export interface SubagentProfileLoadOutcome {
  profiles: AgentProfile[];
  builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
}

/**
 * Session 运行期重新发现 Subagent 画像的端口。
 *
 * Core 不直接读磁盘；bootstrap 复用启动时同一套 Markdown / plugin loader 实现，
 * 使 Composer 的 `/` 目录、Agent 工具描述与真正派发时的 profile 集合始终同源。
 */
export interface SubagentProfilePort {
  loadProfiles(input: {
    workingDirectory: string;
    trace: TraceContext;
  }): Promise<SubagentProfileLoadOutcome>;
}
