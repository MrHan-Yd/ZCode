import { createChildTraceContext, createQueryId, createTurnId } from "../deps.js";
import { traceContextToLogContext } from "../deps.js";
import type { QueryId, TurnInputIntentMetadata } from "../deps.js";
import type { PromptRuntimeCommand } from "../command-queue.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";
import type { OrchestrationService } from "../../orchestration/service.js";
import {
  decideOrchestrationInput,
  resolveOrchestrationInputMode,
  shouldPromoteDeferredOrchestrationInput,
} from "../../orchestration/input-policy.js";
import type {
  ActiveTurnStartReservation,
  ExecuteTurnOptions,
  PromptAdmissionOptions,
  PromptAdmissionReceipt,
  TurnResult,
} from "../types.js";

/**
 * 每个 AgentRuntime 自己完成 prompt 的 admission：检查 busy 边界、建立 reservation、
 * 把 command 放进该 runtime 的 FIFO。Bootstrap 不应把这些步骤拆开，否则 reservation
 * 建立前的异步窗口会让同一 session 产生第二条 turn。
 */
export async function admitPrompt(
  this: AgentRuntimeInternal,
  input: string,
  attachments?: Parameters<AgentRuntimeInternal["executeTurn"]>[1],
  options?: PromptAdmissionOptions,
): Promise<PromptAdmissionReceipt> {
  const promotionLeaseOnly =
    options?.requireIdle === true &&
    this.foregroundPromotionLease !== undefined &&
    this.activeForegroundExecution === undefined &&
    this.runtimeCommandDrainActive === false &&
    this.runtimeCommandQueue.hasPending() === false &&
    this.activeTurn === undefined &&
    this.activeTurnStartReservation === undefined;
  const busy = this.hasActiveOrQueuedTurnWork() && !promotionLeaseOnly;
  const orchestration = this.orchestrationService;
  const orchestrationInput = resolveOrchestrationInputMode(options?.orchestrationInput);
  const activeRunIds = orchestration?.activeRunIds() ?? [];
  // interrupt 是显式用户选择：即使主会话正在跑 turn，也要先停编排 run。
  const interrupted = orchestration !== undefined && orchestrationInput === "interrupt";
  if (orchestration && interrupted && activeRunIds.length > 0) {
    try {
      await orchestration.cancelActiveRuns();
    } catch (error) {
      // interrupt 的取消已经按 run 尽力完成；停止某个 child 失败不能让这条用户消息
      // 直接消失。旧 generation 的迟到结果仍会被 RunStore 拒绝，这里只记录原错误。
      this.logger?.warn("Orchestration interrupt could not stop every child", {
        ...traceContextToLogContext(options?.traceContext ?? this.rootTraceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "orchestration.input.interrupt_failed",
        module: "core.runtime",
        status: "failed",
      });
    }
  }
  // 取消已经发生，不再让决策表第二次返回 cancel_then_admit。
  const orchestrationDecision =
    orchestration && !interrupted
      ? decideOrchestrationInput({
          mode: orchestrationInput,
          activeRunIds,
          sessionBusy: busy,
        })
      : ({ action: "admit" } as const);

  if (busy) {
    if (options?.requireIdle === true || options?.modelExecution !== undefined) {
      return {
        activeTurnId: this.activeTurn?.turnId,
        kind: "rejected",
        reason: this.activeTurn ? "turn_not_steerable" : "no_active_turn",
      };
    }

    const activeTurn = this.activeTurn;
    const effectiveQueueDelivery =
      orchestrationInput === "queue" ? ("queue" as const) : options?.queueDelivery;
    const canSteer =
      attachments === undefined &&
      activeTurn?.steerable === true &&
      (effectiveQueueDelivery === "guide" ||
        options?.delivery === "auto" ||
        options?.delivery === "steer_active_turn") &&
      effectiveQueueDelivery !== "queue";
    if (canSteer) {
      const delivery = effectiveQueueDelivery === "guide" ? "guide" : undefined;
      return await this.steerTurn({
        commandKind: options?.commandKind,
        delivery,
        expectedTurnId: options?.expectedTurnId,
        input,
        inputPresentation:
          options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
        inputId: options?.inputId,
        intent: admissionIntent(options?.intent, delivery ?? "queue"),
        queryId: options?.queryId,
        toolDisallowlist: options?.toolDisallowlist,
        traceContext: options?.traceContext,
      });
    }

    const delivery =
      effectiveQueueDelivery === "guide" && attachments === undefined ? "guide" : "queue";
    return await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
  }

  if (!busy && orchestration && orchestrationDecision.action === "defer_until_idle") {
    // 复用既有 held queue：事件与 session input 账本都已存在，run 收口后
    // 走与 sendQueuedNow 相同的提升路径，不再造第二个队列。
    const delivery = "queue" as const;
    const queued = await this.enqueueDeferredInput({
      attachments,
      commandKind: options?.commandKind,
      delivery,
      input,
      inputPresentation:
        options?.inputPresentation ?? (!options?.inputSource ? "user_steer" : undefined),
      inputId: options?.inputId,
      intent: admissionIntent(options?.intent, delivery),
      queryId: options?.queryId,
      toolDisallowlist: options?.toolDisallowlist,
      traceContext: options?.traceContext,
    });
    if (queued.kind === "queued") {
      scheduleDeferredOrchestrationPromotion(this, orchestration, {
        attachments,
        input,
        options,
        pendingInputId: queued.pendingInputId,
      });
    }
    return queued;
  }

  const queryId = options?.queryId ?? (options?.inputId as QueryId | undefined) ?? createQueryId();
  const turnId = createTurnId();
  const turnTraceContext = createChildTraceContext(options?.traceContext ?? this.rootTraceContext, {
    queryId,
    sessionId: this.sessionId,
    turnId,
    attributes: { turnNumber: this.turnNumber },
  });
  const reservation: ActiveTurnStartReservation = {
    kind: "regular",
    traceContext: turnTraceContext,
    turnId,
  };
  this.reserveTurnStart(turnId, turnTraceContext, "regular");

  const executeOptions = options as ExecuteTurnOptions | undefined;
  const completion = enqueueCancellableRuntimeCommand<TurnResult, PromptRuntimeCommand>(this, {
    abortSignal: options?.abortSignal,
    onCommandCancelled: () => this.releaseTurnStart(turnId),
    createCommand: ({ reject, resolve }) => ({
      attachments,
      createdAt: new Date(),
      id: createRuntimeCommandId(),
      input,
      mode: "prompt",
      options: {
        ...executeOptions,
        queryId,
        traceContext: options?.traceContext ?? this.rootTraceContext,
      },
      priority: "next",
      reject,
      resolve,
      startReservation: reservation,
      traceContext: turnTraceContext,
    }),
  });
  // admission 已经完成；执行失败由现有 turn 事件/调用方消费，不制造 unhandled rejection。
  void completion.catch(() => undefined);
  return { completion, kind: "started", turnId };
}

function admissionIntent(
  intent: TurnInputIntentMetadata | undefined,
  admittedDelivery: "guide" | "queue",
): TurnInputIntentMetadata | undefined {
  return intent ? { ...intent, admittedDelivery } : undefined;
}

/**
 * queue 语义的提升：run 全部收口后，把仍留在 held queue 里的同一条输入
 * 走普通 admission。用户已通过 sendQueuedNow / delete 处理过的项目不会重复执行。
 */
function scheduleDeferredOrchestrationPromotion(
  runtime: AgentRuntimeInternal,
  service: OrchestrationService,
  input: {
    attachments: Parameters<AgentRuntimeInternal["executeTurn"]>[1];
    input: string;
    options: PromptAdmissionOptions | undefined;
    pendingInputId: string;
  },
): void {
  const traceContext = input.options?.traceContext ?? runtime.rootTraceContext;
  const reservationId = `orchestration-defer-${input.pendingInputId}`;
  void service
    .whenIdle()
    .then(async () => {
      if (!shouldPromoteDeferredOrchestrationInput({ shuttingDown: runtime.shuttingDown })) return;
      // 与 UI sendQueuedNow 共用同一把 reservation：用户此时手动发送/删除时，
      // 双方只有一方能提升，另一方直接让出，不会把同一条消息执行两次。
      const reserved = await runtime.reservePendingInputById({
        pendingInputId: input.pendingInputId,
        reservationId,
        traceContext,
      });
      if (!reserved) return;
      await runtime.markPendingInputPromoting({
        pendingInputId: input.pendingInputId,
        reservationId,
        traceContext,
      });
      const removed = await runtime.discardHeldPendingInputById(
        input.pendingInputId,
        traceContext,
        reservationId,
        "promoted",
      );
      if (!removed) {
        await runtime.releasePendingInputReservation({
          pendingInputId: input.pendingInputId,
          reservationId,
          traceContext,
        });
        return;
      }
      await runtime.admitPrompt(input.input, input.attachments, {
        ...input.options,
        expectedTurnId: undefined,
        orchestrationInput: undefined,
      });
    })
    .catch((error) => {
      runtime.logger?.warn("Deferred orchestration input could not be promoted", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "orchestration.input.promote_failed",
        module: "core.runtime",
        pendingInputId: input.pendingInputId,
        status: "failed",
      });
    });
}
