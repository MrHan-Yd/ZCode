import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_SUBAGENT_NAMES } from "@zcode/shared";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

test("设置页内置角色目录包含 8 个角色，模型默认继承", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir });
    const result = await service.list({ workspacePath: homeDir, mode: "settingsUserOnly" });
    const builtIns = result.agents.filter((agent) => agent.source === "built-in");

    assert.deepEqual(
      builtIns.map((agent) => agent.name),
      [...BUILT_IN_SUBAGENT_NAMES],
    );
    for (const agent of builtIns) {
      assert.equal(agent.readOnly, true, `${agent.name} 的内置 profile 必须只读`);
      assert.equal(
        agent.modelSelectionOverride,
        undefined,
        `${agent.name} 默认必须继承会话模型`,
      );
    }
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

test("内置角色模型覆盖可设置、可清除，且不互相影响", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const service = createSubagentsService({ homeDir });
    const selection = { providerId: "test-provider", modelId: "test-model" };

    await service.setBuiltInModelOverride({
      agentName: "architect",
      modelSelection: selection,
    });
    const overridden = await service.list({ workspacePath: homeDir, mode: "settingsUserOnly" });
    assert.equal(
      overridden.agents.find((agent) => agent.name === "architect")?.modelSelectionOverride
        ?.modelId,
      "test-model",
    );
    assert.equal(
      overridden.agents.find((agent) => agent.name === "frontend")?.modelSelectionOverride,
      undefined,
    );

    await service.setBuiltInModelOverride({ agentName: "architect", modelSelection: undefined });
    const cleared = await service.list({ workspacePath: homeDir, mode: "settingsUserOnly" });
    assert.equal(
      cleared.agents.find((agent) => agent.name === "architect")?.modelSelectionOverride,
      undefined,
    );
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});
