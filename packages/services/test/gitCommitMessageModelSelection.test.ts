import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema, type GitFileChange } from "@zcode/shared";
import { GitCommitMessageGenerator } from "../src/git/gitCommitMessageGenerator.js";

const WORKSPACE_PATH = "/tmp/workspace";
const HOST_DEFAULT = { providerId: "provider-host", modelId: "model-host" };

const files: GitFileChange[] = [
  {
    path: "/tmp/workspace/src/a.ts",
    repoRelativePath: "src/a.ts",
    workspaceRelativePath: "src/a.ts",
    kind: "modified",
    section: "unstaged",
    added: 3,
    removed: 1,
    isStaged: false,
    isUntracked: false,
    isConflicted: false,
  },
];

function createHarness(options?: { hostDefault?: typeof HOST_DEFAULT | null; text?: string }) {
  const generateTextCalls: Array<{ providerId: string; modelId: string }> = [];
  let readCurrentModelCount = 0;
  const hostDefault = options?.hostDefault === undefined ? HOST_DEFAULT : options.hostDefault;
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        readCurrentModelCount += 1;
        return hostDefault;
      },
    },
    textGenerator: {
      async generateText(params) {
        generateTextCalls.push({
          providerId: params.selection.providerId,
          modelId: params.selection.modelId,
        });
        return { text: options?.text ?? "feat: add thing", selection: params.selection };
      },
    },
  });
  return {
    generator,
    generateTextCalls,
    readCurrentModelCount: () => readCurrentModelCount,
  };
}

function generate(
  generator: GitCommitMessageGenerator,
  params: { selection?: { providerId: string; modelId: string } } = {},
) {
  return generator.generate({
    workspacePath: WORKSPACE_PATH,
    branchName: "main",
    files,
    diffs: [],
    ...(params.selection ? { selection: params.selection } : {}),
  });
}

test("提交消息模型：传入当前会话模型时用它，且不读 Host 默认模型", async () => {
  const { generator, generateTextCalls, readCurrentModelCount } = createHarness();

  const result = await generate(generator, {
    selection: { providerId: "provider-session", modelId: "model-session" },
  });

  assert.deepEqual(generateTextCalls, [
    { providerId: "provider-session", modelId: "model-session" },
  ]);
  assert.equal(result.providerId, "provider-session");
  assert.equal(result.model, "model-session");
  // 会话模型是明确的用户意图：不能再无谓读取 Host 偏好，避免两条来源同时存在。
  assert.equal(readCurrentModelCount(), 0);
});

test("提交消息模型：没有传入选择时退回 Host 的 preferredSelection", async () => {
  const { generator, generateTextCalls, readCurrentModelCount } = createHarness();

  const result = await generate(generator);

  assert.deepEqual(generateTextCalls, [
    { providerId: "provider-host", modelId: "model-host" },
  ]);
  assert.equal(result.providerId, HOST_DEFAULT.providerId);
  assert.equal(readCurrentModelCount(), 1);
});

test("提交消息模型：选择不完整时直接失败，不静默换成别的模型", async () => {
  const { generator, generateTextCalls, readCurrentModelCount } = createHarness();

  await assert.rejects(
    () =>
      generate(generator, {
        // @ts-expect-error 故意传一个缺 modelId 的非法选择，验证不会回退到 Host 默认模型。
        selection: { providerId: "provider-session" },
      }),
    /提交消息模型选择不完整/,
  );
  assert.deepEqual(generateTextCalls, []);
  assert.equal(readCurrentModelCount(), 0);
});

test("提交消息模型：Host 也没有默认模型时保持既有失败语义", async () => {
  const { generator, generateTextCalls } = createHarness({ hostDefault: null });

  await assert.rejects(() => generate(generator), /未读取到当前模型/);
  assert.deepEqual(generateTextCalls, []);
});

test("设置 schema：提交消息模型接受固定模型与 null，并拒绝残缺选择", () => {
  const pinned = { providerId: "provider-a", modelId: "model-a" };
  assert.deepEqual(
    appSettingsSchema.parse({ gitCommitMessageModelSelection: pinned }).gitCommitMessageModelSelection,
    pinned,
  );
  // null 表示「跟随当前会话」；缺省同样表示跟随，两者必须都能落盘。
  assert.equal(
    appSettingsSchema.parse({ gitCommitMessageModelSelection: null }).gitCommitMessageModelSelection,
    null,
  );
  assert.equal(appSettingsSchema.parse({}).gitCommitMessageModelSelection, undefined);
  assert.throws(() => appSettingsSchema.parse({ gitCommitMessageModelSelection: {} }));
});

test("设置 patch：允许用 null 清除固定模型", () => {
  assert.deepEqual(appSettingsPatchSchema.parse({ gitCommitMessageModelSelection: null }), {
    gitCommitMessageModelSelection: null,
  });
  assert.deepEqual(
    appSettingsPatchSchema.parse({
      gitCommitMessageModelSelection: { providerId: "provider-a", modelId: "model-a" },
    }),
    { gitCommitMessageModelSelection: { providerId: "provider-a", modelId: "model-a" } },
  );
});
