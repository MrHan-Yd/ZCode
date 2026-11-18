import assert from "node:assert/strict";
import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { NodeOrchestrationJournal } from "../../adapters/src/orchestration/journal.js";
import { OrchestrationRunStore } from "../src/orchestration/runStore.js";
import {
  orchestrationError,
  orchestrationInput,
  orchestrationOwner,
  withOrchestrationDirectory,
} from "./orchestrationFixtures.js";

test(
  "锁目录为越界 symlink/junction 时拒绝读取，不能删除外部目录条目",
  { timeout: 15_000 },
  async () => {
    await withOrchestrationDirectory(async (directory) => {
      const outside = join(directory, "outside-lock");
      await mkdir(outside);
      const sentinel = join(outside, "sentinel.txt");
      await writeFile(sentinel, "Preserve external sentinel", "utf8");
      await utimes(outside, new Date(0), new Date(0));
      const rootDirectory = join(directory, "data");
      const owner = orchestrationOwner(directory);
      const journal = new NodeOrchestrationJournal({ rootDirectory, owner });
      const store = new OrchestrationRunStore({ owner, journal });
      const file = journal.filePath("fixture-run");
      await mkdir(dirname(file), { recursive: true });
      await symlink(outside, `${file}.lock`, process.platform === "win32" ? "junction" : "dir");
      await assert.rejects(store.get("fixture-run"), orchestrationError("owner_mismatch"));
      assert.equal(await readFile(sentinel, "utf8"), "Preserve external sentinel");
    });
  },
);

test("run 文件的 parent symlink/junction 逃逸数据根时，不创建外部 snapshot", async () => {
  await withOrchestrationDirectory(async (directory) => {
    const outside = join(directory, "outside-root");
    await mkdir(outside);
    const rootDirectory = join(directory, "data");
    await mkdir(rootDirectory);
    await symlink(
      outside,
      join(rootDirectory, "orchestration"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const owner = orchestrationOwner(directory);
    const store = new OrchestrationRunStore({
      owner,
      journal: new NodeOrchestrationJournal({ rootDirectory, owner }),
    });
    await assert.rejects(store.create(orchestrationInput()), orchestrationError("owner_mismatch"));
  });
});
