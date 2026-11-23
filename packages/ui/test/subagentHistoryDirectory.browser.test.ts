import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Browser, Locator, Page } from "playwright-core";
import type { ViteDevServer } from "vite";
import {
  buildRemoteWorkspaceIdentity,
  zcodeSessionSubagentsResultSchema,
  type ZCodeSessionSubagentsResult,
} from "@zcode/shared";
import {
  conversationSnapshotSchema,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const require = createRequire(join(REPO_ROOT, "package.json"));
const PARENT_ID = "fixture-orchestration-parent";
const WORKSPACE_PATH = "/synthetic/subagent-history";
const AT = 1_767_225_600_000;
const CHILDREN = [
  {
    childSessionId: "fixture-child-success",
    agentId: "fixture-agent-success",
    subagentType: "frontend",
    title: "验证成功历史",
    status: "success",
    summary: "虚构成功：三项检查全部通过。",
    label: "成功",
    statusLabel: "已完成",
  },
  {
    childSessionId: "fixture-child-failed",
    agentId: "fixture-agent-failed",
    subagentType: "reviewer",
    title: "验证失败历史",
    status: "failed",
    summary: "虚构失败：验收校验未通过。",
    label: "失败",
    statusLabel: "失败",
  },
  {
    childSessionId: "fixture-child-cancelled",
    agentId: "fixture-agent-cancelled",
    subagentType: "Explore",
    title: "验证取消历史",
    status: "cancelled",
    summary: "虚构取消：用户取消了本次检查。",
    label: "取消",
    statusLabel: "已取消",
  },
] as const;

type ClientMode = "desktop-continuous" | "web-remote-replayable";
interface FixtureClient {
  clientMode: ClientMode;
  theme: "zai-light" | "zai-dark";
  directoryMode: "success" | "error" | "empty";
  revision: number;
  holdInitialId?: string;
}

function persistedBody(label: string): string {
  return `持久正文·${label}：这段完整历史只来自子会话存储，不是父会话结果摘要。`;
}

function earlierBody(label: string): string {
  return `历史过程·${label}：已检查虚构资料并保存第一轮审阅记录。`;
}

function makeSnapshot(
  sessionId: string,
  title: string,
  rows: ConversationRow[],
  result: "success" | "failed" | "cancelled" = "success",
): ConversationSnapshot {
  const allowed = { allowed: true } as const;
  return conversationSnapshotSchema.parse({
    protocolVersion: 1,
    sessionId,
    logEpoch: `fixture-epoch-${sessionId}`,
    seq: 1,
    revision: 1,
    meta: { title, titleSource: "custom" },
    control: {
      phase:
        result === "failed"
          ? "error"
          : result === "cancelled"
            ? "completedInterrupted"
            : "completedSuccess",
      sessionEnded: true,
      canStop: false,
      stopState: "idle",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError:
        result === "failed"
          ? {
              code: "fixture.validationFailed",
              message: CHILDREN[1].summary,
              recoverable: false,
              at: AT + 20_000,
              source: "runtime",
            }
          : null,
      apiRetry: null,
    },
    availability: {
      fork: allowed,
      compact: allowed,
      switchModelConfig: allowed,
      setFollowupMode: allowed,
      queueEdit: allowed,
      sendQueuedNow: allowed,
      pauseGoal: allowed,
      resumeGoal: allowed,
    },
    inputRouting: { mode: "startNow" },
    config: {
      provider: "fixture-provider",
      model: "fixture-model",
      thought: "",
      followupMode: "queue",
      mode: "build",
    },
    usage: {
      contextWindow: null,
      cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    subagents: { revision: 1, childSessionIds: [], running: [], endedTotal: 0 },
    goal: null,
    plan: null,
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  });
}

function makeHistoryFixture() {
  const directory = zcodeSessionSubagentsResultSchema.parse({
    revision: 1,
    childSessionIds: CHILDREN.map((child) => child.childSessionId),
    running: [],
    ended: {
      total: 3,
      items: CHILDREN.map(({ label: _label, statusLabel: _statusLabel, ...child }, index) => ({
        ...child,
        startedAt: AT + index * 1_000,
        endedAt: AT + 20_000 + index * 1_000,
      })),
    },
  });
  const children = Object.fromEntries(
    CHILDREN.map((child) => {
      const row = (rowId: number, turn = 1) => ({
        rowId,
        turnId: `${child.childSessionId}-turn-${turn}`,
        productTurnId: `${child.childSessionId}-product-${turn}`,
        entityId: `${child.childSessionId}-entity-${rowId}`,
        createdAt: AT + rowId * 1_000,
        createdAtSeq: rowId,
      });
      const rows: ConversationRow[] = [
        {
          ...row(1),
          kind: "turnHeader",
          origin: "userInput",
          state: "completedSuccess",
          startedAt: AT,
          endedAt: AT + 5_000,
          activeMs: 5_000,
        },
        {
          ...row(2),
          kind: "userInput",
          origin: "realUser",
          text: `历史请求·${child.label}：请审阅虚构资料。`,
          actions: { canEdit: true, canFork: true },
        },
        {
          ...row(3),
          kind: "reasoning",
          text: `已持久化的${child.label}任务分析。`,
          state: "complete",
        },
        {
          ...row(4),
          kind: "toolCall",
          toolCallId: `${child.childSessionId}-bash`,
          toolName: "Bash",
          status: "success",
          input: { command: `printf 'fixture-${child.status}-history'` },
          inputText: JSON.stringify({ command: `printf 'fixture-${child.status}-history'` }),
          output: { text: `持久工具输出-${child.status}-431` },
          startedAt: AT + 3_000,
          endedAt: AT + 4_000,
        },
        {
          ...row(5),
          kind: "assistantText",
          text: earlierBody(child.label),
          state: "complete",
          actions: { canFork: true, canRetry: true },
        },
        {
          ...row(6, 2),
          kind: "turnHeader",
          origin: "userInput",
          state:
            child.status === "failed"
              ? "failed"
              : child.status === "cancelled"
                ? "completedInterrupted"
                : "completedSuccess",
          startedAt: AT + 6_000,
          endedAt: AT + 8_000,
          activeMs: 2_000,
        },
        {
          ...row(7, 2),
          kind: "userInput",
          origin: "realUser",
          text: `后续请求·${child.label}：保留完整审计正文。`,
          actions: { canEdit: true, canFork: true },
        },
        {
          ...row(8, 2),
          kind: "assistantText",
          text: persistedBody(child.label),
          state:
            child.status === "failed"
              ? "failed"
              : child.status === "cancelled"
                ? "interrupted"
                : "complete",
          actions: { canFork: true, canRetry: true },
        },
      ];
      return [
        child.childSessionId,
        makeSnapshot(child.childSessionId, child.title, rows, child.status),
      ];
    }),
  );
  // 编排父会话没有伪造的 Agent / Task 工具行；目录事实只通过原 service 契约和 V4 manifest 到达 UI。
  const parent = makeSnapshot(PARENT_ID, "虚构编排历史回归", [
    {
      rowId: 1,
      turnId: "fixture-parent-turn",
      createdAt: AT,
      createdAtSeq: 1,
      kind: "userInput",
      origin: "realUser",
      orchestrationEnabled: true,
      text: "执行三项虚构编排检查。",
    },
    {
      rowId: 2,
      turnId: "fixture-parent-turn",
      createdAt: AT + 30_000,
      createdAtSeq: 2,
      kind: "assistantText",
      state: "complete",
      text: "三项虚构任务已结束，完整正文保存在各子会话中。",
    },
  ]);
  parent.subagents = {
    revision: directory.revision,
    childSessionIds: directory.childSessionIds,
    running: directory.running,
    endedTotal: directory.ended.total,
  };
  return { directory, parent, children };
}

// 只装配真实组件/provider，不替换目录、详情、投影 store 或 transport。运行 fixture 全部写入系统临时目录。
const BROWSER_FIXTURE = String.raw`
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import { V4_WIRE_PROTOCOL_VERSION, conversationTopicFrameSchema, encodeTopicWireFrames } from "@zcode/shared/zcode-protocol-v4";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs.js";
import { SubagentDirectorySidePane } from "@/app-shell/SubagentDirectorySidePane.js";
import { SubagentSessionSidePane } from "@/app-shell/SubagentSessionSidePane.js";
import { SessionPane } from "@/v4/SessionPane.js";
import { V4PaneConversationProvider } from "@/v4/V4ConversationContext.js";
import { openStatusPanelOverlay } from "@/v4/statusPanelOverlayStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { registerBaseWorkspaceServices, registerRemoteWorkspaceSession, bindRemoteWorkspaceIdentity } from "@/store/remoteWorkspaceSessionStore.js";
import { getActiveSidePaneTab, openSubagentDirectorySidePane, openSubagentSessionSidePane, setActiveSidePaneTab, syncSubagentSessionSidePaneTabs } from "@/lib/workspaceSidePane.js";
import "@/styles.css";

const clientId = new URL(location.href).searchParams.get("case");
async function read(operation, params = {}) {
  const response = await fetch("/__fixture/read?case=" + encodeURIComponent(clientId), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, params }),
  });
  if (!response.ok) throw new Error("fixture.directoryUnavailable");
  return response.json();
}
const bootstrap = await read("bootstrap");
const { scope, parentSessionId, clientMode, theme, holdInitialId } = bootstrap;
const workspaceKey = scope.workspaceIdentity?.trim() || scope.workspacePath;
const audit = { calls: [], physical: [], sync: [], forbidden: [], clientHello: null, ready: false };
const frameListeners = new Set();
const subscriptions = new Map();
const noEvent = () => ({ dispose() {} });
let nextSubscription = 0;
let releaseInitial;
const initialGate = holdInitialId ? new Promise((resolve) => { releaseInitial = resolve; }) : null;
function checkScope(operation, params) {
  audit.calls.push({ operation, ...params });
  if (params.workspacePath !== scope.workspacePath || (params.workspaceIdentity || "") !== (scope.workspaceIdentity || "")) {
    throw new Error("fixture.workspaceScopeMismatch:" + operation);
  }
}
function emit(record, payload, deliveryKind, fromSeq = 0) {
  const frame = conversationTopicFrameSchema.parse({
    topic: "conversation/" + record.sessionId, subscriptionId: record.id,
    fromSeq, toSeq: record.snapshot.seq, sentAt: Date.now(), payload,
  });
  const wires = encodeTopicWireFrames(frame, {
    deliveryKind, logicalFrameId: record.id + "/" + (++record.ordinal), logicalFrameOrdinal: record.ordinal,
    topic: frame.topic, subscriptionId: record.id, maxPhysicalFrameBytes: 1536,
    measurePhysicalFrameBytes: (wire) => new TextEncoder().encode(JSON.stringify(wire)).byteLength,
  });
  for (const wire of wires) {
    audit.physical.push({ sessionId: record.sessionId, deliveryKind, kind: wire.kind });
    for (const listener of frameListeners) listener(wire);
  }
}
const agent = {
  async helloConversationV4() {
    audit.calls.push({ operation: "hello" });
    return { kind: "hello", protocolVersion: V4_WIRE_PROTOCOL_VERSION, connectionId: "fixture-connection", clientMode,
      deliveryProfile: clientMode === "desktop-continuous" ? "continuous" : "replayable", serverTime: Date.now(),
      capabilities: { nativeDialogs: false, localTerminal: false, binaryFrames: false, compression: "none" }, auth: {} };
  },
  async initializeConversationV4(hello) { audit.clientHello = hello; return {}; },
  onDynamicConversationFrame: (params) => {
    checkScope("frames", params);
    return (listener) => { frameListeners.add(listener); return { dispose() { frameListeners.delete(listener); } }; };
  },
  onDynamicLocalTtftFacts: () => noEvent,
  onAgentRuntimeRestarted: noEvent,
  async subscribeConversationV4(params) {
    checkScope("subscribe", params);
    const snapshot = await read("snapshot", params);
    if (params.sessionId === holdInitialId) await initialGate;
    const record = { id: "fixture-sub-" + (++nextSubscription), sessionId: params.sessionId, snapshot, ordinal: 0 };
    subscriptions.set(record.id, record);
    // ACK 与首帧可在同一批回调到达；由真实 ackActivationBarrier 在 store 激活后释放 owned physical 帧。
    queueMicrotask(() => emit(record, { kind: "snapshot", snapshot }, "initial"));
    return { ack: { subscriptionId: record.id, mode: "snapshot", logEpoch: snapshot.logEpoch } };
  },
  async resyncConversationV4(params) {
    checkScope("resync", params);
    const record = subscriptions.get(params.subscriptionId);
    if (!record) throw new Error("fixture.notOwned");
    queueMicrotask(() => emit(record, { kind: "snapshot", snapshot: record.snapshot }, "recovery"));
    return { ack: { subscriptionId: record.id, mode: "snapshot", logEpoch: record.snapshot.logEpoch } };
  },
  async unsubscribeConversationV4(params) { checkScope("unsubscribe", params); subscriptions.delete(params.subscriptionId); return {}; },
  async listSessionSubagents(params) {
    checkScope("directory", params);
    if ((params.remoteSessionId || "") !== (scope.remoteSessionId || "")) throw new Error("fixture.remoteSessionMismatch");
    return read("directory", params);
  },
  async conversationPlansV4(params) { checkScope("plans", params); return { plans: [] }; },
  async conversationTailPreviewV4(params) { checkScope("tailPreview", params); return null; },
  async queryConversationCommandsV4(params) { checkScope("queryCommands", params); return { entries: [] }; },
  async conversationRowsRangeV4(params) { checkScope("rowsRange", params); throw new Error("fixture.unexpectedPagination"); },
  onDynamicSessionsIndexFrame: () => noEvent,
  async subscribeSessionsIndexV4(params) {
    checkScope("sessionsIndex", params);
    return { ack: { subscriptionId: "fixture-index", mode: "snapshot", logEpoch: "fixture-index-epoch" } };
  },
  async unsubscribeSessionsIndexV4() { return {}; },
  async sendConversationCommandV4(params) { audit.forbidden.push(params); throw new Error("fixture.readOnlyMutation"); },
};
const broadcast = { onMessage: noEvent, async send() { audit.forbidden.push("broadcast.write"); throw new Error("fixture.readOnlyMutation"); } };
const services = {
  zcodeAgentService: agent,
  broadcastService: broadcast,
  settingService: { async get() { return { locale: "zh-CN", toolGroupingExploreEnabled: false, toolGroupingTerminalEnabled: false, toolGroupingChangesEnabled: false }; } },
  modelSelectionService: { onDidChange: noEvent, async getView(input) { return { revision: 1, providers: [], effectiveSelection: input?.selection || null }; } },
};
const baseServices = scope.remoteSessionId ? {
  ...services,
  zcodeAgentService: new Proxy(agent, { get(_target, name) {
    return () => { audit.forbidden.push("local-fallback:" + String(name)); throw new Error("fixture.remoteMustNotUseLocalHost"); };
  } }),
} : services;
registerBaseWorkspaceServices(baseServices);
if (scope.remoteSessionId) {
  registerRemoteWorkspaceSession({ sessionId: scope.remoteSessionId, services });
  bindRemoteWorkspaceIdentity(scope.workspaceIdentity, scope.remoteSessionId);
  const expected = buildRemoteWorkspaceIdentity(scope.workspacePath, { kind: "ssh", host: "fixture.invalid", username: "fixture" });
  if (expected !== scope.workspaceIdentity) throw new Error("fixture.identityContractMismatch");
}
const workspaceStore = useZCodeSessionStore.getState();
// 只种已有 workspace 的展示目录，禁止 SessionPane 为测试拉起真实 Agent 做目录水合。
workspaceStore.setConfigOptions(scope.workspacePath, [{ id: "mode", category: "mode", type: "select", currentValue: "build", options: [] }], scope.workspaceIdentity);
workspaceStore.setConfigOptionsStatus(scope.workspacePath, "ready", scope.workspaceIdentity);
workspaceStore.setSlashCommands(scope.workspacePath, [{ name: "fixture", description: "虚构只读目录" }], scope.workspaceIdentity);
localStorage.setItem("zcode-theme", theme);
document.documentElement.classList.add("theme-" + theme);
openStatusPanelOverlay(parentSessionId);
const platform = { onSettingsChanged: () => () => {} };
const bridge = {
  audit, releaseInitial: () => releaseInitial?.(),
  async refreshParent() {
    const record = Array.from(subscriptions.values()).find((entry) => entry.sessionId === parentSessionId);
    if (!record) throw new Error("fixture.parentNotSubscribed");
    const next = await read("snapshot", { ...scope, sessionId: parentSessionId });
    const before = record.snapshot.seq;
    next.seq = before + (clientMode === "web-remote-replayable" ? 2 : 1);
    record.snapshot = next;
    // 手机链路故意漏一帧，让真实 store → transport.resync → same-sub recovery 修复断档；桌面走连续增量。
    emit(record, { kind: "deltas", deltas: [{ op: "state.updated", patch: { revision: next.revision, subagents: next.subagents } }] }, "online",
      clientMode === "web-remote-replayable" ? before + 1 : before);
    return next.seq;
  },
};
window.__subagentHistoryTest = bridge;
function Harness() {
  const [sidePane, setSidePane] = useState(null);
  const openDirectory = useCallback((request) => setSidePane((current) => openSubagentDirectorySidePane(current, { workspaceKey, ...scope, ...request })), []);
  const openSession = useCallback((request) => setSidePane((current) => openSubagentSessionSidePane(current, { workspaceKey, ...request })), []);
  const syncTabs = useCallback((request) => {
    audit.sync.push(request);
    setSidePane((current) => syncSubagentSessionSidePaneTabs(current, request));
  }, []);
  const active = getActiveSidePaneTab(sidePane);
  useEffect(() => {
    bridge.getSidePane = () => sidePane;
    bridge.openDirectory = () => openDirectory({ parentSessionId, rootSessionId: parentSessionId });
    audit.ready = true;
  }, [sidePane, openDirectory]);
  return (
    <Tabs value={sidePane?.activeTabId || "parent"} onValueChange={(id) => setSidePane((current) => id === "parent" ? current && { ...current, activeTabId: "" } : setActiveSidePaneTab(current, id))} className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <TabsList aria-label="会话与历史详情" className="w-full shrink-0 justify-start overflow-x-auto rounded-none">
        <TabsTrigger value="parent" className="shrink-0 flex-none">父会话</TabsTrigger>
        {sidePane?.tabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className="max-w-48 shrink-0 flex-none truncate">{tab.type === "subagent-directory" ? "子智能体目录" : tab.title}</TabsTrigger>)}
      </TabsList>
      <div className="flex min-h-0 min-w-0 flex-1">
        <section data-testid="fixture-parent" className={(active ? "hidden md:block " : "") + "h-full min-h-0 min-w-0 flex-1"}>
          <V4PaneConversationProvider scope={scope}>
            <SessionPane paneId="fixture-parent-pane" sessionId={parentSessionId} workspacePath={scope.workspacePath} workspaceIdentity={scope.workspaceIdentity} remoteSessionId={scope.remoteSessionId} readOnly focused={!active} onOpenSubagentDirectory={openDirectory} onOpenSubagentSession={openSession} onSyncSubagentSessionTabs={syncTabs} />
          </V4PaneConversationProvider>
        </section>
        {sidePane?.tabs.map((tab) => (
          <TabsContent key={tab.id} value={tab.id} forceMount className={(active?.id === tab.id ? "flex " : "hidden ") + "h-full min-h-0 min-w-0 flex-1 flex-col border-l border-border"}>
            {tab.type === "subagent-directory" ? <SubagentDirectorySidePane tab={tab} onOpenSubagentSession={openSession} /> : <SubagentSessionSidePane tab={tab} focused={active?.id === tab.id} onOpenSubagentSession={openSession} />}
          </TabsContent>
        ))}
      </div>
    </Tabs>
  );
}
const root = createRoot(document.getElementById("root"));
root.render(<ServiceProvider services={baseServices}><PlatformProvider platform={platform}><StoreProvider broadcastService={broadcast}><TabStoreProvider><ZCodeIntlProvider initialLocale="zh-CN"><TooltipProvider><Harness /></TooltipProvider></ZCodeIntlProvider></TabStoreProvider></StoreProvider></PlatformProvider></ServiceProvider>);
`;

async function assertReadable(locator: Locator) {
  await locator.waitFor({ state: "visible" });
  await locator.scrollIntoViewIfNeeded();
  const bounds = await locator.boundingBox();
  assert.ok(bounds && bounds.width > 0 && bounds.height > 0, "历史正文必须真实渲染且可见");
}

async function assertReadOnly(pane: Locator) {
  assert.equal(
    await pane
      .locator('[contenteditable="true"], textarea, [data-testid^="v4-composer-input"]')
      .count(),
    0,
  );
  assert.equal(
    await pane
      .locator(
        '[data-testid^="v4-edit-"], [data-testid^="v4-fork-"], [data-testid^="v4-retry-"], [data-testid^="v4-feedback-"]',
      )
      .count(),
    0,
  );
}

async function assertDirectory(page: Page) {
  const directory = page
    .getByRole("tabpanel")
    .filter({ has: page.getByRole("heading", { name: "子智能体目录", exact: true }) });
  await directory
    .getByRole("heading", { name: "已结束 · 3", exact: true })
    .waitFor({ state: "visible" });
  for (const child of CHILDREN) {
    const row = directory.getByRole("button", { name: new RegExp(child.title) });
    await row.waitFor({ state: "visible" });
    assert.equal(await row.count(), 1, "同一 child 只显示一行");
    const text = await row.innerText();
    assert.ok(text.includes(child.statusLabel), text);
    assert.ok(text.includes(child.summary), text);
    assert.ok(
      text
        .replace(child.title, "")
        .replace(child.statusLabel, "")
        .replace(child.summary, "")
        .trim(),
      "保留时间信息",
    );
  }
  assert.equal(await directory.getByRole("button").count(), 3);
  return directory;
}

async function assertDetail(page: Page, child: (typeof CHILDREN)[number]) {
  const pane = page.getByRole("tabpanel", { name: child.title, exact: true });
  await assertReadable(pane.getByText(persistedBody(child.label), { exact: true }));
  await assertReadable(pane.getByText(earlierBody(child.label), { exact: true }));
  const historyToggle = pane.locator('button[data-history-open="false"]').first();
  if (await historyToggle.count()) await historyToggle.click();
  const tool = pane.locator(`[data-tool-call-id="${child.childSessionId}-bash"]`);
  await tool.waitFor({ state: "visible" });
  assert.equal(await tool.getAttribute("data-tool-name"), "Bash");
  const toggle = tool.getByRole("button", { name: "展开工具详情", exact: true });
  if (await toggle.count()) await toggle.click();
  await assertReadable(
    tool.getByText(`持久工具输出-${child.status}-431`, { exact: false }).first(),
  );
  await assertReadOnly(pane);
  if (child.status === "failed") {
    assert.equal(await pane.getByTestId("v4-subagent-readonly-error").innerText(), child.summary);
  }
  assert.equal(await pane.locator('[data-session-id="' + child.childSessionId + '"]').count(), 1);
}

async function refreshParent(page: Page, fixture: FixtureClient) {
  fixture.revision += 1;
  const seq = await page.evaluate(() =>
    (
      window as unknown as { __subagentHistoryTest: { refreshParent(): Promise<number> } }
    ).__subagentHistoryTest.refreshParent(),
  );
  await page.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-session-id="fixture-orchestration-parent"]')
        ?.getAttribute("data-projection-seq") === String(expected),
    seq,
  );
  await page.waitForFunction((revision) => {
    const bridge = (
      window as unknown as {
        __subagentHistoryTest: { audit: { calls: Array<{ operation: string }> } };
      }
    ).__subagentHistoryTest;
    return bridge.audit.calls.filter((call) => call.operation === "directory").length >= revision;
  }, fixture.revision);
}

test("真实子智能体目录与只读持久详情的隔离浏览器回归", { timeout: 300_000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "zcode-subagent-history-browser-"));
  let server: ViteDevServer | undefined;
  let browser: Browser | undefined;
  const clients = new Map<string, FixtureClient>();
  try {
    const history = makeHistoryFixture();
    const historyPath = join(temporary, "history.json");
    await Promise.all([
      writeFile(historyPath, JSON.stringify(history), "utf8"),
      writeFile(join(temporary, "fixture.tsx"), BROWSER_FIXTURE, "utf8"),
      writeFile(
        join(temporary, "index.html"),
        '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="icon" href="data:,"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>',
        "utf8",
      ),
    ]);
    const { createServer } = (await import(
      pathToFileURL(require.resolve("vite")).href
    )) as typeof import("vite");
    const { default: react } = (await import(
      pathToFileURL(require.resolve("@vitejs/plugin-react")).href
    )) as typeof import("@vitejs/plugin-react");
    const { default: tailwindcss } = (await import(
      pathToFileURL(require.resolve("@tailwindcss/vite")).href
    )) as typeof import("@tailwindcss/vite");
    const uiRequire = createRequire(join(REPO_ROOT, "packages/ui/package.json"));
    server = await createServer({
      configFile: false,
      root: temporary,
      cacheDir: join(temporary, ".vite"),
      publicDir: join(REPO_ROOT, "packages/web/public"),
      plugins: [
        react(),
        tailwindcss(),
        {
          name: "readonly-subagent-history-fixture",
          configureServer(vite) {
            vite.middlewares.use((request, response, next) => {
              if (!request.url?.startsWith("/__fixture/read")) return next();
              void (async () => {
                const key = new URL(request.url!, "http://fixture.invalid").searchParams.get(
                  "case",
                );
                const client = clients.get(key ?? "");
                assert.ok(client, "未知浏览器 fixture");
                const chunks: Buffer[] = [];
                for await (const chunk of request) chunks.push(Buffer.from(chunk));
                const { operation, params } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                const persisted = JSON.parse(await readFile(historyPath, "utf8")) as typeof history;
                let result: unknown;
                if (operation === "bootstrap") {
                  const remote = client.clientMode === "web-remote-replayable";
                  result = {
                    parentSessionId: PARENT_ID,
                    clientMode: client.clientMode,
                    theme: client.theme,
                    holdInitialId: client.holdInitialId,
                    scope: {
                      workspacePath: WORKSPACE_PATH,
                      ...(remote
                        ? {
                            workspaceIdentity: buildRemoteWorkspaceIdentity(WORKSPACE_PATH, {
                              kind: "ssh",
                              host: "fixture.invalid",
                              username: "fixture",
                            }),
                            remoteSessionId: "fixture-remote-attachment",
                          }
                        : {}),
                    },
                  };
                } else {
                  const directory: ZCodeSessionSubagentsResult =
                    zcodeSessionSubagentsResultSchema.parse(
                      client.directoryMode === "empty"
                        ? {
                            revision: client.revision,
                            childSessionIds: [],
                            running: [],
                            ended: { total: 0, items: [] },
                          }
                        : { ...persisted.directory, revision: client.revision },
                    );
                  if (operation === "directory") {
                    assert.equal(params.sessionId, PARENT_ID);
                    if (client.directoryMode === "error") {
                      response.statusCode = 503;
                      response.end("fixture.directoryUnavailable");
                      return;
                    }
                    result = directory;
                  } else {
                    assert.equal(operation, "snapshot");
                    if (params.sessionId === PARENT_ID) {
                      result = conversationSnapshotSchema.parse({
                        ...persisted.parent,
                        revision: client.revision,
                        subagents: {
                          revision: directory.revision,
                          childSessionIds: directory.childSessionIds,
                          running: directory.running,
                          endedTotal: directory.ended.total,
                        },
                      });
                    } else {
                      assert.ok(
                        Object.hasOwn(persisted.children, params.sessionId),
                        "只允许读取虚构子会话",
                      );
                      result = conversationSnapshotSchema.parse(
                        persisted.children[params.sessionId],
                      );
                    }
                  }
                }
                response.setHeader("content-type", "application/json");
                response.end(JSON.stringify(result));
              })().catch((error) => {
                response.statusCode = 500;
                response.end(String(error));
              });
            });
          },
        },
      ],
      resolve: {
        alias: [
          { find: "@", replacement: join(REPO_ROOT, "packages/ui/src") },
          ...[
            "react",
            "react-dom",
            "react-dom/client",
            "react/jsx-runtime",
            "react/jsx-dev-runtime",
            "@zcode/shared",
            "@zcode/shared/zcode-protocol-v4",
            "d3-path",
          ].map((name) => ({
            find: new RegExp("^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"),
            replacement: uiRequire.resolve(name),
          })),
        ],
        dedupe: ["react", "react-dom"],
      },
      optimizeDeps: {
        include: ["react", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"],
      },
      server: { host: "127.0.0.1", port: 0, fs: { allow: [temporary, REPO_ROOT] } },
      define: {
        __ZCODE_VERSION__: JSON.stringify("fixture"),
        __ZCODE_ENV__: JSON.stringify("test"),
        __ZCODE_COMMIT__: JSON.stringify("fixture"),
      },
    });
    await server.listen();
    const address = server.httpServer?.address();
    assert.ok(address && typeof address === "object");
    const origin = `http://127.0.0.1:${address.port}`;
    // Windows 的 ESM/CJS 互操作可能丢失命名导出；chromium 必须从原 CJS require 入口取得。
    const { chromium } = require("playwright-core") as typeof import("playwright-core");
    browser = await chromium.launch({
      executablePath:
        process.env.CHROME_EXECUTABLE_PATH ??
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true,
      downloadsPath: join(temporary, "downloads"),
    });
    const modes: ClientMode[] = ["desktop-continuous", "web-remote-replayable"];
    const scenarios = modes.flatMap((clientMode) => [
      { clientMode, width: 1366, theme: "zai-light" as const, states: false },
      { clientMode, width: 390, theme: "zai-dark" as const, states: false },
      { clientMode, width: 390, theme: "zai-light" as const, states: true },
    ]);
    for (const scenario of scenarios) {
      await t.test(
        `${scenario.clientMode} ${scenario.width}px ${scenario.states ? "加载/错误/空态恢复" : "三条历史、只读详情与投影刷新"}`,
        {
          timeout: 120_000,
          skip:
            process.env.SUBAGENT_BROWSER_CASE !== undefined &&
            process.env.SUBAGENT_BROWSER_CASE !==
              `${scenario.clientMode}-${scenario.width}-${scenario.states}`,
        },
        async (scenarioTest) => {
          const key = `${scenario.clientMode}-${scenario.width}-${scenario.states}`;
          const fixture: FixtureClient = {
            clientMode: scenario.clientMode,
            theme: scenario.theme,
            directoryMode: "success",
            revision: 1,
            ...(scenario.states ? { holdInitialId: CHILDREN[0].childSessionId } : {}),
          };
          clients.set(key, fixture);
          const context = await browser!.newContext({
            viewport: { width: scenario.width, height: 900 },
            locale: "zh-CN",
            colorScheme: scenario.theme === "zai-dark" ? "dark" : "light",
          });
          const errors: string[] = [];
          const expectedNetworkErrors: string[] = [];
          const unavailableResponses: string[] = [];
          const external: string[] = [];
          try {
            await context.route("**/*", (route) => {
              const url = route.request().url();
              if (/^https?:/u.test(url) && new URL(url).origin !== origin) {
                external.push(url);
                return route.abort();
              }
              return route.continue();
            });
            const page = await context.newPage();
            page.setDefaultTimeout(30_000);
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("response", (response) => {
              if (
                response.status() === 503 &&
                response.url() === `${origin}/__fixture/read?case=${encodeURIComponent(key)}`
              )
                unavailableResponses.push(response.url());
            });
            page.on("console", (message) => {
              if (message.type() !== "error") return;
              // 故意注入的 503 必然产生 Chromium 网络日志；只放行本 fixture 地址的这一条，应用异常仍严格失败。
              if (
                scenario.states &&
                message.text() ===
                  "Failed to load resource: the server responded with a status of 503 (Service Unavailable)" &&
                message.location().url ===
                  `${origin}/__fixture/read?case=${encodeURIComponent(key)}`
              )
                expectedNetworkErrors.push(message.text());
              else errors.push(message.text());
            });
            await page.goto(`${origin}/?case=${encodeURIComponent(key)}`);
            await page.waitForFunction(
              () =>
                (window as unknown as { __subagentHistoryTest?: { audit: { ready: boolean } } })
                  .__subagentHistoryTest?.audit.ready,
            );
            const parent = page.getByTestId("fixture-parent");
            await parent.locator('[data-status-section-trigger="agent"]').first().click();
            const endedEntry = parent.getByRole("button", { name: /^已结束\s*3$/u });
            await endedEntry.click();
            let directory = await assertDirectory(page);
            const toOpen = scenario.states ? CHILDREN.slice(0, 1) : CHILDREN;
            for (const child of toOpen) {
              await directory.getByRole("button", { name: new RegExp(child.title) }).click();
              if (scenario.states) {
                const pane = page.getByRole("tabpanel", { name: child.title, exact: true });
                await pane.getByTestId("v4-timeline-loading").waitFor({ state: "visible" });
                await assertReadOnly(pane);
                await page.evaluate(() =>
                  (
                    window as unknown as { __subagentHistoryTest: { releaseInitial(): void } }
                  ).__subagentHistoryTest.releaseInitial(),
                );
                await pane.getByTestId("v4-timeline-loading").waitFor({ state: "hidden" });
              }
              await assertDetail(page, child);
              await refreshParent(page, fixture);
              await assertDetail(page, child);
              await page.getByRole("tab", { name: "子智能体目录", exact: true }).click();
              directory = await assertDirectory(page);
            }
            if (scenario.states) {
              fixture.directoryMode = "error";
              await refreshParent(page, fixture);
              await directory.getByRole("alert").waitFor({ state: "visible" });
              assert.equal(
                await directory.getByRole("alert").innerText(),
                "无法加载子智能体目录。",
              );
              await assertDirectory(page);
              await directory.getByRole("button", { name: new RegExp(CHILDREN[0].title) }).click();
              await assertDetail(page, CHILDREN[0]);
              await page.getByRole("tab", { name: "子智能体目录", exact: true }).click();
              fixture.directoryMode = "success";
              await refreshParent(page, fixture);
              await directory.getByRole("alert").waitFor({ state: "hidden" });
              await assertDirectory(page);
              fixture.directoryMode = "empty";
              await refreshParent(page, fixture);
              await directory
                .getByRole("heading", { name: "已结束 · 0", exact: true })
                .waitFor({ state: "visible" });
              await page.waitForFunction(
                () =>
                  Array.from(
                    document.querySelectorAll('[role="tabpanel"][data-state="active"] button'),
                  ).length === 0,
              );
              assert.equal(
                await directory.getByText("没有正在运行的子智能体", { exact: true }).count(),
                1,
              );
              assert.equal(
                await page.getByRole("tab", { name: CHILDREN[0].title, exact: true }).count(),
                0,
                "只有空 manifest 才回收失效详情页签",
              );
            } else {
              await page.getByRole("tab", { name: "父会话", exact: true }).click();
              await endedEntry.waitFor({ state: "visible" });
              await endedEntry.click();
              await assertDirectory(page);
              assert.equal(
                await page.getByRole("tab", { name: "子智能体目录", exact: true }).count(),
                1,
                "重新打开目录幂等复用页签",
              );
              for (const child of CHILDREN) {
                assert.equal(
                  await page.getByRole("tab", { name: child.title, exact: true }).count(),
                  1,
                  "父投影刷新后保留历史详情入口",
                );
                await page.getByRole("tab", { name: child.title, exact: true }).click();
                await assertDetail(page, child);
              }
              await page.reload();
              await parent.locator('[data-status-section-trigger="agent"]').first().click();
              await endedEntry.click();
              directory = await assertDirectory(page);
              await directory.getByRole("button", { name: new RegExp(CHILDREN[2].title) }).click();
              await assertDetail(page, CHILDREN[2]);
            }
            const audit = await page.evaluate(
              () =>
                (
                  window as unknown as {
                    __subagentHistoryTest: {
                      audit: {
                        forbidden: unknown[];
                        calls: Array<{ operation: string }>;
                        physical: Array<{ deliveryKind: string; kind: string }>;
                        sync: Array<{ validChildSessionIds: string[] }>;
                        clientHello: { clientKind: string };
                      };
                    };
                  }
                ).__subagentHistoryTest.audit,
            );
            assert.deepEqual(audit.forbidden, [], "不得发送编辑/运行命令、回落本地 Host 或改设置");
            assert.equal(
              audit.clientHello.clientKind,
              scenario.clientMode === "desktop-continuous" ? "desktop" : "web",
            );
            assert.ok(
              audit.physical.some((wire) => wire.kind === "fragment"),
              "真实 physical wire assembler 被执行",
            );
            if (scenario.states) {
              assert.ok(
                audit.physical.some(
                  (wire) =>
                    wire.deliveryKind ===
                    (scenario.clientMode === "desktop-continuous" ? "online" : "recovery"),
                ),
              );
              assert.ok(audit.sync.some((request) => request.validChildSessionIds.length === 3));
            }
            assert.ok(
              audit.sync.some((request) => request.validChildSessionIds.length === 3),
              "真实父 SessionPane 触发原页签同步路径",
            );
            const overflow = await page.evaluate(() => ({
              viewport: innerWidth,
              width: document.documentElement.scrollWidth,
            }));
            assert.ok(overflow.width <= overflow.viewport, JSON.stringify(overflow));
            assert.deepEqual(external, [], "测试不访问模型、生产 Host 或外部网络");
            assert.equal(
              unavailableResponses.length,
              scenario.states ? 1 : 0,
              "网络失败只来自明确注入的目录 503",
            );
            assert.equal(
              expectedNetworkErrors.length,
              scenario.states ? 1 : 0,
              "Chromium 的预期网络日志与 503 一一对应",
            );
            assert.deepEqual(errors, [], "浏览器没有白屏、未捕获异常或额外 Console Error");
          } catch (error) {
            const page = context.pages()[0];
            scenarioTest.diagnostic(
              JSON.stringify({
                errors,
                dom: page ? (await page.locator("body").innerText()).slice(0, 6000) : null,
                audit: page
                  ? await page.evaluate(
                      () =>
                        (window as unknown as { __subagentHistoryTest?: { audit: unknown } })
                          .__subagentHistoryTest?.audit,
                    )
                  : null,
                tools: page
                  ? await page
                      .locator("[data-tool-call-id]")
                      .evaluateAll((elements) =>
                        elements.map((element) => element.outerHTML.slice(0, 8000)),
                      )
                  : [],
              }),
            );
            throw error;
          } finally {
            await context.close();
            clients.delete(key);
          }
        },
      );
    }
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        await server?.close();
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
});
