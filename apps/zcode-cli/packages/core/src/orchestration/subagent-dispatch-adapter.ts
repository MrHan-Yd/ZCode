import type { SubagentPort, SubagentTaskSnapshot } from "@zcode/contracts";
import { OrchestrationStoreError } from "./contract.js";
import {
  orchestrationSubagentRequest,
  type OrchestrationDispatchHandle,
  type OrchestrationDispatchPort,
  type OrchestrationDispatchResult,
} from "./dispatch-port.js";

export class SubagentOrchestrationDispatchAdapter implements OrchestrationDispatchPort {
  constructor(private readonly subagents: SubagentPort) {}

  async stopChild(child: { taskId: string }): Promise<void> {
    const { stopTask, waitForTaskQuiescence } = this.subagents;
    if (!stopTask) {
      throw new OrchestrationStoreError(
        "capability_unavailable",
        "Orchestration cannot stop a recovered child without explicit stop capability.",
      );
    }
    await stopTask.call(this.subagents, child.taskId);
    if (waitForTaskQuiescence) await waitForTaskQuiescence.call(this.subagents, child.taskId);
  }

  async start(
    input: Parameters<OrchestrationDispatchPort["start"]>[0],
  ): Promise<OrchestrationDispatchHandle> {
    const { start, getTask, waitForTask, stopTask, waitForTaskQuiescence } = this.subagents;
    if (!start || !getTask || !waitForTask || !stopTask) {
      throw new OrchestrationStoreError(
        "capability_unavailable",
        "Orchestration requires child start, observation, wait, and explicit stop capabilities.",
      );
    }
    if (input.record.owner.sessionId !== input.context.sessionId) {
      throw new OrchestrationStoreError(
        "owner_mismatch",
        "Orchestration dispatch must use its parent session.",
      );
    }
    if (!input.record.team.includes(input.claim.step.role)) {
      throw new OrchestrationStoreError(
        "invalid_plan",
        "Orchestration step role is not in the frozen run team.",
      );
    }
    input.signal.throwIfAborted();
    const output = await start.call(this.subagents, orchestrationSubagentRequest(input), {
      signal: input.signal,
      ...(input.context.model ? { model: input.context.model } : {}),
      // run 创建时已冻结 team；派发解析必须用它而不是会话实时配置，否则运行中关闭编排或
      // 收缩团队会让在飞 run 的剩余专业步骤变成 not found。
      visibleProfiles: input.record.team,
    });
    const child = {
      agentId: output.agentId,
      taskId: output.backgroundTaskId,
      childSessionId: output.childSessionId,
      outputFile: output.outputFile,
    };
    let stopPromise: Promise<void> | undefined;
    let waitPromise: Promise<OrchestrationDispatchResult> | undefined;
    return {
      child,
      wait: () =>
        (waitPromise ??= (async () => {
          const current = await getTask.call(this.subagents, child.taskId);
          const snapshot =
            current?.status === "running"
              ? await waitForTask.call(this.subagents, child.taskId, { signal: input.signal })
              : current;
          return normalizeChildResult(snapshot, child.agentId, input.claim.step.role);
        })()),
      stop: () =>
        (stopPromise ??= (async () => {
          const snapshot = await stopTask.call(this.subagents, child.taskId);
          if (!snapshot || snapshot.status === "running") {
            throw new OrchestrationStoreError(
              "capability_unavailable",
              "Child stop did not confirm a terminal state.",
            );
          }
          // 新端提供真实执行退出屏障时优先使用；旧端仍以 stop 的终态账本为边界。
          if (waitForTaskQuiescence) await waitForTaskQuiescence.call(this.subagents, child.taskId);
        })().catch((error: unknown) => {
          stopPromise = undefined;
          throw error;
        })),
    };
  }
}

function normalizeChildResult(
  snapshot: SubagentTaskSnapshot | undefined,
  agentId: string,
  agentType: string,
): OrchestrationDispatchResult {
  if (!snapshot || snapshot.agentId !== agentId || snapshot.agentType !== agentType) {
    return { status: "interrupted", error: "Child execution has no reliable terminal identity." };
  }
  switch (snapshot.status) {
    case "completed": {
      const output = snapshot.output;
      if (
        output?.status !== "completed" ||
        output.agentId !== agentId ||
        output.agentType !== agentType
      ) {
        return {
          status: "interrupted",
          error: "Completed child has no confirmed completed output.",
        };
      }
      return {
        status: "completed",
        content: output.content.map((block) => block.text).join("\n\n"),
      };
    }
    case "failed":
      return { status: "failed", error: snapshot.error ?? "Child execution failed." };
    case "cancelled":
    case "killed":
    case "stopped":
      return { status: "cancelled", error: snapshot.error ?? "Child execution was cancelled." };
    case "lost":
    case "running":
      return {
        status: "interrupted",
        error: snapshot.error ?? "Child execution has no reliable terminal result.",
      };
  }
}
