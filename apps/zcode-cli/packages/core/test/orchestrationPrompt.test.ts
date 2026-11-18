import assert from "node:assert/strict";
import test from "node:test";
import { ContextBuilder } from "../src/context/builder.js";
import { buildOrchestratorSection } from "../src/context/sections/orchestrator.js";

const ENV = {
  cwd: "/workspace",
  platform: "linux",
  shell: "bash",
  osVersion: "test",
  nodeVersion: "test",
};

test("orchestrator 段列出工具面、团队与只读边界", () => {
  const section = buildOrchestratorSection({
    team: ["general-purpose", "Explore", "tester"],
    writableRoles: ["general-purpose", "tester"],
  });
  assert.equal(section.source, "orchestrator");
  for (const tool of [
    "CreateOrchestrationPlan",
    "AmendOrchestrationPlan",
    "CancelOrchestrationRun",
  ]) {
    assert.ok(section.content.includes(tool), tool);
  }
  assert.match(section.content, /`Edit`, `Write`, `Bash`/);
  assert.match(section.content, /general-purpose, Explore, tester/);
  assert.match(section.content, /Writable roles: general-purpose, tester/);
  assert.match(section.content, /writeScope/);
});

test("编排主会话保留正常身份，只追加调度段", () => {
  const result = new ContextBuilder({
    workingDirectory: ENV.cwd,
    envInfo: ENV,
    orchestration: {
      team: ["general-purpose", "Explore", "tester"],
      writableRoles: ["general-purpose", "tester"],
    },
  }).build();
  assert.ok(result.sections.some((section) => section.source === "identity"));
  assert.ok(result.sections.some((section) => section.source === "orchestrator"));
});

test("customSystemPrompt 是整段替换语义，不再叠加编排段", () => {
  const result = new ContextBuilder({
    workingDirectory: ENV.cwd,
    envInfo: ENV,
    customSystemPrompt: "Custom body",
    orchestration: {
      team: ["general-purpose", "Explore", "tester"],
      writableRoles: ["general-purpose", "tester"],
    },
  }).build();
  assert.equal(
    result.sections.some((section) => section.source === "orchestrator"),
    false,
  );
});
