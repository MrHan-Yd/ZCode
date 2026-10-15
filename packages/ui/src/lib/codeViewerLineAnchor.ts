import type { CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { FileCodeViewerLineAnchor } from "@/lib/codeViewer.js";

let navigationSequence = 0;

/**
 * 行锚点的 requestId 必须每次点击都不同：code viewer tab 按路径复用
 * （`getCodeViewerTabSourceKey` 不含行号），若 requestId 只由行号派生，
 * 用户滚动离开后再次点击同一行时 `CodeViewer` 的定位 effect 依赖没有变化，
 * 就不会回到目标行。计数只在进程内递增，无需持久化或跨 Host 协同。
 */
export function createFileCodeViewerLineAnchor(lineNumber: number): FileCodeViewerLineAnchor {
  navigationSequence += 1;
  return { lineNumber, requestId: `file-line-anchor:${navigationSequence}` };
}

/**
 * 行区间是否落在当前内容里。代码预览的行号是 1-based，且 `split` 对以换行结尾的
 * 内容会多出一个空元素，所以这里用「末行号不超过行数」判定，与 `CodeViewer`
 * 渲染出的行数一致。文件在消息发出后被改动时目标行可能已经越界。
 */
export function isCodeViewerLineRangeVisible(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): boolean {
  const resolvedEndLine = endLine ?? startLine;
  if (startLine === undefined || resolvedEndLine === undefined) {
    return false;
  }
  if (!Number.isInteger(startLine) || !Number.isInteger(resolvedEndLine)) {
    return false;
  }
  if (startLine <= 0 || resolvedEndLine < startLine) {
    return false;
  }

  return resolvedEndLine <= content.split(/\r\n|\r|\n/).length;
}

/**
 * 单行锚点投影成 `CodeViewer` 的 `focusedRange`。行锚点不携带评论，
 * 因此不复用 `resolveCodeReviewContentProjection`（后者会顺带造出评论卡片）。
 */
export function resolveFileLineAnchorProjection(
  anchor: FileCodeViewerLineAnchor,
  content: string,
): { focusedRange: CodeCommentRange | null; targetLineOutOfRange: boolean } {
  const isVisible = isCodeViewerLineRangeVisible(content, anchor.lineNumber, anchor.lineNumber);
  return {
    focusedRange: isVisible ? { startLine: anchor.lineNumber, endLine: anchor.lineNumber } : null,
    targetLineOutOfRange: !isVisible,
  };
}
