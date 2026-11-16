import assert from "node:assert/strict";
import test from "node:test";
import { readModelRequestCostUsd } from "./model-request-cost.js";

test("仅明确 USD 费用进入请求日志，零费用是真实值", () => {
  assert.equal(readModelRequestCostUsd({ cost_usd: 0.01 }), 0.01);
  assert.equal(readModelRequestCostUsd({ cost_usd: 0 }), 0);
  assert.equal(readModelRequestCostUsd({ cost: 0.02, currency: "USD" }), 0.02);
  assert.equal(readModelRequestCostUsd({ cost: 2, currency: "CNY" }), undefined);
  assert.equal(readModelRequestCostUsd({ cost: 2 }), undefined);
  assert.equal(readModelRequestCostUsd({ cost_usd: -1 }), undefined);
  assert.equal(readModelRequestCostUsd({ cost_usd: Infinity }), undefined);
  assert.equal(readModelRequestCostUsd({ cost_usd: "0.02" }), undefined);
  assert.equal(readModelRequestCostUsd(undefined), undefined);
});
