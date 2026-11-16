import assert from "node:assert/strict";
import test from "node:test";
import type {
  ApiClient,
  ModelRequestLogsServiceRequest,
  ModelRequestLogsSnapshot,
} from "@zcode/shared";
import type { IAccountRequestAuthService } from "../src/model-provider/accountRequestAuthService.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";

const request: ModelRequestLogsServiceRequest = {
  range: "7d",
  view: "models",
  page: 2,
  pageSize: 50,
  sortDirection: "asc",
  status: "error",
  timeZone: "Asia/Shanghai",
};
const snapshot: ModelRequestLogsSnapshot = {
  range: "7d",
  view: "models",
  generatedAt: 1_000,
  timeZone: "Asia/Shanghai",
  page: 2,
  pageSize: 50,
  totalCount: 0,
  counts: { requests: 0, providers: 0, models: 0 },
  requests: [],
  groups: [],
};

function service(
  read: (request: ModelRequestLogsServiceRequest) => Promise<ModelRequestLogsSnapshot>,
) {
  return createUsageStatsService({
    apiClient: {} as ApiClient,
    accountRequestAuthService: {} as IAccountRequestAuthService,
    zcodeAgentService: {
      getAppUsageStats: async () => {
        throw new Error("unexpected aggregate fallback");
      },
      getModelRequestLogs: read,
    },
  });
}

test("请求日志服务完整转发当前环境的筛选与分页，不读 monitor 或聚合 fallback", async () => {
  const calls: ModelRequestLogsServiceRequest[] = [];
  const usage = service(async (query) => {
    calls.push(query);
    return snapshot;
  });
  assert.deepEqual(await usage.getModelRequestLogs(request), snapshot);
  assert.deepEqual(calls, [request]);
});

test("请求日志服务转发远端完整身份且不做 path-only 关联", async () => {
  const remote = {
    ...request,
    workspacePath: "/fixture",
    workspaceIdentity: "fixture-identity",
    remoteSessionId: "fixture-attachment",
  };
  let received: ModelRequestLogsServiceRequest | undefined;
  const usage = service(async (query) => {
    received = query;
    return snapshot;
  });
  await usage.getModelRequestLogs(remote);
  assert.deepEqual(received, remote);
  await assert.rejects(
    usage.getModelRequestLogs({ ...request, remoteSessionId: "fixture-attachment" }),
  );
});

test("请求日志对端不可用时保留失败，不把错误变成空数据", async () => {
  const error = new Error("Method not found");
  const usage = service(async () => {
    throw error;
  });
  await assert.rejects(usage.getModelRequestLogs(request), (value) => value === error);
});
