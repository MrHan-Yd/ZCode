import assert from "node:assert/strict";
import test from "node:test";
import type { GitFileChange } from "@zcode/shared";
import { GitCommitMessageGenerator } from "../src/git/gitCommitMessageGenerator.js";

const WORKSPACE_PATH = "/tmp/workspace";
const MAX_COMMIT_MESSAGE_CHARS = 1_000;

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

function createHarness(text: string) {
  const prompts: string[] = [];
  const generator = new GitCommitMessageGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        return { providerId: "provider-host", modelId: "model-host" };
      },
    },
    textGenerator: {
      async generateText(params) {
        prompts.push(params.prompt);
        return { text, selection: params.selection };
      },
    },
  });
  return { generator, prompts };
}

function generate(text: string) {
  const harness = createHarness(text);
  return {
    ...harness,
    result: harness.generator.generate({
      workspacePath: WORKSPACE_PATH,
      branchName: "main",
      files,
      diffs: [],
      selection: { providerId: "provider-1", modelId: "model-1" },
    }),
  };
}

/** 组装一条总长精确等于 totalChars 的合规消息（首行 Conventional Commit + 正文）。 */
function messageOfExactLength(totalChars: number): string {
  const subject = "feat: 边界";
  const separator = "\n\n";
  const bodyLength = totalChars - subject.length - separator.length;
  return `${subject}${separator}${"a".repeat(bodyLength)}`;
}

test("提交消息：上限内的合规消息原样使用，不被裁剪", async () => {
  const message = messageOfExactLength(MAX_COMMIT_MESSAGE_CHARS);
  const { result } = generate(message);

  const generated = await result;
  assert.equal(generated.message, message);
  assert.equal(generated.message.length, MAX_COMMIT_MESSAGE_CHARS);
});

test("提交消息：超过长度上限判为不可用，而不是被切到上限", async () => {
  const tooLong = messageOfExactLength(MAX_COMMIT_MESSAGE_CHARS + 1);
  const { result } = generate(tooLong);

  await assert.rejects(result, (error: Error) => {
    assert.match(error.message, /没有返回可用的/);
    // 关键：不是"成功返回一条被截断的消息"，而是明确失败。
    return true;
  });
});

test("提交消息：提示词里写明了长度上限，数字与常量一致", async () => {
  const { result, prompts } = generate("feat: add thing");
  await result;

  assert.ok(prompts[0]?.includes(`${MAX_COMMIT_MESSAGE_CHARS} characters`));
  assert.ok(prompts[0]?.includes("under 72 characters"));
});

test("提交消息：剥掉围栏与前缀后再判长度，仍超限则失败", async () => {
  const fenced = `\`\`\`\n${messageOfExactLength(MAX_COMMIT_MESSAGE_CHARS + 1)}\n\`\`\``;
  const { result } = generate(fenced);

  await assert.rejects(result);
});

test("提交消息：剥掉装饰后合规的消息被接受，装饰不进入提交内容", async () => {
  const { result } = generate("```\nfeat: 加功能\n\n- 说明\n```");

  const generated = await result;
  assert.equal(generated.message, "feat: 加功能\n\n- 说明");
});

test("提交消息：首行主题超过 100 字符判为不合规", async () => {
  const { result } = generate(`feat: ${"字".repeat(101)}`);

  await assert.rejects(result);
});

test("提交消息：首行不是 Conventional Commit 判为不合规", async () => {
  const { result } = generate("随手写的一句话");

  await assert.rejects(result);
});
