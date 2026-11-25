import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { TID_CHAT_STATUS_SECTIONS_PANEL, TID_V4_COMPOSER_SEND } from "@zcode/shared";
import { STATUS_SESSION_ID, type StatusContent } from "./statusPanelSendAutoOpenData.js";

export type StatusClientMode = "desktop-continuous" | "web-remote-replayable";
export interface StatusBrowserScenario {
  name: string;
  content: StatusContent;
  draft?: boolean;
  fallback?: boolean;
  strict?: boolean;
  run(page: Page, mode: StatusClientMode): Promise<void>;
}

export async function settleStatusPage(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
export const statusPanel = (page: Page) => page.getByTestId(TID_CHAT_STATUS_SECTIONS_PANEL);
export async function assertStatusClosed(page: Page): Promise<void> {
  await settleStatusPage(page);
  assert.equal(await statusPanel(page).count(), 0, "状态面板不得被旧发送或非消息操作打开");
}
export async function assertStatusOpened(page: Page, sections: string[] = ["plan"]): Promise<void> {
  await statusPanel(page).waitFor({ state: "visible" });
  for (const section of sections) {
    assert.equal(
      await statusPanel(page)
        .locator(`[data-status-section-trigger="${section}"]`)
        .getAttribute("aria-expanded"),
      "true",
      `${section} 未完成分区必须展开`,
    );
  }
}
export async function closeStatusPanel(page: Page): Promise<void> {
  await statusPanel(page)
    .getByRole("button", { name: /^(Close|关闭)$/u })
    .click();
  await assertStatusClosed(page);
}
export async function publishStatus(
  page: Page,
  content: StatusContent,
  gap = false,
  id = STATUS_SESSION_ID,
): Promise<void> {
  const seq = await page.evaluate(
    ({ content, gap, id }) => window.__statusPanelSendTest.publish(content, gap, id),
    { content, gap, id },
  );
  await page.waitForFunction(
    ({ id, seq }) =>
      document.querySelector(`[data-session-id="${id}"]`)?.getAttribute("data-projection-seq") ===
      String(seq),
    { id, seq },
  );
  await settleStatusPage(page);
}
export async function sendStatusMessage(
  page: Page,
  text = "Synthetic user message",
  button = false,
  waitAck = true,
) {
  const before = await page.evaluate(() => window.__statusPanelSendTest.audit.commands.length);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.fill(text);
  await page.waitForFunction(
    (id) =>
      !(document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null)?.disabled,
    TID_V4_COMPOSER_SEND,
  );
  if (button) await page.getByTestId(TID_V4_COMPOSER_SEND).click();
  else await editor.press("Enter");
  if (text === "/plan") {
    await settleStatusPage(page);
    return null;
  }
  await page.waitForFunction(
    (before) =>
      window.__statusPanelSendTest.audit.commands
        .slice(before)
        .some(
          (command) =>
            ["sendText", "sendGoalCommand", "compact"].includes(command.type) ||
            (command.type === "createSession" &&
              Boolean((command.payload as { firstInput?: unknown }).firstInput)),
        ),
    before,
  );
  const envelope = await page.evaluate(
    (before) =>
      window.__statusPanelSendTest.audit.commands
        .slice(before)
        .find(
          (command) =>
            ["sendText", "sendGoalCommand", "compact"].includes(command.type) ||
            (command.type === "createSession" &&
              Boolean((command.payload as { firstInput?: unknown }).firstInput)),
        )!,
    before,
  );
  assert.ok(envelope, "提交必须经过真实 SessionPane command admission");
  if (waitAck) {
    await page.waitForFunction(
      (id) => window.__statusPanelSendTest.audit.acks.some((ack) => ack.commandId === id),
      envelope.commandId,
    );
    await settleStatusPage(page);
  }
  return envelope;
}
export async function releaseStatusAck(page: Page, commandId: string): Promise<void> {
  await page.evaluate(() => window.__statusPanelSendTest.releaseAck());
  await page.waitForFunction(
    (id) => window.__statusPanelSendTest.audit.acks.some((ack) => ack.commandId === id),
    commandId,
  );
  await settleStatusPage(page);
}
export async function statusOpenedCount(page: Page): Promise<number> {
  return page.evaluate(() => window.__statusPanelSendTest.audit.opened.length);
}
