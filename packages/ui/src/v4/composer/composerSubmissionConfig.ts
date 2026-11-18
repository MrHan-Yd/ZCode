import {
  normalizeOrchestrationTeamSelection,
  resolveExecutionState,
  type ModelSelection,
} from "@zcode/shared";
import { submissionModeSchema, type SubmissionMode } from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelectionView } from "@zcode/services";
import { validateModelSelectionOptions } from "@zcode/provider";

export interface ComposerOrchestrationSubmissionConfig {
  enabled: boolean;
  team: string[];
}

export interface ComposerSubmissionConfig {
  modelSelection: ModelSelection;
  mode: SubmissionMode;
  planEnabled: boolean;
  /** 仅 createSession.config 消费；已有会话由 setOrchestration 单独下发。 */
  orchestration?: ComposerOrchestrationSubmissionConfig;
  /** 运行中发送语义；交给 Core admission 裁决，无活动 run 时忽略。 */
  orchestrationInput?: "guide" | "queue" | "interrupt";
}

/** 在点击提交的瞬间，把 Composer 意图冻结成本次 Submission 的执行配置。 */
export function createComposerSubmissionConfig(
  composer:
    | {
        mode?: string;
        planEnabled?: boolean;
        modelSelection?: ModelSelection;
        orchestrationEnabled?: boolean;
        subagentPool?: readonly string[];
        orchestrationInputMode?: "guide" | "queue" | "interrupt";
      }
    | null
    | undefined,
  view: ModelSelectionView | null,
): ComposerSubmissionConfig | null {
  // 只读子会话和未挂载 Composer 的 SessionPane 不提供草稿；这类场景没有可提交配置，
  // 不能因为渲染提交门禁而读取 undefined 并让整个会话区域崩溃。
  if (!composer) {
    return null;
  }
  const selection = composer.modelSelection;
  const mode = submissionModeSchema.safeParse(composer.mode);
  const model =
    selection &&
    view?.providers
      .find((provider) => provider.providerId === selection.providerId)
      ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!mode.success || !selection || !model || !validateModelSelectionOptions(model, selection).ok)
    return null;
  // 不读取 Session 或显示别名；复制所有选择叶子，防止 await 后用户切模改变本次请求。
  return Object.freeze({
    mode: mode.data === "plan" ? "build" : mode.data,
    planEnabled: resolveExecutionState(composer).planEnabled,
    modelSelection: Object.freeze({
      providerId: selection.providerId,
      modelId: selection.modelId,
      options: Object.freeze({ reasoningLevel: selection.options!.reasoningLevel! }),
    }),
    ...(composer.orchestrationEnabled === true
      ? {
          orchestration: Object.freeze({
            enabled: true,
            team: normalizeOrchestrationTeamSelection(composer.subagentPool),
          }),
        }
      : {}),
    ...(composer.orchestrationInputMode
      ? { orchestrationInput: composer.orchestrationInputMode }
      : {}),
  });
}
