import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BUILT_IN_SUBAGENT_NAMES } from "@zcode/shared";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

test("设置页内置角色目录与共享名单一致，模型默认继承", async () => {
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

test("停用的同名用户 profile 不遮蔽内置角色，也不从目录消失", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "zcode-subagents-"));
  try {
    const agentsDir = join(homeDir, ".zcode", "agents");
    const stateDir = join(homeDir, ".zcode", "v2");
    await mkdir(agentsDir, { recursive: true });
    await mkdir(stateDir, { recursive: true });
    const agentMarkdown = (name: string) =>
      ["---", `name: ${name}`, "description: fixture", "---", `Prompt for ${name}`].join("\n");
    // 手工放进用户目录的文件可以绕过创建时的保留名校验；这里复现同名覆盖。
    await writeFile(join(agentsDir, "ui-designer.md"), agentMarkdown("ui-designer"));
    await writeFile(join(agentsDir, "custom-helper.md"), agentMarkdown("custom-helper"));
    await writeFile(
      join(stateDir, "agents-state.json"),
      JSON.stringify({
        disabledAgentIds: ["user:user:ui-designer", "user:user:custom-helper"],
      }),
    );

    const service = createSubagentsService({ homeDir });
    // workspacePath 必须与用户目录分开：同一路径会让文件被当成项目级 agent。
    const result = await service.list({
      workspacePath: join(homeDir, "workspace"),
      mode: "allRuntimeScopes",
    });

    // 停用的同名文件不参与运行时优先级：内置角色仍可用（运行时也会跳过旧 profile）。
    const uiDesigner = result.agents.find((agent) => agent.name === "ui-designer");
    assert.equal(uiDesigner?.source, "built-in");
    assert.equal(uiDesigner?.enabled, true);

    // 没有同名冲突的停用自建 agent 仍要出现在目录里，只是标记为停用。
    const custom = result.agents.find((agent) => agent.name === "custom-helper");
    assert.equal(custom?.source, "user");
    assert.equal(custom?.enabled, false);
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
