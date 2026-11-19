import assert from "node:assert/strict";
import test from "node:test";
import { createTraceId } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { OrchestrationConfigState } from "@zcode/shared/zcode-protocol-v4";
import { restoreOrchestrationFromSession } from "../src/runtime/methods/orchestration.js";

const traceContext = { traceId: createTraceId() };

test("旧会话恢复补齐通用子代理，但不回写 entry 或触碰历史 run", async () => {
  const original = { enabled: true, team: ["general-purpose", "tester"], maxConcurrency: 2 };
  const updates: OrchestrationConfigState[] = [];
  const runtime = {
    sessionId: "fixture-session",
    config: {},
    activeTurn: {},
    sessionStore: { sessionEntries: async () => [{ data: original }] },
    rootTraceContext: traceContext,
    orchestrationService: {
      updateConfiguration: (input: OrchestrationConfigState) => updates.push(input),
      restore: async () => ({ records: 0, interrupted: 0, invalidRecords: 0 }),
    },
    invalidateToolCache: () => {},
  } as unknown as AgentRuntimeInternal;
  const result = await restoreOrchestrationFromSession.call(runtime, traceContext);
  assert.equal(result.enabled, true);
  assert.deepEqual(runtime.config.orchestration?.team, ["general-purpose", "Explore", "tester"]);
  assert.deepEqual(original.team, ["general-purpose", "tester"]);
  assert.deepEqual(updates[0]?.team, ["general-purpose", "Explore", "tester"]);
});
