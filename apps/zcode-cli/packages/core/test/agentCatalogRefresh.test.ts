import assert from "node:assert/strict";
import test from "node:test";
import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { TraceContext } from "../src/runtime/deps.js";
import { refreshAgentCatalogs } from "../src/runtime/methods/catalogs.js";
import { buildSkillCatalogKey, buildSubagentCatalogKey } from "../src/runtime/methods/catalogs.js";
import type { AgentProfile } from "../src/subagent/profile.js";

function skill(overrides: Partial<SkillMetadata> & { name: string; path: string }): SkillMetadata {
  return {
    description: `${overrides.name} description`,
    directory: overrides.path,
    frontmatterKeys: [],
    rootPath: overrides.path,
    safeToAutoLoad: true,
    scope: "workspace",
    source: "project",
    ...overrides,
  };
}

function outcome(skills: SkillMetadata[]): SkillLoadOutcome {
  return { diagnostics: [], skills, totalDiscovered: skills.length };
}

function profile(overrides: Partial<AgentProfile> & { name: string }): AgentProfile {
  return {
    description: `${overrides.name} description`,
    source: "project",
    systemPrompt: "prompt",
    ...overrides,
  };
}

test("Skill 目录 key 与顺序无关，新增技能会变化", () => {
  const alpha = skill({ name: "alpha", path: "/skills/alpha/SKILL.md" });
  const beta = skill({ name: "beta", path: "/skills/beta/SKILL.md" });

  assert.equal(
    buildSkillCatalogKey(outcome([alpha, beta])),
    buildSkillCatalogKey(outcome([beta, alpha])),
  );
  assert.notEqual(
    buildSkillCatalogKey(outcome([alpha])),
    buildSkillCatalogKey(outcome([alpha, beta])),
  );
});

test("Subagent 目录 key 与顺序无关，正文变化也会触发刷新", () => {
  const reviewer = profile({ name: "reviewer", path: "/agents/reviewer.md" });
  const writer = profile({ name: "writer", path: "/agents/writer.md" });

  assert.equal(
    buildSubagentCatalogKey([reviewer, writer]),
    buildSubagentCatalogKey([writer, reviewer]),
  );
  assert.notEqual(
    buildSubagentCatalogKey([reviewer]),
    buildSubagentCatalogKey([{ ...reviewer, systemPrompt: "updated prompt" }]),
  );
  assert.notEqual(buildSubagentCatalogKey([reviewer]), buildSubagentCatalogKey([reviewer, writer]));
});

interface FakeCatalogRuntime {
  calls: {
    discovered: number;
    invalidated: number;
    loaded: number;
    refreshTools: number;
  };
  runtime: AgentRuntimeInternal;
}

function fakeCatalogRuntime(options: {
  currentProfiles?: readonly AgentProfile[];
  currentSkills?: SkillLoadOutcome;
  nextProfiles?: readonly AgentProfile[];
  nextSkills?: SkillLoadOutcome;
  profileError?: Error;
}): FakeCatalogRuntime {
  const calls = { discovered: 0, invalidated: 0, loaded: 0, refreshTools: 0 };
  const runtime = {
    config: { subagents: { profiles: options.currentProfiles ?? [] } },
    contextInitialized: true,
    discoverSkillsForContext: async () => {
      calls.discovered += 1;
      return options.nextSkills ?? outcome([]);
    },
    invalidateToolCache: () => {
      calls.invalidated += 1;
    },
    logger: undefined,
    refreshBuiltInTools: () => {
      calls.refreshTools += 1;
    },
    skillLoadOutcome: options.currentSkills ?? outcome([]),
    skillPort: {},
    subagentProfilePort: {
      loadProfiles: async () => {
        calls.loaded += 1;
        if (options.profileError) throw options.profileError;
        return { profiles: [...(options.nextProfiles ?? [])] };
      },
    },
    workingDirectory: "/workspace",
  } as unknown as AgentRuntimeInternal;
  return { calls, runtime };
}

const trace = { traceId: "trace-catalog-refresh" } as TraceContext;

test("目录刷新只在集合变化时更新快照并重注册工具", async () => {
  const alpha = skill({ name: "alpha", path: "/skills/alpha/SKILL.md" });
  const reviewer = profile({ name: "reviewer", path: "/agents/reviewer.md" });
  const { calls, runtime } = fakeCatalogRuntime({
    currentProfiles: [],
    currentSkills: outcome([]),
    nextProfiles: [reviewer],
    nextSkills: outcome([alpha]),
  });

  const result = await refreshAgentCatalogs.call(runtime, trace);

  assert.deepEqual(result, { skillsChanged: true, subagentsChanged: true });
  assert.equal(calls.discovered, 1);
  assert.equal(calls.loaded, 1);
  assert.equal(calls.refreshTools, 1);
  assert.equal(calls.invalidated, 1);
  assert.deepEqual(
    runtime.skillLoadOutcome?.skills.map((entry) => entry.name),
    ["alpha"],
  );
  assert.deepEqual(
    runtime.config.subagents?.profiles?.map((entry) => entry.name),
    ["reviewer"],
  );
});

test("目录未变化时不重注册工具、不丢缓存", async () => {
  const alpha = skill({ name: "alpha", path: "/skills/alpha/SKILL.md" });
  const reviewer = profile({ name: "reviewer", path: "/agents/reviewer.md" });
  const skills = outcome([alpha]);
  const { calls, runtime } = fakeCatalogRuntime({
    currentProfiles: [reviewer],
    currentSkills: skills,
    nextProfiles: [reviewer],
    nextSkills: skills,
  });

  const result = await refreshAgentCatalogs.call(runtime, trace);

  assert.deepEqual(result, { skillsChanged: false, subagentsChanged: false });
  assert.equal(calls.refreshTools, 0);
  assert.equal(calls.invalidated, 0);
});

test("技能扫描失败时保留旧快照", async () => {
  const alpha = skill({ name: "alpha", path: "/skills/alpha/SKILL.md" });
  const failedScan: SkillLoadOutcome = {
    diagnostics: [{ code: "skill_scan_failed", message: "scan failed", severity: "warning" }],
    skills: [],
    totalDiscovered: 0,
  };
  const { runtime } = fakeCatalogRuntime({
    currentProfiles: [],
    currentSkills: outcome([alpha]),
    nextProfiles: [],
    nextSkills: failedScan,
  });

  const result = await refreshAgentCatalogs.call(runtime, trace);

  assert.equal(result.skillsChanged, false);
  assert.deepEqual(
    runtime.skillLoadOutcome?.skills.map((entry) => entry.name),
    ["alpha"],
  );
});

test("Subagent 读取失败时保留旧 profile 且不重注册工具", async () => {
  const reviewer = profile({ name: "reviewer", path: "/agents/reviewer.md" });
  const { calls, runtime } = fakeCatalogRuntime({
    currentProfiles: [reviewer],
    currentSkills: outcome([]),
    nextProfiles: [],
    nextSkills: outcome([]),
    profileError: new Error("read failed"),
  });

  const result = await refreshAgentCatalogs.call(runtime, trace);

  assert.equal(result.subagentsChanged, false);
  assert.equal(calls.refreshTools, 0);
  assert.equal(calls.invalidated, 0);
  assert.deepEqual(
    runtime.config.subagents?.profiles?.map((entry) => entry.name),
    ["reviewer"],
  );
});
