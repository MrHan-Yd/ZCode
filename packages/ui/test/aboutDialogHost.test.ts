import assert from "node:assert/strict";
import test from "node:test";
import { createElement, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesktopAboutDialogPayload, Locale } from "@zcode/shared";
import { AboutDialogContent, AboutDialogHost } from "@/AboutDialogHost.js";
import { Dialog } from "@/components/ui/dialog.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";

const MESSAGES: Record<Locale, Record<string, string>> = { "en-US": enUS, "zh-CN": zhCN };
const PAYLOAD: DesktopAboutDialogPayload = {
  appVersion: "9.8.7-about-fixture",
  optimizedForAppleSilicon: false,
};

function messageMarkup(
  locale: Locale,
  id: string,
  values: Record<string, string | number> = {},
): string {
  let message = MESSAGES[locale][id];
  assert.ok(message && message !== id, `missing translation: ${locale} ${id}`);
  for (const [key, value] of Object.entries(values)) {
    message = message.replaceAll(`{${key}}`, String(value));
  }
  return renderToStaticMarkup(createElement(Fragment, null, message));
}

function renderContent(locale: Locale, payload = PAYLOAD): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(
        Dialog,
        { open: true },
        createElement(AboutDialogContent, { payload, onClose: () => {} }),
      ),
    }),
  );
}

for (const locale of ["zh-CN", "en-US"] as const) {
  test(`${locale} About 展示保留品牌、真实版本、年份与唯一确定按钮，不依赖业务服务`, () => {
    const html = renderContent(locale);
    for (const [id, values] of [
      ["desktop.about.title", {}],
      ["desktop.about.applicationName", {}],
      ["desktop.about.version", { version: PAYLOAD.appVersion }],
      ["desktop.about.copyright", { year: new Date().getFullYear() }],
      ["desktop.about.ok", {}],
    ] as const) {
      assert.ok(html.includes(messageMarkup(locale, id, values)), id);
    }
    assert.equal((html.match(/<svg\b/gu) ?? []).length, 1);
    assert.match(html, /viewBox="0 0 256 218"/u);
    assert.match(html, /class="[^"]*\bsize-12\b[^"]*"/u);
    assert.match(html, /aria-hidden="true"/u);
    assert.equal((html.match(/<button\b/gu) ?? []).length, 1);
    assert.match(html, /data-testid="desktop-about-ok"/u);
    assert.match(html, /autofocus=""/u);
    assert.match(html, /class="[^"]*\brounded-lg\b[^"]*"/u);
    assert.match(html, /\btext-ui-base\b/u);
    assert.match(html, /\btext-ui-sm\b/u);
    assert.doesNotMatch(html, /rounded-full|text-\[|font-size|style="/u);
    assert.doesNotMatch(html, /data-slot="dialog-close"/u);
    assert.doesNotMatch(html, /desktop\.about\./u);
    assert.ok(!html.includes(messageMarkup(locale, "desktop.about.optimizedForAppleSilicon")));
  });

  test(`${locale} Apple Silicon 文案仅跟随 main 提供的展示条件`, () => {
    const html = renderContent(locale, { ...PAYLOAD, optimizedForAppleSilicon: true });
    const optimizedText = messageMarkup(locale, "desktop.about.optimizedForAppleSilicon");
    assert.ok(html.includes(optimizedText));
    assert.equal(html.split(optimizedText).length - 1, 1);
    assert.ok(html.includes(PAYLOAD.appVersion));
  });
}

test("About 版本作为文本渲染，不执行 payload 中的 HTML", () => {
  const payload = { ...PAYLOAD, appVersion: "9.8.7 <script>about-fixture</script>" };
  const html = renderContent("en-US", payload);
  assert.ok(
    html.includes(messageMarkup("en-US", "desktop.about.version", { version: payload.appVersion })),
  );
  assert.match(html, /&lt;script&gt;about-fixture&lt;\/script&gt;/u);
  assert.doesNotMatch(html, /<script\b/u);
});

test("没有 platform About 订阅能力时 host 默认不展示，不在渲染期建立订阅", () => {
  const platform = {
    onOpenAboutDialog() {
      assert.fail("SSR must not subscribe to platform events");
    },
  };
  for (const candidate of [{}, platform]) {
    const html = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: "zh-CN",
        children: createElement(AboutDialogHost, { platform: candidate }),
      }),
    );
    assert.equal(html, "");
  }
});
