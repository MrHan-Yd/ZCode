import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSmartConfigEntry, ModelSmartConfigView } from "@zcode/services";
import { modelSmartConfigListState } from "../src/settings/modelSmartConfigListModel.js";

const rule: ModelSmartConfigEntry = { providerId: "deepseek", modelId: "deepseek-v5" };

function view(overrides: Partial<ModelSmartConfigView> = {}): ModelSmartConfigView {
  return {
    filePath: "/tmp/model-smart-config.json",
    remoteUrl: "https://example.invalid/index.json",
    revision: "rev-1",
    present: true,
    error: null,
    entries: [],
    ...overrides,
  };
}

test("有规则：走可折叠列表（默认收起由组件持有）", () => {
  assert.equal(modelSmartConfigListState(view({ entries: [rule] })), "list");
});

test("本地文件缺失或没有规则：空状态，不给展开控件", () => {
  assert.equal(
    modelSmartConfigListState(view({ present: false, revision: "absent", entries: [] })),
    "empty",
  );
});

test("解析失败：错误态优先，不能被默认收起藏起来", () => {
  // 文件损坏时 read() 不返回 file，entries 概念上为空；这里仍带上规则，锁定「error 压过条数判断」。
  assert.equal(
    modelSmartConfigListState(view({ error: "Unexpected token < in JSON", entries: [rule] })),
    "error",
  );
});

test("读取中（view 为 null）：按空状态呈现，与改动前的渲染分支一致", () => {
  assert.equal(modelSmartConfigListState(null), "empty");
});
