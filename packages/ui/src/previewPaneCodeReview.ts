import type { CodeCommentPreview, CodeCommentRange } from "@/lib/codeCommentContext.js";
import type { CodeReviewCodeViewerSource } from "@/lib/codeViewer.js";
import { isCodeViewerLineRangeVisible } from "@/lib/codeViewerLineAnchor.js";

interface CodeReviewContentProjection {
  focusedRange: CodeCommentRange | null;
  inlineComments: readonly CodeCommentPreview[];
  targetLineOutOfRange: boolean;
  topComment: CodeCommentPreview | null;
}

export function resolveCodeReviewContentProjection(
  source: CodeReviewCodeViewerSource,
  content: string,
): CodeReviewContentProjection {
  const { review } = source;
  const startLine = review.startLine;
  const endLine = review.endLine ?? startLine;
  const hasRange =
    Number.isInteger(startLine) &&
    Number.isInteger(endLine) &&
    startLine !== undefined &&
    endLine !== undefined &&
    startLine > 0 &&
    endLine >= startLine;
  // 行区间是否可见与文件链接的行锚点共用同一判定，避免两处各写一遍行数比较。
  const rangeIsVisible = hasRange && isCodeViewerLineRangeVisible(content, startLine, endLine);
  const comment: CodeCommentPreview = {
    id: review.requestId,
    sourcePath: source.path,
    sourceTitle: source.title,
    startLine: hasRange ? startLine : 1,
    endLine: hasRange ? endLine : 1,
    selectedText: "",
    comment: review.body,
  };

  return {
    focusedRange: rangeIsVisible ? { startLine, endLine } : null,
    inlineComments: rangeIsVisible ? [comment] : [],
    targetLineOutOfRange: hasRange && !rangeIsVisible,
    topComment: rangeIsVisible ? null : comment,
  };
}
