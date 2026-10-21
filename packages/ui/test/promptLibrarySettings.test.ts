import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  TID_SETTINGS_PROMPT_LIBRARY_CONFIG_DOWNLOAD,
  TID_SETTINGS_PROMPT_LIBRARY_CONFIG_RESTORE,
  TID_SETTINGS_PROMPT_LIBRARY_CONFIG_UPLOAD,
  TID_SETTINGS_PROMPT_LIBRARY_DELETE,
  TID_SETTINGS_PROMPT_LIBRARY_SYNC_STATUS,
} from "@zcode/shared";
import { consumeInitialSettingsSection } from "../src/lib/settingsNavigation.js";
import { SETTINGS_SECTIONS, createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

// 仓库没有 jsdom / Testing Library，下面部分断言只能读取源码做静态检查。
// 它们用于补足“删除按钮事件隔离”和“同步入口能力检测”这类渲染层空白，
// 不是行为测试；行为验证仍需要桌面端手工或未来的 E2E 环境。
const SECTION_SOURCE = readFileSync(
  new URL("../src/settings/PromptLibrarySection.tsx", import.meta.url),
  "utf8",
);

function sliceFromTo(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `源码中未找到起始标记：${startMarker}`);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(end, -1, `源码中未找到结束标记：${endMarker}`);
  return source.slice(start, end + endMarker.length);
}

function extractUseCallbackBlock(source: string, name: string): string {
  const start = source.indexOf(`const ${name} = useCallback(`);
  assert.notEqual(start, -1, `源码中未找到 useCallback：${name}`);
  const end = source.indexOf("\n  );", start);
  assert.notEqual(end, -1, `源码中未找到 useCallback 结束：${name}`);
  return source.slice(start, end);
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ");
}

function createStorage(entries: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(entries));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}

function withFakeWindow<T>(sessionStorage: Storage, run: () => T): T {
  const globalObject = globalThis as unknown as { window?: Window };
  const previousWindow = globalObject.window;
  globalObject.window = {
    sessionStorage,
    localStorage: createStorage(),
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window;
  try {
    return run();
  } finally {
    if (previousWindow === undefined) {
      delete globalObject.window;
    } else {
      globalObject.window = previousWindow;
    }
  }
}

test("settingsPageConfig 注册 promptLibrary：Agent 能力分组、紧跟 commands", () => {
  const config = createSettingsPageConfig();
  const promptLibrary = config.settingsSections.find((section) => section.id === "promptLibrary");

  assert.ok(promptLibrary, "settingsPageConfig 缺少 promptLibrary 分区");
  assert.equal(promptLibrary.groupId, "agentCapabilities");
  assert.equal(promptLibrary.titleId, "settings.promptLibrary.title");

  // 兼容旧消费者的静态列表也必须包含它。
  assert.ok(SETTINGS_SECTIONS.some((section) => section.id === "promptLibrary"));

  const agentCapabilities = config.settingsSectionGroups.find(
    (group) => group.id === "agentCapabilities",
  );
  assert.ok(agentCapabilities, "缺少 agentCapabilities 分组");
  const sectionIds = agentCapabilities.sections.map((section) => section.id);
  const commandsIndex = sectionIds.indexOf("commands");
  const promptLibraryIndex = sectionIds.indexOf("promptLibrary");
  assert.ok(commandsIndex >= 0, "agentCapabilities 分组缺少 commands");
  assert.equal(promptLibraryIndex, commandsIndex + 1, "promptLibrary 必须紧跟在 commands 之后");
});

test('isSettingsSectionId("promptLibrary") 为 true（通过公开导航入口验证）', () => {
  // isSettingsSectionId 未导出；用 consumeInitialSettingsSection 的完整解析链路验证：
  // sessionStorage 里的 pending intent 只有被 isSettingsSectionId 接受才会返回该分区，
  // 否则会回退到 fallback。
  const sessionStorage = createStorage({
    "zcode-settings-section-intent": "promptLibrary",
  });

  withFakeWindow(sessionStorage, () => {
    assert.equal(consumeInitialSettingsSection("general"), "promptLibrary");
  });
});

test("未知 section id 不被 isSettingsSectionId 接受，回退 fallback", () => {
  const sessionStorage = createStorage({
    "zcode-settings-section-intent": "definitely-not-a-section",
  });

  withFakeWindow(sessionStorage, () => {
    assert.equal(consumeInitialSettingsSection("general"), "general");
  });
});

test("§14.1 列表删除 / 同步 test id 从 @zcode/shared 导出且唯一非空", () => {
  const testIds = [
    TID_SETTINGS_PROMPT_LIBRARY_DELETE,
    TID_SETTINGS_PROMPT_LIBRARY_CONFIG_UPLOAD,
    TID_SETTINGS_PROMPT_LIBRARY_CONFIG_DOWNLOAD,
    TID_SETTINGS_PROMPT_LIBRARY_CONFIG_RESTORE,
    TID_SETTINGS_PROMPT_LIBRARY_SYNC_STATUS,
  ];

  assert.equal(new Set(testIds).size, testIds.length, "prompt library test id 不能重复");
  for (const testId of testIds) {
    assert.equal(typeof testId, "string");
    assert.ok(testId.trim().length > 0, "test id 不能为空");
    assert.ok(testId.startsWith("settings-prompt-library"), `test id 前缀不符：${testId}`);
  }
});

test("静态检查：行内删除按钮在 click / keyboard / mousedown 都隔离行点击", () => {
  const deleteButton = sliceFromTo(
    SECTION_SOURCE,
    'aria-label={intl.formatMessage({ id: "settings.promptLibrary.delete" })}',
    "</Button>",
  );

  assert.match(
    deleteButton,
    /data-testid=\{testId\(TID_SETTINGS_PROMPT_LIBRARY_DELETE, item\.id\)\}/,
  );
  assert.match(deleteButton, /disabled=\{readOnly \|\| !service\}/);
  assert.match(deleteButton, /onClick=\{\(event\) => \{/);
  assert.match(deleteButton, /onKeyDown=\{\(event\) => \{/);
  assert.match(deleteButton, /onMouseDown=\{\(event\) => \{/);
  assert.match(deleteButton, /\{item\.pinned|Trash2|settings\.promptLibrary\.delete/);

  // 三个事件处理器都必须调用 stopPropagation，避免冒泡到行的 onClick 进入编辑视图。
  assert.equal(
    (deleteButton.match(/event\.stopPropagation\(\);/g) ?? []).length,
    3,
    "click / Enter-Space / mousedown 三处都必须 stopPropagation",
  );
});

test("静态检查：行内删除走 useConfirmDialog + removePrompt，默认焦点在取消", () => {
  assert.match(SECTION_SOURCE, /const confirmDialog = useConfirmDialog\(\);/);

  const deleteRowBlock = extractUseCallbackBlock(SECTION_SOURCE, "handleDeleteRow");
  assert.match(deleteRowBlock, /confirmDialog\(\{/);
  assert.match(deleteRowBlock, /defaultFocus: "cancel"/);
  assert.match(deleteRowBlock, /library\.removePrompt\(item\.id\)/);
  assert.match(deleteRowBlock, /settings\.promptLibrary\.toast\.deleted/);
  // readOnly 或服务缺失时不能执行删除。
  assert.match(deleteRowBlock, /if \(readOnly \|\| !service\)/);
});

test("静态检查：同步入口使用 SettingsResourceHeaderActions 并在 readOnly 时禁用", () => {
  const headerActions = collapseWhitespace(
    sliceFromTo(SECTION_SOURCE, "<SettingsResourceHeaderActions", "/>"),
  );

  assert.match(headerActions, /onUploadToGithub=\{\(\) => void handleSyncUpload\(\)\}/);
  assert.match(headerActions, /onDownloadFromGithub=\{\(\) => void handleSyncPreview\(\)\}/);
  assert.match(headerActions, /onRestoreFromBackup=\{\(\) => void handleSyncRestoreOpen\(\)\}/);
  assert.match(headerActions, /uploadToGithubDisabled=\{readOnly \|\| syncBusy\}/);
  assert.match(headerActions, /downloadFromGithubDisabled=\{readOnly \|\| syncBusy\}/);
  assert.match(headerActions, /restoreFromBackupDisabled=\{ readOnly \|\| syncBusy/);
  assert.match(headerActions, /uploadToGithubTestId=\{TID_SETTINGS_PROMPT_LIBRARY_CONFIG_UPLOAD\}/);
  assert.match(
    headerActions,
    /downloadFromGithubTestId=\{TID_SETTINGS_PROMPT_LIBRARY_CONFIG_DOWNLOAD\}/,
  );
  assert.match(
    headerActions,
    /restoreFromBackupTestId=\{TID_SETTINGS_PROMPT_LIBRARY_CONFIG_RESTORE\}/,
  );

  const statusRow = collapseWhitespace(sliceFromTo(SECTION_SOURCE, "<ConfigSyncStatusRow", "/>"));
  assert.match(statusRow, /testId=\{TID_SETTINGS_PROMPT_LIBRARY_SYNC_STATUS\}/);
  assert.match(statusRow, /busy=\{syncBusy\}/);

  assert.match(SECTION_SOURCE, /\{syncSupported \? \(\s*<SettingsResourceHeaderActions/);
  assert.match(SECTION_SOURCE, /\{syncSupported && readOnly \? \(/);
});

test("静态检查：同步能力用 typeof === function 检测（可选契约）", () => {
  const requiredMethods = [
    "getSyncStatus",
    "uploadToGithub",
    "previewDownload",
    "applyDownload",
    "listSyncBackups",
    "restoreSyncBackup",
  ];

  assert.match(SECTION_SOURCE, /const syncSupported = Boolean\(/);
  for (const method of requiredMethods) {
    assert.match(
      SECTION_SOURCE,
      new RegExp(`typeof syncService\\.${method} === "function"`),
      `syncSupported 缺少对 ${method} 的能力检测`,
    );
  }
});
