import assert from "node:assert/strict";
import { buildRemoteWorkspaceIdentity, TID_CHAT_STATUS_ENTRY } from "@zcode/shared";
import {
  statusPanel as panel,
  assertStatusClosed as closed,
  assertStatusOpened as opened,
  closeStatusPanel as close,
  publishStatus as publish,
  sendStatusMessage as send,
  releaseStatusAck as release,
  statusOpenedCount as openedCount,
  type StatusBrowserScenario,
} from "./statusPanelSendAutoOpenActions.js";
import { STATUS_CREATED_ID as CREATED } from "./statusPanelSendAutoOpenData.js";

export const statusPanelLifecycleScenarios: StatusBrowserScenario[] = [
  {
    name: "ACK barrier 中手动打开再关闭废弃后到 ACK",
    content: "todo",
    async run(page) {
      await page.evaluate(() => window.__statusPanelSendTest.holdAck());
      const command = await send(page, undefined, false, false);
      await closed(page);
      await page.getByTestId(TID_CHAT_STATUS_ENTRY).click();
      await panel(page).waitFor({ state: "visible" });
      await close(page);
      await release(page, command!.commandId);
      await publish(page, "todo");
      await closed(page);
      assert.equal(await openedCount(page), 1, "后到 ACK 不能顶开手动关闭的面板");
    },
  },
  {
    name: "ACK barrier 中空面板 Git reset 废弃后到内容",
    content: "empty",
    async run(page) {
      await page.evaluate(() => window.__statusPanelSendTest.holdAck());
      const command = await send(page, undefined, false, false);
      await page.getByTestId("fixture-git-open").click();
      await release(page, command!.commandId);
      await publish(page, "todo");
      await closed(page);
      assert.equal(await page.getByTestId("fixture-git-panel").count(), 1);
      await send(page, "Synthetic after Git");
      await opened(page);
      assert.equal(
        await page.getByTestId("fixture-git-panel").count(),
        0,
        "自动打开仍走 shell 的原互斥通知",
      );
    },
  },
  {
    name: "草稿预热首发绑定到实际 session 后一次补弹",
    content: "empty",
    draft: true,
    async run(page) {
      await page.waitForFunction(() =>
        window.__statusPanelSendTest.audit.acks.some((ack) => ack.result?.type === "createSession"),
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-session-id="draft"]')
            ?.getAttribute("data-projection-seq") === "1",
      );
      await closed(page);
      const command = await send(page);
      assert.equal(command!.type, "sendText");
      assert.equal(command!.sessionId, CREATED);
      await page.waitForFunction(() => document.querySelector('[data-testid="chat-status-entry"]'));
      await closed(page);
      await publish(page, "todo", false, CREATED);
      await opened(page);
      assert.deepEqual(await page.evaluate(() => window.__statusPanelSendTest.audit.opened), [
        CREATED,
      ]);
    },
  },
  {
    name: "发送中切 session 再返回不复活旧 ticket",
    content: "todo",
    async run(page) {
      await page.evaluate(() => window.__statusPanelSendTest.holdAck());
      const command = await send(page, undefined, false, false);
      await page.evaluate(() =>
        window.__statusPanelSendTest.setScope({ sessionId: "fixture-other-session" }),
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-session-id="fixture-other-session"]')
            ?.getAttribute("data-projection-seq") === "1",
      );
      await release(page, command!.commandId);
      await closed(page);
      await page.evaluate(() =>
        window.__statusPanelSendTest.setScope({ sessionId: "fixture-status-send" }),
      );
      await publish(page, "todo");
      await closed(page);
      assert.equal(await openedCount(page), 0);
    },
  },
  {
    name: "同路径切 workspace identity attachment 拒绝旧 ACK",
    content: "todo",
    async run(page) {
      await page.evaluate(() => window.__statusPanelSendTest.holdAck());
      const command = await send(page, undefined, false, false);
      const workspaceIdentity = buildRemoteWorkspaceIdentity("/synthetic/status-send", {
        kind: "ssh",
        host: "fixture-b.invalid",
        username: "fixture",
      });
      await page.evaluate(
        (workspaceIdentity) =>
          window.__statusPanelSendTest.setScope({
            sessionId: "fixture-status-send",
            workspaceIdentity,
            remoteSessionId: "fixture-attachment-b",
          }),
        workspaceIdentity,
      );
      await release(page, command!.commandId);
      await publish(page, "todo");
      await closed(page);
      assert.equal(await openedCount(page), 0);
    },
  },
  {
    name: "失去 focused 或可见后旧发送不打开",
    content: "todo",
    async run(page) {
      await page.evaluate(() => window.__statusPanelSendTest.holdAck());
      const command = await send(page, undefined, false, false);
      await page.evaluate(() => window.__statusPanelSendTest.setVisibility(false, false));
      await release(page, command!.commandId);
      await page.evaluate(() => window.__statusPanelSendTest.setVisibility(true, true));
      await publish(page, "todo");
      await closed(page);
      assert.equal(await openedCount(page), 0);
    },
  },
  {
    name: "预热首发初始 snapshot 已有活动时对应分区仍展开",
    content: "all",
    draft: true,
    async run(page) {
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-session-id="draft"]')
            ?.getAttribute("data-projection-seq") === "1",
      );
      await closed(page);
      await send(page);
      await opened(page, ["goal", "plan", "terminal", "workflow", "agent"]);
      assert.deepEqual(await page.evaluate(() => window.__statusPanelSendTest.audit.opened), [
        CREATED,
      ]);
    },
  },
  {
    name: "无预热 createSession firstInput 首发绑定与初始活动展开",
    content: "all",
    draft: true,
    fallback: true,
    async run(page) {
      await page.waitForFunction(() =>
        window.__statusPanelSendTest.audit.acks.some(
          (ack) => ack.reasonCode === "fixture.noPrewarm",
        ),
      );
      const command = await send(page);
      assert.equal(command!.type, "createSession");
      assert.ok((command!.payload as { firstInput?: unknown }).firstInput);
      await opened(page, ["goal", "plan", "terminal", "workflow", "agent"]);
      assert.deepEqual(await page.evaluate(() => window.__statusPanelSendTest.audit.opened), [
        CREATED,
      ]);
    },
  },
  {
    name: "无预热 draft Goal 空创建绑定后消息 accepted 才打开",
    content: "all",
    draft: true,
    fallback: true,
    async run(page) {
      await page.waitForFunction(() =>
        window.__statusPanelSendTest.audit.acks.some(
          (ack) => ack.reasonCode === "fixture.noPrewarm",
        ),
      );
      await page.evaluate(() => {
        window.__statusPanelSendTest.allowDraftCreate();
        window.__statusPanelSendTest.holdAck();
      });
      const command = await send(page, "/goal Synthetic objective", false, false);
      assert.equal(command!.type, "sendGoalCommand");
      assert.equal(command!.sessionId, CREATED);
      await closed(page);
      await release(page, command!.commandId);
      await opened(page, ["goal", "plan", "terminal", "workflow", "agent"]);
      assert.deepEqual(await page.evaluate(() => window.__statusPanelSendTest.audit.opened), [
        CREATED,
      ]);
    },
  },
  {
    name: "ACK barrier 中单工作流徽标直达废弃自动打开",
    content: "workflow",
    async run(page) {
      await page.evaluate(() => window.__statusPanelSendTest.holdAck());
      const command = await send(page, undefined, false, false);
      await page.getByTestId("v4-composer-background-work-trigger").click();
      assert.deepEqual(await page.evaluate(() => window.__statusPanelSendTest.audit.navigation), [
        "fixture-sole-workflow",
      ]);
      await release(page, command!.commandId);
      await publish(page, "workflow");
      await closed(page);
      assert.equal(await openedCount(page), 0);
    },
  },
];
