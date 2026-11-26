import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createSessionId, createTraceId, type SubagentLaunchRequest } from "@zcode/contracts";
import { resolveVisibleSubagentProfileNames } from "../src/orchestration/tool-policy.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";

function launchRequest(root: string, agentType: string): SubagentLaunchRequest {
  return {
    sessionId: createSessionId(),
    parentToolCallId: `tool-${agentType}`,
    agentType,
    description: `${agentType} step`,
    prompt: "run the step",
    workingDirectory: root,
    workspaceRoot: root,
    trace: { traceId: createTraceId() },
  };
}

test("可见角色从编排团队派生，关闭编排后回落经典两角色", () => {
  assert.deepEqual(
    resolveVisibleSubagentProfileNames({
      orchestration: { enabled: true, team: ["general-purpose", "Explore", "tester"] },
    }),
    ["general-purpose", "Explore", "tester"],
  );
  // 团队缺省时与运行期归一化一致，不能只留经典两角色。
  assert.deepEqual(resolveVisibleSubagentProfileNames({ orchestration: { enabled: true } }), [
    "general-purpose",
    "Explore",
    "bug-fixer",
    "reviewer",
  ]);
  assert.equal(
    resolveVisibleSubagentProfileNames({ orchestration: { enabled: false } }),
    undefined,
  );
  // 关闭编排时宿主的显式名单仍然生效，不被派生逻辑吞掉。
  assert.deepEqual(
    resolveVisibleSubagentProfileNames({ subagents: { visibleProfiles: ["custom-agent"] } }),
    ["custom-agent"],
  );
});

test("编排团队的专业角色可以被 DAG 新派发", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-orchestration-subagent-"));
  try {
    const started: string[] = [];
    const port = createExploreSubagentPort({
      outputRootDir: root,
      emitParentEvent: async () => {},
      getVisibleProfiles: () =>
        resolveVisibleSubagentProfileNames({
          orchestration: { enabled: true, team: ["general-purpose", "Explore", "tester"] },
        }),
      runExploreAgent: async (request) => {
        started.push(request.agentType);
        return { response: "ok", traceId: createTraceId(), events: [] };
      },
    });

    const output = await port.launch(launchRequest(root, "tester"));

    assert.deepEqual(started, ["tester"]);
    assert.equal(output.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("在飞 run 使用冻结团队，运行中关闭编排不影响剩余步骤", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-orchestration-frozen-team-"));
  try {
    const started: string[] = [];
    const port = createExploreSubagentPort({
      outputRootDir: root,
      emitParentEvent: async () => {},
      // 会话已经关闭编排：实时派生回落经典两角色，但 run 的冻结团队仍要能派发。
      getVisibleProfiles: () =>
        resolveVisibleSubagentProfileNames({ orchestration: { enabled: false } }),
      runExploreAgent: async (request) => {
        started.push(request.agentType);
        return { response: "ok", traceId: createTraceId(), events: [] };
      },
    });

    const output = await port.launch(launchRequest(root, "tester"), {
      visibleProfiles: ["general-purpose", "Explore", "tester"],
    });

    assert.deepEqual(started, ["tester"]);
    assert.equal(output.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("未进入团队的经典会话仍然拒绝专业角色", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-classic-subagent-"));
  try {
    const port = createExploreSubagentPort({
      outputRootDir: root,
      emitParentEvent: async () => {},
      runExploreAgent: async () => ({ response: "ok", traceId: createTraceId(), events: [] }),
    });

    await assert.rejects(
      port.launch(launchRequest(root, "tester")),
      /Agent type 'tester' not found\. Available agents: general-purpose, Explore/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
