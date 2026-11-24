import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { OrchestrationRunProjection } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { OrchestrationActivityStrip } from "@/v4/OrchestrationActivityStrip.js";

function makeRun(overrides: Partial<OrchestrationRunProjection> = {}): OrchestrationRunProjection {
  return {
    runId: "run-1",
    planId: "plan-1",
    revision: 0,
    generation: 1,
    status: "running",
    team: ["general-purpose", "Explore"],
    maxConcurrency: 2,
    startedAt: Date.now() - 62_000,
    updatedAt: Date.now(),
    active: true,
    steps: [
      {
        stepId: "a",
        title: "取证",
        role: "Explore",
        status: "completed",
        dependsOn: [],
        attempts: 1,
      },
      {
        stepId: "b",
        title: "抓取",
        role: "general-purpose",
        status: "running",
        dependsOn: ["a"],
        attempts: 1,
      },
      {
        stepId: "c",
        title: "汇总",
        role: "general-purpose",
        status: "pending",
        dependsOn: ["b"],
        attempts: 0,
      },
    ],
    ...overrides,
  };
}

function render(runs: readonly OrchestrationRunProjection[]): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(OrchestrationActivityStrip, { runs, onOpen: () => {} }),
    ),
  );
}

test("存在活动 run 时渲染常驻状态条，带进度与运行中子代理数", () => {
  const html = render([makeRun()]);
  assert.match(html, /v4-orchestration-activity-strip/);
  assert.match(html, /data-orchestration-active-runs="1"/);
  assert.match(html, /data-orchestration-running-steps="1"/);
  assert.match(html, /编排进行中/);
  assert.match(html, /完成 1\/3/);
  assert.match(html, /1 个子代理运行中/);
  assert.match(html, /详情/);
});

test("没有活动 run 时不渲染", () => {
  assert.equal(render([makeRun({ active: false, status: "completed" })]), "");
  assert.equal(render([]), "");
});
