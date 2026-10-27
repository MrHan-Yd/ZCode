import assert from "node:assert/strict";
import test from "node:test";
import { canonicalJson, parseRemoteFiles, sha256Hex } from "../src/config-sync/manifest.js";
import type { ConfigSyncItem } from "../src/config-sync/types.js";
import {
  agentFileName,
  agentNameFromFileName,
  diffCuratedState,
  isCuratedStateEqual,
  isParsableSubagentMarkdown,
  mergeCuratedState,
  parseRemoteState,
  pickCuratedState,
  serializeCuratedState,
  SUBAGENT_CONFIG_PROFILE,
  SUBAGENT_CONFIG_STATE_FILE_NAME,
  type SubagentConfigCuratedState,
} from "../src/subagents/subagentConfigSyncModel.js";

const EMPTY_STATE: SubagentConfigCuratedState = {
  disabledAgentIds: [],
  builtInModelSelectionOverrides: {},
  pluginAgentModelSelectionOverrides: {},
};

function agentItem(name: string, body = "Do the thing."): ConfigSyncItem {
  return {
    name,
    content: ["---", `name: ${name}`, `description: ${name} agent`, "---", body, ""].join("\n"),
  };
}

test("agent 文件名映射：往返一致，带路径语义或控制字符的名字被拒", () => {
  assert.equal(agentFileName("code-reviewer"), "agent.code-reviewer.md");
  assert.equal(agentNameFromFileName("agent.code-reviewer.md"), "code-reviewer");
  assert.equal(agentNameFromFileName("state.json"), null);
  assert.equal(agentNameFromFileName("agent.nested/name.md"), null);
  assert.equal(agentFileName("nested/name"), null);
  assert.equal(agentFileName("bad\u0000name"), null);
  assert.equal(agentFileName("  padded  "), null);
  assert.equal(agentFileName(""), null);
});

test("精选 state 只留三个字段：旧版回滚字段不进快照", () => {
  // 旧版回滚字段不在 pickCuratedState 的入参类型里，但下载侧确实可能读到带这些字段的 state。
  // 先存进变量再传入（变量赋值不做多余属性检查），仍能断言它们被丢弃，无需 @ts-expect-error。
  const legacyState = {
    disabledAgentIds: ["user:user:b", "user:user:a"],
    builtInModelSelectionOverrides: { Explore: { providerId: "zai", modelId: "glm-5.3" } },
    pluginAgentModelSelectionOverrides: {
      "plugin:x:y": { providerId: "zai", modelId: "glm-5.3" },
      "not-a-plugin-key": { providerId: "zai", modelId: "glm-5.3" },
    },
    builtInModelOverrides: { Explore: { providerId: "zai", modelId: "legacy" } },
    builtInThoughtLevelOverrides: { Explore: "high" },
  };
  const curated = pickCuratedState(legacyState);

  assert.deepEqual(curated.disabledAgentIds, ["user:user:a", "user:user:b"]);
  assert.deepEqual(Object.keys(curated.builtInModelSelectionOverrides), ["Explore"]);
  // 非 plugin: 前缀的键被插件覆盖解析器拒绝。
  assert.deepEqual(Object.keys(curated.pluginAgentModelSelectionOverrides), ["plugin:x:y"]);
  const serialized = serializeCuratedState(curated);
  assert.equal(serialized.includes("builtInModelOverrides"), false);
  assert.equal(serialized.includes("builtInThoughtLevelOverrides"), false);
  // 序列化结果可被同一解析器读回（下载侧的远端 state 校验路径）。
  assert.deepEqual(parseRemoteState(JSON.parse(serialized)), curated);
  assert.equal(parseRemoteState({ unexpected: true }), null);
});

test("md 可加载性：上传与下载共用同一判定", () => {
  assert.equal(isParsableSubagentMarkdown("agent.a.md", agentItem("a").content), true);
  assert.equal(isParsableSubagentMarkdown("agent.a.md", "没有 frontmatter 的正文"), false);
});

test("子智能体 profile 能解析自己产出的远端文件", () => {
  const stateContent = serializeCuratedState({
    ...EMPTY_STATE,
    disabledAgentIds: ["user:user:a"],
  });
  const built = {
    "agent.reviewer.md": { content: agentItem("reviewer").content, truncated: false },
    [SUBAGENT_CONFIG_STATE_FILE_NAME]: { content: stateContent, truncated: false },
  };
  const manifest = {
    schemaVersion: 1,
    revision: 2,
    updatedAt: "2026-10-17T00:00:00.000Z",
    items: [
      {
        name: "reviewer",
        fileName: "agent.reviewer.md",
        sha256: sha256Hex(agentItem("reviewer").content),
        bytes: agentItem("reviewer").content.length,
      },
    ],
    extras: [{ fileName: SUBAGENT_CONFIG_STATE_FILE_NAME, sha256: sha256Hex(stateContent) }],
  };
  const parsed = parseRemoteFiles(SUBAGENT_CONFIG_PROFILE, {
    ...built,
    "manifest.json": { content: `${JSON.stringify(manifest)}\n`, truncated: false },
  });
  assert.equal(parsed.status, "ok");
  assert.ok(parsed.status === "ok");
  assert.deepEqual(
    parsed.items.map((entry) => entry.name),
    ["reviewer"],
  );
  assert.equal(
    parseRemoteState(JSON.parse(parsed.extras.get(SUBAGENT_CONFIG_STATE_FILE_NAME) ?? "null"))
      ?.disabledAgentIds[0],
    "user:user:a",
  );
  // 额外通道缺失时按 invalid 拒绝（子智能体必须有 state）。
  const withoutState = { ...built } as Record<string, unknown>;
  delete withoutState[SUBAGENT_CONFIG_STATE_FILE_NAME];
  assert.equal(parseRemoteFiles(SUBAGENT_CONFIG_PROFILE, withoutState).status, "invalid");
});

test("state diff / merge / 等价判定", () => {
  const local: SubagentConfigCuratedState = {
    disabledAgentIds: ["local-only"],
    builtInModelSelectionOverrides: {
      Explore: { providerId: "zai", modelId: "glm-5.3" },
      "general-purpose": { providerId: "zai", modelId: "glm-5.3" },
    },
    pluginAgentModelSelectionOverrides: { "plugin:a:b": { providerId: "zai", modelId: "glm-5.2" } },
  };
  const remote: SubagentConfigCuratedState = {
    disabledAgentIds: ["remote-only"],
    builtInModelSelectionOverrides: { Explore: { providerId: "zai", modelId: "glm-5.2" } },
    pluginAgentModelSelectionOverrides: {},
  };

  const change = diffCuratedState(local, remote);
  assert.deepEqual(change.disabledAdded, ["remote-only"]);
  assert.deepEqual(change.disabledRemoved, ["local-only"]);
  // 只在一侧存在的键也算变更：replace 会删掉它，merge 会保留它。
  assert.deepEqual(change.overrideKeysChanged, [
    "built-in:Explore",
    "built-in:general-purpose",
    "plugin:plugin:a:b",
  ]);

  const merged = mergeCuratedState(local, remote);
  assert.deepEqual(merged.disabledAgentIds, ["local-only", "remote-only"]);
  assert.deepEqual(merged.builtInModelSelectionOverrides.Explore, {
    providerId: "zai",
    modelId: "glm-5.2",
  });
  assert.ok(merged.builtInModelSelectionOverrides["general-purpose"]);
  assert.ok(merged.pluginAgentModelSelectionOverrides["plugin:a:b"]);

  assert.equal(isCuratedStateEqual(local, local), true);
  assert.equal(isCuratedStateEqual(local, remote), false);
  // disabled 顺序不同不算差异（同一份 state）。
  assert.equal(
    isCuratedStateEqual(
      { ...EMPTY_STATE, disabledAgentIds: ["b", "a"] },
      { ...EMPTY_STATE, disabledAgentIds: ["a", "b"] },
    ),
    true,
  );
  assert.equal(canonicalJson(EMPTY_STATE.disabledAgentIds).includes("[]"), true);
});
