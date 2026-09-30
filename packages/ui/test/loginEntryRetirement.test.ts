import assert from "node:assert/strict";
import test from "node:test";
import type { UserInfo } from "../../shared/src/oauth.js";
import * as rootStartupGate from "../src/lib/rootStartupGate.js";
import { createQuickPickCommands } from "../src/quickpick/quickPickCommands.js";
import { applyCachedOAuthSessionRestoreResult } from "../src/root/oauthCachedSessionRestore.js";
import enUS from "../src/i18n/locales/en-US.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

const quickPickBase = {
  allowOpenWorkspace: true,
  canOpenCommunity: true,
  isSidebarVisible: true,
  themeTarget: "light" as const,
  shortcuts: { newTask: "", openWorkspace: "", toggleSidebar: "", toggleTerminal: "" },
  handlers: {
    createTask: () => {},
    openWorkspace: () => {},
    openSettings: () => {},
    openSkillsSettings: () => {},
    openMcpSettings: () => {},
    switchTheme: () => {},
    openFeedback: () => {},
    openCommunity: () => {},
    openProductDocs: () => {},
    toggleSidebar: () => {},
    toggleTerminal: () => {},
    togglePreview: () => {},
    openTerminalTab: () => {},
    openBrowserTab: () => {},
    openReviewTab: () => {},
  },
};

test("启动门禁不再暴露 provider 登录入口开关", () => {
  assert.equal("shouldEnableProviderAvailabilityLoginEntryGuard" in rootStartupGate, false);
  assert.equal("shouldResolveProviderStartupState" in rootStartupGate, false);
  // 门禁下线不能连带删掉启动 loading 依赖的判定。
  assert.equal("isProviderStartupSyncPending" in rootStartupGate, true);
  assert.equal(
    rootStartupGate.isProviderStartupSyncPending({
      providerFamilyDomainMigrationComplete: true,
      modelSelectionViewHydrated: true,
    }),
    false,
  );
});

test("未登录时命令面板不再提供登录入口，登出项保留", () => {
  const signedOut = createQuickPickCommands({ ...quickPickBase, isLoggedIn: false });
  assert.equal(
    signedOut.some((command) => command.id === "login"),
    false,
  );
  assert.equal(
    signedOut.some((command) => command.titleId === "quickPick.command.login"),
    false,
  );

  const signedIn = createQuickPickCommands({
    ...quickPickBase,
    isLoggedIn: true,
    handlers: { ...quickPickBase.handlers, logout: () => {} },
  });
  assert.equal(
    signedIn.some((command) => command.id === "logout"),
    true,
  );
});

test("登录入口文案随入口一并下线", () => {
  assert.equal("quickPick.command.login" in zhCN, false);
  assert.equal("quickPick.command.login" in enUS, false);
  assert.equal("quickPick.command.logout" in zhCN, true);
  assert.equal("quickPick.command.logout" in enUS, true);
});

test("会话失效只清登录态并告知，不再触发重新登录", async () => {
  let user: UserInfo | null = { id: "u1", username: "demo", displayName: "Demo" };
  const alerts: string[] = [];
  const restored = await applyCachedOAuthSessionRestoreResult({
    result: { status: "reauthentication-required", reason: "jwt-expired" },
    setUser: (next) => {
      user = next;
    },
    requestAlert: async (request) => {
      alerts.push(request.title);
      return true;
    },
    copy: { title: "expired", actionLabel: "OK" },
  });

  assert.equal(restored, false);
  assert.equal(user, null);
  assert.deepEqual(alerts, ["expired"]);
});
