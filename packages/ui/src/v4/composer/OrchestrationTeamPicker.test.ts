import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  TID_V4_ORCHESTRATION_TEAM_PICKER,
  TID_V4_ORCHESTRATION_TEAM_ROLE,
  testId,
  type Locale,
} from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { OrchestrationTeamPicker } from "./OrchestrationTeamPicker.js";
import {
  buildOrchestrationRoleViews,
  type OrchestrationRoleView,
} from "./orchestrationTeamModel.js";

const roles = buildOrchestrationRoleViews([]);

function renderPicker(
  locale: Locale,
  views: readonly OrchestrationRoleView[] = roles,
  team: readonly string[] = ["general-purpose", "tester"],
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(OrchestrationTeamPicker, {
        team,
        roles: views,
        onToggleRole: () => {},
        onToggleSelectAll: () => {},
        onApplyPreset: () => {},
        onOpenRoleSettings: () => {},
      }),
    }),
  );
}

function openingTag(html: string, id: string): string {
  const tag = html.match(/<[^>]+>/gu)?.find((value) => value.includes(`data-testid="${id}"`));
  assert.ok(tag, `missing ${id}`);
  return tag;
}

function classNames(tag: string): Set<string> {
  return new Set(tag.match(/class="([^"]*)"/u)?.[1]?.split(/\s+/u));
}

test("受限高度下只收缩角色列表，角色行保留内容高度", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderPicker(locale);
    const root = classNames(openingTag(html, TID_V4_ORCHESTRATION_TEAM_PICKER));
    for (const token of ["flex", "flex-1", "min-h-0", "overflow-hidden"]) {
      assert.ok(root.has(token), `picker must use ${token}`);
    }
    const listTag = html
      .match(/<div[^>]+>/gu)
      ?.find((tag) => classNames(tag).has("overflow-y-auto"));
    assert.ok(listTag, "role list must own vertical scrolling");
    const list = classNames(listTag);
    for (const token of ["flex-1", "min-h-0", "overflow-x-hidden"]) {
      assert.ok(list.has(token), `role list must use ${token}`);
    }
    assert.equal(roles.length, 6);
    for (const role of roles) {
      const row = classNames(openingTag(html, testId(TID_V4_ORCHESTRATION_TEAM_ROLE, role.name)));
      assert.ok(row.has("shrink-0"), `${role.name} must not compress below its text`);
    }
  }
});

test("勾选图标使用普通前景色，在明暗输入背景上可辨", () => {
  const html = renderPicker("zh-CN");
  const checkbox = html
    .match(/<button[^>]+>/gu)
    ?.find((tag) => tag.includes('role="checkbox"') && tag.includes('aria-label="tester"'));
  assert.ok(checkbox);
  const tokens = classNames(checkbox);
  assert.ok(tokens.has("text-foreground"));
  assert.equal(tokens.has("text-foreground-inverse"), false);
  assert.ok(checkbox.includes('aria-checked="true"'));
});

test("通用子代理不出现也不计数，专业团队提供独立全选", () => {
  const html = renderPicker("zh-CN");
  assert.equal(html.includes(testId(TID_V4_ORCHESTRATION_TEAM_ROLE, "general-purpose")), false);
  assert.equal(html.includes(testId(TID_V4_ORCHESTRATION_TEAM_ROLE, "Explore")), false);
  assert.ok(html.includes("1/6"));
  assert.ok(html.includes("全选"));
});

test("仅显示全栈和精简两个预设，图标不复用推荐或提示词增强", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderPicker(locale);
    const labels = locale === "zh-CN" ? ["全栈", "精简"] : ["Full stack", "Lean"];
    for (const label of labels) assert.ok(html.includes(`>${label}</button>`));
    assert.equal(
      html.includes(locale === "zh-CN" ? ">推荐</button>" : ">Recommended</button>"),
      false,
    );
    for (const icon of ["lucide-layers", "lucide-feather", "lucide-list-checks"]) {
      assert.ok(html.includes(icon), `missing ${icon}`);
    }
    assert.equal(html.includes("lucide-star"), false);
    assert.equal(html.includes("lucide-sparkles"), false);
  }
});

test("面板说明通用执行与检索默认可用，精简团队只勾选审阅", () => {
  const html = renderPicker("zh-CN", roles, ["general-purpose", "Explore", "reviewer"]);
  const description = html.match(/<p[^>]*>([^<]*)<\/p>/u)?.[1];
  assert.ok(description?.includes("通用执行与检索默认可用"));
  const selected = html
    .match(/<button[^>]+>/gu)
    ?.filter((tag) => tag.includes('role="checkbox"') && tag.includes('aria-checked="true"'));
  assert.equal(selected?.length, 1);
  assert.ok(selected?.[0]?.includes('aria-label="reviewer"'));
  assert.ok(html.includes("1/6"));
});

test("全部可选角色已选时，全选按钮切换为取消全选", () => {
  const all = ["general-purpose", "Explore", ...roles.map((role) => role.name)];
  const html = renderPicker("zh-CN", roles, all);
  assert.ok(html.includes("取消全选"));
  assert.ok(html.includes("lucide-list-x"));
  assert.equal(html.includes("lucide-list-checks"), false);
});

test("列表限高不移除角色描述、标签或模型信息", () => {
  const description = "Long role description with enough text to wrap across multiple lines.";
  const modelId = "provider/long-model-name-with-a-role-specific-override";
  const views = roles.map((role) =>
    role.name === "backend"
      ? { ...role, description, modelSelection: { providerId: "fixture-provider", modelId } }
      : role,
  );
  for (const locale of ["zh-CN", "en-US"] as const) {
    const html = renderPicker(locale, views);
    for (const role of roles) {
      openingTag(html, testId(TID_V4_ORCHESTRATION_TEAM_ROLE, role.name));
    }
    assert.ok(html.includes(description));
    assert.ok(html.includes(modelId));
    assert.ok(html.includes("TypeScript"));
    assert.ok(html.includes('aria-label="backend"'));
  }
});
