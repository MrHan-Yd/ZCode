import assert from "node:assert/strict";
import {
  statusPanel as panel,
  assertStatusClosed as closed,
  assertStatusOpened as opened,
  closeStatusPanel as close,
  publishStatus as publish,
  sendStatusMessage as send,
  statusOpenedCount as openedCount,
  type StatusBrowserScenario,
} from "./statusPanelSendAutoOpenActions.js";

export const statusPanelContentScenarios: StatusBrowserScenario[] = [
  ...[false, true].map(
    (button): StatusBrowserScenario => ({
      name: button ? "Todo 按钮发送共享 accepted 路径" : "Todo Enter accepted 自动展开且编辑器保焦",
      content: "todo",
      async run(page) {
        const pane = page.locator("[data-session-id]").first();
        const width = await pane.evaluate((node) => node.getBoundingClientRect().width);
        const command = await send(page, undefined, button);
        assert.equal(command!.type, "sendText");
        await opened(page);
        if (!button) {
          assert.equal(
            await page
              .locator('[contenteditable="true"]')
              .first()
              .evaluate(
                (node) => node === document.activeElement || node.contains(document.activeElement),
              ),
            true,
            "自动打开不得抢 Enter 后的编辑器焦点",
          );
        }
        assert.equal(
          await pane.evaluate((node) => node.getBoundingClientRect().width),
          width,
          "覆盖面板不能改变正文列宽",
        );
        await close(page);
        await publish(page, "todo");
        await publish(page, "todo");
        await closed(page);
        await send(page, "Synthetic next accepted", !button);
        await opened(page);
        assert.equal(await openedCount(page), 2, "每次 accepted 最多打开一次，下一次可重开");
      },
    }),
  ),
  {
    name: "全部完成及已结束目录不打开，随后新 Todo 补弹",
    content: "completed",
    async run(page) {
      await send(page);
      await closed(page);
      await publish(page, "ended");
      await closed(page);
      await publish(page, "todo");
      await opened(page);
      await publish(page, "completed");
      await opened(page);
      assert.equal(await openedCount(page), 1, "工作完成不自动关闭或重复打开");
    },
  },
  {
    name: "无内容 accepted 后延迟 Todo 一次补弹与用户折叠优先",
    content: "empty",
    async run(page) {
      await send(page);
      await closed(page);
      await publish(page, "todo");
      await opened(page);
      await panel(page).locator('[data-status-section-trigger="plan"]').click();
      await publish(page, "todo");
      assert.equal(
        await panel(page)
          .locator('[data-status-section-trigger="plan"]')
          .getAttribute("aria-expanded"),
        "false",
        "刷新不能强制展开用户折叠的进程",
      );
      await close(page);
      await publish(page, "todo");
      await closed(page);
      assert.equal(await openedCount(page), 1);
    },
  },
  ...(["agent", "waiting", "blocked"] as const).map(
    (content): StatusBrowserScenario => ({
      name: `延迟 ${content} 智能体投影展开`,
      content: "empty",
      async run(page) {
        await send(page);
        await closed(page);
        await publish(page, content);
        await opened(page, ["agent"]);
        await close(page);
        await publish(page, content);
        await closed(page);
        assert.equal(await openedCount(page), 1);
      },
    }),
  ),
  {
    name: "rejected failed confirmation 与纯控制不打开",
    content: "todo",
    async run(page) {
      for (const status of ["rejected", "failed", "confirmation"] as const) {
        await page.evaluate((status) => window.__statusPanelSendTest.rejectNext(status), status);
        await send(page);
        await closed(page);
        if (status === "confirmation") {
          await page.getByTestId("v4-paused-queue-send-dialog").waitFor({ state: "visible" });
          await page.keyboard.press("Escape");
        }
      }
      await send(page, "/compact");
      await closed(page);
      const before = await page.evaluate(() => window.__statusPanelSendTest.audit.commands.length);
      await send(page, "/plan");
      await closed(page);
      assert.equal(
        await page.evaluate(() => window.__statusPanelSendTest.audit.commands.length),
        before,
        "空 /plan 只编辑模式，不发送输入",
      );
      assert.equal(await openedCount(page), 0);
    },
  },
  {
    name: "所有未完成分区展开而非工作流详情直达",
    content: "all",
    async run(page) {
      await send(page);
      await opened(page, ["goal", "plan", "terminal", "workflow", "orchestration", "agent"]);
      await close(page);
      await publish(page, "all");
      await closed(page);
      assert.equal(await openedCount(page), 1);
    },
  },
  {
    name: "continuous 在线与手机漏帧 same-sub recovery 最多一次",
    content: "empty",
    async run(page, mode) {
      await publish(page, "todo", mode === "web-remote-replayable");
      await closed(page);
      await publish(page, "empty");
      await send(page);
      await closed(page);
      await publish(page, "todo", mode === "web-remote-replayable");
      await opened(page);
      await close(page);
      await publish(page, "todo", mode === "web-remote-replayable");
      await closed(page);
      assert.equal(await openedCount(page), 1, "恢复不能重放本地发送动作或产生第二次机会");
      const audit = await page.evaluate(() => window.__statusPanelSendTest.audit);
      assert.ok(audit.delivery.includes(mode === "web-remote-replayable" ? "recovery" : "online"));
      if (mode === "web-remote-replayable") {
        assert.ok(audit.recovery.length >= 3);
        assert.equal(new Set(audit.recovery).size, 1, "断档必须复用原 subscription");
      } else assert.equal(audit.recovery.length, 0);
    },
  },
  ...(["startNow", "enqueue", "guide"] as const).map(
    (mode): StatusBrowserScenario => ({
      name: `${mode} admission 同样一次自动打开`,
      content: "todo",
      async run(page) {
        await page.evaluate((mode) => window.__statusPanelSendTest.setRouting(mode), mode);
        const command = await send(page);
        assert.equal(command!.type, "sendText");
        const ack = await page.evaluate(
          (id) => window.__statusPanelSendTest.audit.acks.find((ack) => ack.commandId === id)!,
          command!.commandId,
        );
        assert.equal(ack.result?.type, "inputAccepted");
        if (ack.result?.type === "inputAccepted")
          assert.equal(ack.result.delivery, mode === "enqueue" ? "queue" : mode);
        await opened(page);
        await close(page);
        await publish(page, "todo");
        await closed(page);
      },
    }),
  ),
  {
    name: "StrictMode 重复 effect 不重复打开",
    content: "todo",
    strict: true,
    async run(page) {
      await send(page);
      await opened(page);
      await close(page);
      await publish(page, "todo");
      await closed(page);
      assert.equal(await openedCount(page), 1);
    },
  },
];
