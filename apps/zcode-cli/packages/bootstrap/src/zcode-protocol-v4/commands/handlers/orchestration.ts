import type {
  CommandEnvelope,
  CommandPayloadMap,
  CommandResult,
} from "@zcode/shared/zcode-protocol-v4";
import { requireRecord } from "../record-access.js";
import type { V4CommandCoreHost } from "../types.js";
import { V4CapabilityUnsupportedError } from "./interaction-background.js";

/**
 * 编排配置命令。
 *
 * 只调用 app 的唯一入口；工具面重注册、session entry 持久化与 service 生命周期都在
 * runtime 内完成。活动 run 不被取消，配置从下一轮 turn 生效。
 */
async function setOrchestration(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["setOrchestration"];
  const record = requireRecord(host, envelope.sessionId);
  await record.app.setOrchestration({
    enabled: payload.enabled,
    ...(payload.team ? { team: payload.team } : {}),
    ...(payload.maxConcurrency === undefined
      ? {}
      : { maxConcurrency: payload.maxConcurrency }),
  });
  return undefined;
}

/** 时间线停止按钮；不触及主会话 turn 或其他后台任务。 */
async function cancelOrchestrationRun(
  host: V4CommandCoreHost,
  envelope: CommandEnvelope,
): Promise<CommandResult | undefined> {
  const payload = envelope.payload as CommandPayloadMap["cancelOrchestrationRun"];
  const record = requireRecord(host, envelope.sessionId);
  if (!record.app.cancelOrchestrationRun) {
    throw new V4CapabilityUnsupportedError("cancelOrchestrationRun", record.app.sessionId);
  }
  await record.app.cancelOrchestrationRun(payload.runId);
  return undefined;
}

export const orchestrationHandlers = {
  cancelOrchestrationRun,
  setOrchestration,
};
