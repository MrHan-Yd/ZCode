import { Worker } from "node:worker_threads";
import type { GitCommitGraphFilters } from "@zcode/shared";
import { gitGraphError, type GitGraphBudget } from "./gitCommitGraphLimits.js";
import type { GitGraphRecord } from "./gitCommitGraphParser.js";

const REGEX_BATCH_BUDGET_MS = 250;
const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
let expression;
try {
  expression = new RegExp(workerData.value, workerData.caseSensitive ? "u" : "iu");
  parentPort.postMessage({ ready: true });
} catch {
  parentPort.postMessage({ invalid: true });
}
parentPort.on("message", (fields) => {
  if (!expression) return;
  parentPort.postMessage(fields.map((entry) => entry.some((field) => expression.test(field))));
});
`;

function matchesIdentityAndDate(record: GitGraphRecord, filters?: GitCommitGraphFilters): boolean {
  const commit = record.commit;
  // 原始空作者字段在展示投影中为 null，候选为字符串；按同一身份口径才能筛选合法空邮箱。
  if (
    filters?.author &&
    ((commit.authorName ?? "") !== filters.author.name ||
      (commit.authorEmail ?? "") !== filters.author.email)
  )
    return false;
  const date = filters?.date;
  if (date && (date.fromMs !== undefined || date.toMs !== undefined)) {
    if (
      commit.authoredAtMs === null ||
      (date.fromMs !== undefined && commit.authoredAtMs < date.fromMs) ||
      (date.toMs !== undefined && commit.authoredAtMs >= date.toMs)
    )
      return false;
  }
  return true;
}

function waitForWorker(worker: Worker, timeoutMs: number, send?: () => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off("message", onMessage);
      worker.off("error", onError);
      worker.off("exit", onExit);
    };
    const onMessage = (value: unknown) => {
      cleanup();
      resolve(value);
    };
    const onError = () => {
      cleanup();
      reject(gitGraphError("query-timeout"));
    };
    const onExit = () => {
      cleanup();
      reject(gitGraphError("query-timeout"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(gitGraphError("query-timeout"));
    }, timeoutMs);
    worker.once("message", onMessage);
    worker.once("error", onError);
    worker.once("exit", onExit);
    try {
      send?.();
    } catch {
      onError();
    }
  });
}

export async function createGitGraphMatcher(
  filters: GitCommitGraphFilters | undefined,
  budget: GitGraphBudget,
) {
  let worker: Worker | undefined;
  const search = filters?.search;
  if (search?.mode === "regex" && search.value) {
    // 不可信 regex 连 compile/test 都留在可终止 worker；eval 是静态源码，打包后不依赖 TS asset。
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      execArgv: [],
      workerData: { value: search.value, caseSensitive: search.caseSensitive ?? false },
      resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 },
    });
    try {
      const ready = await waitForWorker(worker, Math.min(1000, budget.remainingMs()));
      if (!ready || typeof ready !== "object" || !("ready" in ready))
        throw gitGraphError("invalid-regex");
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }
  const literal = search?.caseSensitive ? search.value : search?.value.toLowerCase();
  return {
    async match(records: GitGraphRecord[]): Promise<boolean[]> {
      budget.remainingMs();
      const matches = records.map((record) => matchesIdentityAndDate(record, filters));
      if (!search?.value) return matches;
      const indices: number[] = [];
      const fields = records.flatMap((record, index) => {
        if (!matches[index]) return [];
        indices.push(index);
        return [[record.commit.subject, record.body, record.commit.hash]];
      });
      if (worker) {
        const activeWorker = worker;
        const result = await waitForWorker(
          activeWorker,
          Math.min(REGEX_BATCH_BUDGET_MS, budget.remainingMs()),
          () => activeWorker.postMessage(fields),
        );
        if (
          !Array.isArray(result) ||
          result.length !== fields.length ||
          result.some((value) => typeof value !== "boolean")
        )
          throw gitGraphError("query-timeout");
        indices.forEach((recordIndex, index) => {
          matches[recordIndex] = result[index] as boolean;
        });
      } else {
        fields.forEach((values, index) => {
          matches[indices[index]!] = values.some((value) =>
            (search.caseSensitive ? value : value.toLowerCase()).includes(literal ?? ""),
          );
        });
      }
      budget.remainingMs();
      return matches;
    },
    async close() {
      if (worker) {
        const active = worker;
        worker = undefined;
        await active.terminate();
      }
    },
  };
}
