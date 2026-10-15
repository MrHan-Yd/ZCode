import assert from "node:assert/strict";
import test from "node:test";
import {
  createFileCodeViewerLineAnchor,
  isCodeViewerLineRangeVisible,
  resolveFileLineAnchorProjection,
} from "../src/lib/codeViewerLineAnchor.js";
import { resolveMarkdownFileLink } from "../src/lib/markdownFileLink.js";

// 行锚点依赖两件事：解析层能给出行号，以及定位触发条件不只由行号决定。
// 前者是渲染层的历史缺口（解析出来又被丢掉），后者是 tab 复用带来的重复点击问题。
const WORKSPACE_PATH = "D:/Project/Han/hzcloud-medical";

test("文件链接的三种行号写法都解析出行号，供打开时定位", () => {
  const absolute = resolveMarkdownFileLink(
    WORKSPACE_PATH,
    `${WORKSPACE_PATH}/hzcloud-scf-nbtp/src/main/java/com/hzcloud/scf/druid/common/crypto/GenericCryptoMacListener.java#L263`,
  );
  assert.equal(absolute?.lineNumber, 263);

  const relative = resolveMarkdownFileLink(WORKSPACE_PATH, "./GenericCryptoMacListener.java:158");
  assert.equal(relative?.lineNumber, 158);
  assert.equal(relative?.path, `${WORKSPACE_PATH}/GenericCryptoMacListener.java`);

  const withColumn = resolveMarkdownFileLink(
    WORKSPACE_PATH,
    "./GenericCryptoMacListener.java:86:12",
  );
  assert.equal(withColumn?.lineNumber, 86);
  assert.equal(withColumn?.columnNumber, 12);

  // 无行号的链接不能凭空锚点，否则会覆盖上一次定位意图。
  assert.equal(
    resolveMarkdownFileLink(WORKSPACE_PATH, "./GenericCryptoMacListener.java")?.lineNumber,
    null,
  );
});

test("每次点击生成新的 requestId，同一行重复点击也能重新定位", () => {
  const first = createFileCodeViewerLineAnchor(158);
  const second = createFileCodeViewerLineAnchor(158);

  assert.equal(first.lineNumber, 158);
  assert.equal(second.lineNumber, 158);
  // tab 按路径复用，行号相同时只能靠 requestId 触发 CodeViewer 的定位 effect。
  assert.notEqual(first.requestId, second.requestId);
});

test("行区间可见性按 1-based 行数判定，越界与非法输入都算不可见", () => {
  const content = ["line-1", "line-2", "line-3"].join("\n");

  assert.equal(isCodeViewerLineRangeVisible(content, 1, 1), true);
  assert.equal(isCodeViewerLineRangeVisible(content, 3, 3), true);
  assert.equal(isCodeViewerLineRangeVisible(content, 1, 3), true);
  // 越界：文件在消息发出后被改动，目标行可能已经不存在。
  assert.equal(isCodeViewerLineRangeVisible(content, 4, 4), false);
  assert.equal(isCodeViewerLineRangeVisible(content, 2, 4), false);
  // 结尾换行会 split 出空元素，末行仍须按实际行数判定。
  assert.equal(isCodeViewerLineRangeVisible(`${content}\n`, 3, 3), true);
  assert.equal(isCodeViewerLineRangeVisible("a\r\nb", 2, 2), true);

  assert.equal(isCodeViewerLineRangeVisible(content, 0, 0), false);
  assert.equal(isCodeViewerLineRangeVisible(content, -1, -1), false);
  assert.equal(isCodeViewerLineRangeVisible(content, 3, 2), false);
  assert.equal(isCodeViewerLineRangeVisible(content, undefined, undefined), false);
  assert.equal(isCodeViewerLineRangeVisible(content, 1.5, 1.5), false);
});

test("行锚点只产出定位区间，不产出评论", () => {
  const content = ["a", "b", "c"].join("\n");
  const visible = resolveFileLineAnchorProjection(createFileCodeViewerLineAnchor(2), content);
  assert.deepEqual(visible.focusedRange, { startLine: 2, endLine: 2 });
  assert.equal(visible.targetLineOutOfRange, false);

  const outOfRange = resolveFileLineAnchorProjection(createFileCodeViewerLineAnchor(9), content);
  assert.equal(outOfRange.focusedRange, null);
  assert.equal(outOfRange.targetLineOutOfRange, true);
});
