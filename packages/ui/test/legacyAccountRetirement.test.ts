import assert from "node:assert/strict";
import test from "node:test";
import { DesktopCommandIds, type AppSettings } from "../../shared/src/index.js";
import {
  retireLegacyAccountState,
  retireLegacyAccountStateOnce,
  shouldRetireLegacyAccountState,
} from "../src/root/legacyAccountRetirement.js";

type LegacyAccountRetirementDeps = Parameters<typeof retireLegacyAccountStateOnce>[0];

interface RecordedCalls {
  logout: number;
  settingsUpdates: Partial<AppSettings>[];
  desktopCommands: string[];
}

function createDeps(params: {
  activeProvider: "zai" | "bigmodel" | null;
  providerFamilyDomain?: "zai" | "bigmodel" | "";
  logoutThrows?: boolean;
}): { deps: LegacyAccountRetirementDeps; calls: RecordedCalls } {
  const calls: RecordedCalls = { logout: 0, settingsUpdates: [], desktopCommands: [] };
  const deps = {
    services: {
      oauthService: {
        getActiveProvider: async () => params.activeProvider,
        logout: async () => {
          calls.logout += 1;
          if (params.logoutThrows) {
            throw new Error("logout failed");
          }
        },
      },
      settingService: {
        get: async () =>
          ({ providerFamilyDomain: params.providerFamilyDomain }) as unknown as AppSettings,
        update: async (patch: Partial<AppSettings>) => {
          calls.settingsUpdates.push(patch);
        },
      },
    },
    platform: {
      executeDesktopCommand: async (command: string) => {
        calls.desktopCommands.push(command);
        return undefined;
      },
    },
  } as unknown as LegacyAccountRetirementDeps;
  return { deps, calls };
}

test("无残留账号态时不触发清理", () => {
  assert.equal(
    shouldRetireLegacyAccountState({ activeOAuthProvider: null, providerFamilyDomain: "" }),
    false,
  );
  assert.equal(
    shouldRetireLegacyAccountState({
      activeOAuthProvider: null,
      providerFamilyDomain: undefined,
    }),
    false,
  );
  assert.equal(
    shouldRetireLegacyAccountState({ activeOAuthProvider: "zai", providerFamilyDomain: "" }),
    true,
  );
  assert.equal(
    shouldRetireLegacyAccountState({ activeOAuthProvider: null, providerFamilyDomain: "bigmodel" }),
    true,
  );
});

test("没有残留时 retireLegacyAccountState 不做任何写入", async () => {
  const { deps, calls } = createDeps({ activeProvider: null, providerFamilyDomain: "" });
  const outcome = await retireLegacyAccountState(deps);

  assert.deepEqual(outcome, {
    retired: false,
    activeProvider: null,
    hadProviderFamilyDomain: false,
  });
  assert.equal(calls.logout, 0);
  assert.deepEqual(calls.settingsUpdates, []);
  assert.deepEqual(calls.desktopCommands, []);
});

test("有残留凭据时清账号态并标记 provider family 迁移已完成", async () => {
  const { deps, calls } = createDeps({
    activeProvider: "bigmodel",
    providerFamilyDomain: "bigmodel",
  });
  const outcome = await retireLegacyAccountState(deps);

  assert.deepEqual(outcome, {
    retired: true,
    activeProvider: "bigmodel",
    hadProviderFamilyDomain: true,
  });
  assert.equal(calls.logout, 1);
  assert.equal(calls.settingsUpdates.length, 1);
  const patch = calls.settingsUpdates[0] ?? {};
  assert.equal(patch.providerFamilyDomain, "");
  assert.equal(typeof patch.providerFamilyDomainUpdatedAt, "number");
  // 关键：不写这一条，ensureProviderFamilyDomainMigration 会按残留 provider 把 domain 推断回来。
  assert.equal(patch.providerFamilyDomainMigrated, true);
  assert.deepEqual(calls.desktopCommands, [DesktopCommandIds.ClearCodingPlanWebviewStorage]);
});

test("只有残留 providerFamilyDomain 时同样清理", async () => {
  const { deps, calls } = createDeps({ activeProvider: null, providerFamilyDomain: "zai" });
  const outcome = await retireLegacyAccountState(deps);

  assert.equal(outcome.retired, true);
  assert.equal(outcome.hadProviderFamilyDomain, true);
  assert.equal(calls.logout, 1);
});

test("清理只执行一次：并发与重复调用共享同一次运行", async () => {
  const { deps, calls } = createDeps({
    activeProvider: "zai",
    providerFamilyDomain: "zai",
  });

  const [first, second] = await Promise.all([
    retireLegacyAccountStateOnce(deps),
    retireLegacyAccountStateOnce(deps),
  ]);
  const third = await retireLegacyAccountStateOnce(deps);

  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(calls.logout, 1);
  assert.equal(calls.settingsUpdates.length, 1);
});

test("清理失败不抛出，按未清理继续启动", async () => {
  const { deps, calls } = createDeps({
    activeProvider: "zai",
    providerFamilyDomain: "zai",
    logoutThrows: true,
  });
  const outcome = await retireLegacyAccountStateOnce(deps);

  assert.deepEqual(outcome, {
    retired: false,
    activeProvider: null,
    hadProviderFamilyDomain: false,
  });
  assert.equal(calls.logout, 1);
  assert.deepEqual(calls.settingsUpdates, []);
});
