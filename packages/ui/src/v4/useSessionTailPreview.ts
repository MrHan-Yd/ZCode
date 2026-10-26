import { useEffect, useState } from "react";
import type {
  V4ConversationTailPreviewParams,
  V4ConversationTailPreviewResult,
} from "@zcode/shared/zcode-protocol-v4";
import { hasTailPreviewContent } from "@/lib/sessionTailPreview.js";
import { logger } from "@/logger.js";

/**
 * 冷开 connecting 期间的只读尾部预览。
 *
 * 预览是可选增强：请求失败、旧 CLI 不支持、返回空列表时一律返回 null，由调用方回退骨架。
 * 权威 snapshot 到达后 `enabled` 变 false，迟到的结果也会被忽略（cleanup 里的 disposed）。
 */
export function useSessionTailPreview(input: {
  enabled: boolean;
  request:
    | ((params: V4ConversationTailPreviewParams) => Promise<V4ConversationTailPreviewResult | null>)
    | undefined;
  sessionId: string | null;
}): V4ConversationTailPreviewResult | null {
  const { enabled, request, sessionId } = input;
  const [preview, setPreview] = useState<V4ConversationTailPreviewResult | null>(null);

  useEffect(() => {
    setPreview(null);
    if (!enabled || !sessionId || !request) return;
    let disposed = false;
    void request({ sessionId }).then(
      (result) => {
        if (disposed) return;
        setPreview(hasTailPreviewContent(result) ? result : null);
      },
      (error: unknown) => {
        if (disposed) return;
        // 预览失败是降级路径（骨架仍在），只留 debug，不打扰用户。
        logger.debug("[v4-pane] 尾部预览读取失败", {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      },
    );
    return () => {
      disposed = true;
    };
  }, [enabled, request, sessionId]);

  return enabled ? preview : null;
}
