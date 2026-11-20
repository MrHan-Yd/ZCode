import type { OrchestrationRunProjection } from "@zcode/shared/zcode-protocol-v4";
import type {
  OrchestrationRoleView,
  OrchestrationTeamPreset,
} from "@/v4/composer/orchestrationTeamModel.js";

/**
 * Composer 内编排控件的唯一输入面。
 *
 * 会话状态全部由 SessionPane 持有（草稿意图 + 只读查询投影）；这些组件是纯展示件，
 * 只回调用户动作，不自行发命令、不维护第二份 team/run 状态。
 *
 * 运行中发送不再有三态选择：发送框始终只有一个输入框；存在活动 run 时发送
 * 按 queue 进入既有队列列表（显式 startNow 除外），停止 / 重排是状态面板计划
 * 分区的显式动作，立即打断走队列项的「立即发送」。
 */
export interface OrchestrationComposerControls {
  /** 当前 Host/会话是否支持编排（旧端或缺失能力时隐藏入口）。 */
  available: boolean;
  enabled: boolean;
  team: readonly string[];
  roles: readonly OrchestrationRoleView[];
  runs: readonly OrchestrationRunProjection[];
  activeRuns: readonly OrchestrationRunProjection[];
  onToggleEnabled: () => void;
  onToggleRole: (role: string) => void;
  /** 全选/取消全选切换：已全选时清空专业角色（会触发编排关闭）。 */
  onToggleSelectAll: () => void;
  onApplyPreset: (preset: OrchestrationTeamPreset) => void;
  /** 跳设置页 subagents 段；role 用于尽量定位到具体角色。 */
  onOpenRoleSettings: (role?: string) => void;
}
