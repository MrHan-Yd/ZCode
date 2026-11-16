import assert from "node:assert/strict";
import test from "node:test";
import type { ModelRequestLogsQueryInput } from "@zcode/contracts";
import { modelRequestLogsSnapshotSchema, type ModelRequestLogsRequest } from "@zcode/shared";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";
import { getModelRequestLogs, resolveModelRequestLogsSince } from "./model-request-logs.js";

const request: ModelRequestLogsRequest = {
  range: "today",
  view: "requests",
  page: 1,
  pageSize: 50,
  sortDirection: "desc",
  timeZone: "Asia/Shanghai",
};

test("今日按调用端自然日计算，包含 DST 23/25 小时日而非固定 UTC 偏移", () => {
  assert.equal(
    resolveModelRequestLogsSince("today", "Asia/Shanghai", Date.parse("2026-11-16T01:00:00Z")),
    Date.parse("2026-11-15T16:00:00Z"),
  );
  assert.equal(
    resolveModelRequestLogsSince("today", "America/New_York", Date.parse("2026-03-08T23:00:00Z")),
    Date.parse("2026-03-08T05:00:00Z"),
  );
  assert.equal(
    resolveModelRequestLogsSince("today", "America/New_York", Date.parse("2026-11-01T23:00:00Z")),
    Date.parse("2026-11-01T04:00:00Z"),
  );
  const now = Date.parse("2026-11-16T01:00:00Z");
  assert.equal(resolveModelRequestLogsSince("7d", "UTC", now), now - 7 * 86_400_000);
  assert.equal(resolveModelRequestLogsSince("30d", "UTC", now), now - 30 * 86_400_000);
});

test("协议只读转发过滤/分页与当前时间范围，结果符合严格 wire 契约", async () => {
  let received: ModelRequestLogsQueryInput | undefined;
  const context = {
    deps: {
      sessionStore: {
        queryModelRequestLogs: async (input: ModelRequestLogsQueryInput) => {
          received = input;
          return {
            range: input.range,
            view: input.view,
            generatedAt: input.until,
            timeZone: input.timeZone!,
            page: input.page,
            pageSize: input.pageSize,
            totalCount: 0,
            counts: { requests: 0, providers: 0, models: 0 },
            requests: [],
            groups: [],
          };
        },
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  const result = await getModelRequestLogs(context, request);
  modelRequestLogsSnapshotSchema.parse(result);
  assert.equal(received?.view, "requests");
  assert.equal(received?.timeZone, "Asia/Shanghai");
  assert.equal(
    received?.since,
    resolveModelRequestLogsSince("today", "Asia/Shanghai", received!.until),
  );
  await assert.rejects(getModelRequestLogs(context, { ...request, pageSize: 101 }));
});

test("缺查询方法明确报不可用，不能误报为零条日志", async () => {
  const context = { deps: { sessionStore: {} } } as unknown as ZCodeProtocolAgentServerContext;
  await assert.rejects(getModelRequestLogs(context, request), /model_request_logs_unavailable/);
});
