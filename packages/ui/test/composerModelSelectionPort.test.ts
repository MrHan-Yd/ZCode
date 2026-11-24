import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection } from "@zcode/shared";
import { createComposerModelSelectionPort } from "../src/v4/composer/composerModelSelectionPort.js";

const scope = { workspacePath: "/synthetic/repo", sessionId: "session-a" };
const first = { providerId: "provider-a", modelId: "model-a" };
const second = { providerId: "provider-b", modelId: "model-b" };

test("标题栏读取当前 Composer ref，不冻结注册时的模型", () => {
  const port = createComposerModelSelectionPort();
  let selection: ModelSelection | null = first;
  const release = port.register(scope, () => selection);
  try {
    assert.equal(port.read(scope), first);
    selection = second;
    assert.equal(port.read(scope), second);
    selection = null;
    assert.equal(port.read(scope), null);
  } finally {
    release();
  }
  assert.equal(port.read(scope), null);
});

test("不同会话、草稿与相同路径的远端 identity 分别隔离", () => {
  const port = createComposerModelSelectionPort();
  const release = port.register(scope, () => first);
  const remote = { ...scope, workspaceIdentity: "remote-a" };
  const releaseRemote = port.register(remote, () => second);
  try {
    assert.equal(port.read({ ...scope, sessionId: "session-b" }), null);
    assert.equal(port.read({ ...scope, sessionId: null }), null);
    assert.equal(port.read({ ...scope, workspaceIdentity: "remote-b" }), null);
    assert.equal(port.read({ ...scope, workspaceIdentity: "  " }), first);
    assert.equal(port.read({ ...remote, workspaceIdentity: " remote-a " }), second);
  } finally {
    releaseRemote();
    release();
  }
});

test("旧注册的延迟卸载不能删除新 owner，释放幂等", () => {
  const port = createComposerModelSelectionPort();
  const releaseOld = port.register(scope, () => first);
  const releaseNew = port.register(scope, () => second);
  releaseOld();
  releaseOld();
  assert.equal(port.read(scope), second);
  releaseNew();
  releaseNew();
  assert.equal(port.read(scope), null);
});
