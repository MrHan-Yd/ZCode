import type { OrchestrationRunProjection } from "@zcode/shared/zcode-protocol-v4";
import type {
  OrchestrationRoleView,
  OrchestrationTeamPreset,
} from "@/v4/composer/orchestrationTeamModel.js";

export type OrchestrationInputMode = "guide" | "queue" | "interrupt";

/**
 * Composer 内编排控件的唯一输入面。
 *
 * 会话状态全部由 SessionPane 持有（草稿意图 + 只读查询投影）；这些组件是纯展示件，
 * 只回调用户动作，不自行发命令、不维护第二份 team/run 状态。
 */
export interface OrchestrationComposerControls {
  /** 当前 Host/会话是否支持编排（旧端或缺失能力时隐藏入口）。 */
  available: boolean;
  enabled: boolean;
  team: readonly string[];
  roles: readonly OrchestrationRoleView[];
  runs: readonly OrchestrationRunProjection[];
  activeRuns: readonly OrchestrationRunProjection[];
  inputMode: OrchestrationInputMode;
  onToggleEnabled: () => void;
  onToggleRole: (role: string) => void;
  onApplyPreset: (preset: OrchestrationTeamPreset) => void;
  /** 跳设置页 subagents 段；role 用于尽量定位到具体角色。 */
  onOpenRoleSettings: (role?: string) => void;
  onInputModeChange: (mode: OrchestrationInputMode) => void;
  onStopRun: (runId: string) => void;
  onViewChild: (childSessionId: string) => void;
  /** 切到 interrupt 语义并聚焦输入框；绝不代发消息。 */
  onRequestReplan: () => void;
}
