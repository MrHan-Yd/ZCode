import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NodeOrchestrationArtifactStorage } from "../../adapters/src/orchestration/artifacts.js";
import { OrchestrationArtifacts } from "../src/orchestration/artifacts.js";
import {
  orchestrationError,
  orchestrationOwner,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

test("未配对 UTF-16 surrogate 必须拒绝，不能靠相同 UTF-8 替代字符哈希掩盖不同原文", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const storage = new NodeOrchestrationArtifactStorage({
      rootDirectory: directory,
      owner: orchestrationOwner(directory),
    });
    const artifacts = new OrchestrationArtifacts({ storage });
    for (const invalid of ["\ud800", "\ud801", "tail\udfff"]) {
      await assert.rejects(
        artifacts.save("surrogate-key", invalid),
        orchestrationError("artifact_conflict"),
      );
    }
    const reference = await artifacts.save("surrogate-key", "\ufffd");
    assert.equal(await artifacts.read(reference), "\ufffd");
    assert.ok(!(await readFile(storage.filePath("surrogate-key"), "utf8")).includes("\\ud800"));
  });
});
