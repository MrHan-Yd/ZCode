import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import {
  buildOrchestrationStepInputs,
  buildOrchestrationStepPrompt,
  OrchestrationArtifacts,
} from "../src/orchestration/artifacts.js";
import type {
  OrchestrationArtifactReference,
  OrchestrationRunOwner,
} from "../src/orchestration/contract.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import {
  orchestrationClock,
  orchestrationError,
  orchestrationInput,
  orchestrationOwner,
  orchestrationPlan,
  orchestrationStep,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

function harness(
  directory: string,
  options: {
    owner?: OrchestrationRunOwner;
    maxContentBytes?: number;
    maxSummaryBytes?: number;
  } = {},
) {
  const owner = options.owner ?? orchestrationOwner(directory);
  const rootDirectory = join(directory, "data");
  const storage = new NodeOrchestrationArtifactStorage({ rootDirectory, owner });
  const artifacts = new OrchestrationArtifacts({
    storage,
    maxContentBytes: options.maxContentBytes,
    maxSummaryBytes: options.maxSummaryBytes,
  });
  return {
    storage,
    artifacts,
    store: new OrchestrationRunStore({
      owner,
      journal: new NodeOrchestrationJournal({ rootDirectory, owner }),
      now: orchestrationClock(),
    }),
  };
}

function utf8Budget(text: string, budget: number): void {
  assert.ok(Buffer.byteLength(text, "utf8") <= budget);
  assert.equal(Buffer.from(text, "utf8").toString("utf8"), text);
  assert.ok(!text.includes("\uFFFD"));
}

function jsonInputs(text: string): unknown[] {
  const value: unknown = JSON.parse(text);
  assert.ok(Array.isArray(value));
  return value;
}

async function promptFixture(directory: string) {
  const context = harness(directory, { maxSummaryBytes: 512 });
  const consumer = orchestrationStep({
    stepId: "consumer",
    role: "tester",
    dependsOn: ["direct", "optional-review"],
    writeScope: ["tests/orchestration"],
    task: "Verify task remains complete even under an input budget.",
    acceptance: "All required assertions pass.",
  });
  const plan = orchestrationPlan([
    orchestrationStep({ stepId: "ancestor" }),
    orchestrationStep({ stepId: "unrelated", role: "reviewer" }),
    orchestrationStep({ stepId: "direct", dependsOn: ["ancestor"] }),
    orchestrationStep({
      stepId: "optional-review",
      dependsOn: ["ancestor"],
      optional: true,
      maxAttempts: 0,
    }),
    consumer,
  ]);
  await context.store.create(orchestrationInput(plan));
  const references = new Map<string, OrchestrationArtifactReference>();
  const outputs = new Map<string, string>();
  for (let round = 0; round < 2; round += 1) {
    for (const claim of await context.store.claim("fixture-run")) {
      if (claim.step.stepId === "optional-review") {
        assert.equal(
          await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
            status: "failed",
            error: "Optional review unavailable",
          }),
          true,
        );
      } else {
        const output = `${claim.step.stepId}-HEAD\n${`FULL-OUTPUT-${claim.step.stepId}-PRIVATE-MIDDLE\n`.repeat(120)}${claim.step.stepId}-TAIL`;
        const artifact = await context.artifacts.save(claim.attempt.key, output);
        references.set(claim.step.stepId, artifact);
        outputs.set(claim.step.stepId, output);
        assert.equal(
          await context.store.finish(claim.runId, claim.attempt.key, claim.attempt.generation, {
            status: "completed",
            artifact,
          }),
          true,
        );
      }
    }
  }
  const record = await context.store.get("fixture-run");
  assert.ok(record);
  return { ...context, record, consumer, references, outputs };
}

test("artifact：真实 Node 目录保存 UTF-8、引用和 sha256，冷读逐字节一致", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { artifacts, storage } = harness(directory);
    const key = "run/../attempt\\unsafe:1";
    const content = "第一行🙂\r\nSecond line\u0000\n終端🚀";
    const reference = await artifacts.save(key, content);
    assert.equal(reference.attemptKey, key);
    assert.ok(reference.artifactId.length > 0 && reference.uri.length > 0);
    assert.equal(reference.originalBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(reference.savedBytes, reference.originalBytes);
    assert.equal(reference.sha256, createHash("sha256").update(content, "utf8").digest("hex"));
    assert.equal(reference.summary, content);
    assert.equal(reference.truncated, false);
    assert.equal(reference.summaryTruncated, false);
    assert.equal(await artifacts.read(reference), content);
    assert.equal(await harness(directory).artifacts.read(reference), content);
    const path = storage.filePath(key);
    assert.ok(isAbsolute(path));
    assert.ok(
      !isAbsolute(relative(directory, path)) &&
        !relative(directory, path).split(sep).includes(".."),
    );
    assert.ok(!basename(path).includes("unsafe"));
  });
});

test("artifact：同 key 同正文并发和冷写幂等，不同正文冲突且不覆盖", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const contexts = [harness(directory), harness(directory), harness(directory)];
    const references = await Promise.all(
      contexts.map(({ artifacts }) => artifacts.save("stable-key", "Stable 中文🙂 output")),
    );
    const [reference] = references;
    assert.ok(reference);
    for (const item of references) assert.deepEqual(item, reference);
    for (const { artifacts } of contexts) {
      await assert.rejects(
        artifacts.save("stable-key", "Different output"),
        orchestrationError("artifact_conflict"),
      );
      assert.equal(await artifacts.read(reference), "Stable 中文🙂 output");
    }
    assert.deepEqual(
      await harness(directory).artifacts.save("stable-key", "Stable 中文🙂 output"),
      reference,
    );
  });
});

test("artifact：截断后正文/摘要相同也不能让不同原文覆盖同 key", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { artifacts } = harness(directory, { maxContentBytes: 128, maxSummaryBytes: 64 });
    const prefix = "HEAD-" + "a".repeat(256);
    const suffix = "z".repeat(256) + "-TAIL";
    const reference = await artifacts.save("truncated-source", `${prefix}source-one${suffix}`);
    const saved = await artifacts.read(reference);
    await assert.rejects(
      artifacts.save("truncated-source", `${prefix}source-two${suffix}`),
      orchestrationError("artifact_conflict"),
    );
    assert.equal(await artifacts.read(reference), saved);
    assert.deepEqual(
      await artifacts.save("truncated-source", `${prefix}source-one${suffix}`),
      reference,
    );
  });
});

test("artifact：正文和摘要 UTF-8 独立预算，超限保留首尾并标记截断", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { artifacts } = harness(directory, { maxContentBytes: 512, maxSummaryBytes: 128 });
    const content = `HEAD-首🙂${"中间🚀数据".repeat(120)}終🚀-TAIL`;
    const reference = await artifacts.save("utf8-budget", content);
    const saved = await artifacts.read(reference);
    utf8Budget(saved, 512);
    utf8Budget(reference.summary, 128);
    assert.ok(saved.startsWith("HEAD-") && saved.endsWith("-TAIL"));
    assert.ok(reference.summary.startsWith("HEAD-") && reference.summary.endsWith("-TAIL"));
    assert.equal(reference.originalBytes, Buffer.byteLength(content, "utf8"));
    assert.equal(reference.savedBytes, Buffer.byteLength(saved, "utf8"));
    assert.equal(reference.sha256, createHash("sha256").update(saved, "utf8").digest("hex"));
    assert.equal(reference.truncated, true);
    assert.equal(reference.summaryTruncated, true);
    const independent = harness(directory, { maxContentBytes: 16, maxSummaryBytes: 192 }).artifacts;
    const other = await independent.save("summary-from-source", content);
    utf8Budget(await independent.read(other), 16);
    assert.ok(other.summary.startsWith("HEAD-") && other.summary.endsWith("-TAIL"));
    assert.ok(Buffer.byteLength(other.summary, "utf8") > other.savedBytes);
  });
});

test("artifact：恰好 UTF-8 字节边界不截断，少一字节时不拆字符", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const content = "中🙂A";
    const bytes = Buffer.byteLength(content, "utf8");
    const exact = harness(directory, { maxContentBytes: bytes, maxSummaryBytes: bytes }).artifacts;
    const reference = await exact.save("exact", content);
    assert.equal(await exact.read(reference), content);
    assert.equal(reference.summary, content);
    assert.equal(reference.truncated, false);
    assert.equal(reference.summaryTruncated, false);
    const smaller = harness(directory, {
      maxContentBytes: bytes - 1,
      maxSummaryBytes: bytes - 1,
    }).artifacts;
    const truncated = await smaller.save("one-less", content);
    utf8Budget(await smaller.read(truncated), bytes - 1);
    utf8Budget(truncated.summary, bytes - 1);
    assert.equal(truncated.truncated, true);
    assert.equal(truncated.summaryTruncated, true);
  });
});

test("artifact：极小预算 1/2/3/4/7/16 字节不产生乱码或超预算 marker", async () => {
  await withOrchestrationDirectory(async (directory) => {
    for (const budget of [1, 2, 3, 4, 7, 16]) {
      const { artifacts } = harness(directory, {
        maxContentBytes: budget,
        maxSummaryBytes: budget,
      });
      const content = `🙂汉字${"填".repeat(30)}終🚀`;
      const reference = await artifacts.save(`tiny-${budget}`, content);
      const saved = await artifacts.read(reference);
      utf8Budget(saved, budget);
      utf8Budget(reference.summary, budget);
      assert.equal(reference.savedBytes, Buffer.byteLength(saved, "utf8"));
      assert.equal(reference.originalBytes, Buffer.byteLength(content, "utf8"));
      assert.equal(reference.truncated, true);
      assert.equal(reference.summaryTruncated, true);
    }
  });
});

test("artifact：默认正文 1 MiB、摘要 4 KiB 预算生效", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { artifacts } = harness(directory);
    const content = `HEAD-${"字🙂".repeat(160_000)}-TAIL`;
    const reference = await artifacts.save("default-budget", content);
    const saved = await artifacts.read(reference);
    utf8Budget(saved, 1024 * 1024);
    utf8Budget(reference.summary, 4 * 1024);
    assert.equal(reference.truncated, true);
    assert.equal(reference.summaryTruncated, true);
    assert.ok(saved.startsWith("HEAD-") && saved.endsWith("-TAIL"));
  });
});

test("artifact：read 拒绝任意引用字段篡改，不能读取指定的外部文件", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { artifacts } = harness(directory);
    const reference = await artifacts.save("validated-ref", "Authenticated artifact content");
    const outside = join(directory, "outside.txt");
    await writeFile(outside, "Outside sentinel", "utf8");
    const damaged = [
      { ...reference, artifactId: "other-id" },
      { ...reference, attemptKey: "other-key" },
      { ...reference, uri: pathToFileURL(outside).href },
      { ...reference, summary: "tampered summary" },
      { ...reference, originalBytes: reference.originalBytes + 1 },
      { ...reference, savedBytes: reference.savedBytes + 1 },
      { ...reference, sha256: "0".repeat(64) },
      { ...reference, truncated: true },
      { ...reference, summaryTruncated: true },
    ] satisfies OrchestrationArtifactReference[];
    for (const value of damaged)
      await assert.rejects(artifacts.read(value), orchestrationError("artifact_conflict"));
    assert.equal(await readFile(outside, "utf8"), "Outside sentinel");
    assert.equal(await artifacts.read(reference), "Authenticated artifact content");
  });
});

test("artifact owner：identity、session、remote 隔离，trim/fallback 指向同 scope", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const owners = [
      orchestrationOwner(directory, { workspaceIdentity: "identity-a" }),
      orchestrationOwner(directory, { workspaceIdentity: "identity-b" }),
      orchestrationOwner(directory, { workspaceIdentity: "identity-a", sessionId: "parent-b" }),
      orchestrationOwner(directory, {
        workspaceIdentity: "identity-a",
        remoteSessionId: "remote-a",
      }),
      orchestrationOwner(directory, {
        workspaceIdentity: "identity-a",
        remoteSessionId: "remote-b",
      }),
    ];
    const contexts = owners.map((owner) => harness(directory, { owner }));
    assert.equal(
      new Set(contexts.map(({ storage }) => storage.filePath("same-key"))).size,
      owners.length,
    );
    for (const [index, { artifacts }] of contexts.entries()) {
      const reference = await artifacts.save("same-key", `Owner output ${index}`);
      assert.equal(await artifacts.read(reference), `Owner output ${index}`);
    }
    const first = harness(directory, {
      owner: orchestrationOwner(directory, { workspaceIdentity: "  identity-a  " }),
    });
    assert.deepEqual(
      await first.artifacts.save("same-key", "Owner output 0"),
      await contexts[0]?.artifacts.save("same-key", "Owner output 0"),
    );
    const local = harness(directory);
    assert.deepEqual(
      await local.artifacts.save("local-key", "local"),
      await harness(directory, {
        owner: orchestrationOwner(directory, { workspaceIdentity: "  " }),
      }).artifacts.save("local-key", "local"),
    );
  });
});

test("artifact 损坏正文、unknown version 与 owner 篡改拒绝读取且不覆盖历史", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const { artifacts, storage } = harness(directory);
    const reference = await artifacts.save("corrupt-artifact", "Confirmed 中文 output");
    const filePath = storage.filePath(reference.attemptKey);
    const raw: unknown = JSON.parse(await readFile(filePath, "utf8"));
    assert.ok(typeof raw === "object" && raw !== null && "owner" in raw);
    const owner = raw.owner;
    assert.ok(typeof owner === "object" && owner !== null);
    const cases = [
      { value: { ...raw, content: "tampered" }, code: "artifact_conflict" },
      { value: { ...raw, version: 2 }, code: "unsupported_version" },
      { value: { ...raw, owner: { ...owner, sessionId: "wrong-parent" } }, code: "owner_mismatch" },
    ] satisfies Array<{ value: object; code: Parameters<typeof orchestrationError>[0] }>;
    for (const damaged of cases) {
      const text = JSON.stringify(damaged.value);
      await writeFile(filePath, text, "utf8");
      await assert.rejects(artifacts.read(reference), orchestrationError(damaged.code));
      await assert.rejects(
        artifacts.save(reference.attemptKey, "Confirmed 中文 output"),
        orchestrationError(damaged.code),
      );
      assert.equal(await readFile(filePath, "utf8"), text);
    }
  });
});

test("artifact Node IO 失败透传，不发布引用或留下同 key 冲突", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const rootDirectory = join(directory, "blocked");
    await writeFile(rootDirectory, "not a directory", "utf8");
    const storage = new NodeOrchestrationArtifactStorage({
      rootDirectory,
      owner: orchestrationOwner(directory),
    });
    const artifacts = new OrchestrationArtifacts({ storage });
    await assert.rejects(
      artifacts.save("io-key", "first attempt"),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        (error.code === "ENOTDIR" || error.code === "EEXIST"),
    );
    await rm(rootDirectory);
    await mkdir(rootDirectory);
    const reference = await artifacts.save("io-key", "second attempt");
    assert.equal(await artifacts.read(reference), "second attempt");
  });
});

test("prompt auto：仅直接依赖的 summary/ref，不 inline 全文、祖先或无关产物", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const fixture = await promptFixture(directory);
    const inputs = buildOrchestrationStepInputs(fixture.record, fixture.consumer);
    assert.equal(jsonInputs(inputs).length, 2);
    const direct = fixture.references.get("direct");
    assert.ok(direct);
    assert.ok(
      jsonInputs(inputs).some(
        (value) =>
          typeof value === "object" &&
          value !== null &&
          "stepId" in value &&
          value.stepId === "direct" &&
          "summary" in value &&
          value.summary === direct.summary,
      ),
    );
    assert.ok(inputs.includes(direct.uri));
    assert.ok(inputs.includes("completed") && inputs.includes("failed"));
    assert.ok(inputs.includes("Optional review unavailable"));
    for (const stepId of ["ancestor", "unrelated"]) {
      const reference = fixture.references.get(stepId);
      assert.ok(reference);
      assert.ok(!inputs.includes(reference.uri));
    }
    const prompt = buildOrchestrationStepPrompt(fixture.record, fixture.consumer);
    assert.ok(prompt.includes(`<orchestration-inputs>\n${inputs}\n</orchestration-inputs>`));
    assert.ok(prompt.includes(fixture.consumer.task));
    assert.ok(prompt.includes("tests/orchestration"));
    assert.ok(prompt.includes("All required assertions pass."));
    for (const output of fixture.outputs.values()) assert.ok(!prompt.includes(output));
    assert.equal(
      buildOrchestrationStepInputs(fixture.record, { ...fixture.consumer, inputs: "auto" }),
      inputs,
    );
  });
});

test("prompt 显式 inputs：可取依赖祖先，仅取选定摘要/引用；空列表不取任何产物", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const fixture = await promptFixture(directory);
    const step = { ...fixture.consumer, inputs: ["ancestor"] };
    const inputs = buildOrchestrationStepInputs(fixture.record, step);
    assert.equal(jsonInputs(inputs).length, 1);
    const ancestor = fixture.references.get("ancestor");
    assert.ok(ancestor);
    assert.ok(inputs.includes(ancestor.uri));
    for (const stepId of ["direct", "unrelated"]) {
      const reference = fixture.references.get(stepId);
      assert.ok(reference);
      assert.ok(!inputs.includes(reference.uri));
    }
    assert.equal(buildOrchestrationStepInputs(fixture.record, { ...step, inputs: [] }), "[]");
  });
});

test("prompt：输入预算只约束完整依赖 JSON，UTF-8 截断不裁 task/scope/acceptance", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const fixture = await promptFixture(directory);
    const full = buildOrchestrationStepInputs(fixture.record, fixture.consumer, {
      maxInputBytes: 64 * 1024,
    });
    for (const budget of [0, 1, 2, 8, 32, 128, 256, 512, Buffer.byteLength(full, "utf8") - 32]) {
      const inputs = buildOrchestrationStepInputs(fixture.record, fixture.consumer, {
        maxInputBytes: budget,
      });
      utf8Budget(inputs, budget);
      if (inputs) jsonInputs(inputs);
      assert.notEqual(inputs, full);
      const prompt = buildOrchestrationStepPrompt(fixture.record, fixture.consumer, {
        maxInputBytes: budget,
      });
      assert.ok(prompt.includes(`<orchestration-inputs>\n${inputs}\n</orchestration-inputs>`));
      assert.ok(prompt.includes(fixture.consumer.task));
      assert.ok(prompt.includes("tests/orchestration"));
      assert.ok(prompt.includes("All required assertions pass."));
    }
  });
});

test("prompt：optional 失败不伪造完成摘要，仍显式带失败状态和原因", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const fixture = await promptFixture(directory);
    const inputs = buildOrchestrationStepInputs(fixture.record, {
      ...fixture.consumer,
      inputs: ["optional-review"],
    });
    assert.equal(jsonInputs(inputs).length, 1);
    assert.ok(inputs.includes("optional-review") && inputs.includes("failed"));
    assert.ok(inputs.includes("Optional review unavailable"));
    assert.ok(!inputs.includes("completed"));
    assert.equal(fixture.record.state.steps.consumer?.status, "pending");
  });
});
