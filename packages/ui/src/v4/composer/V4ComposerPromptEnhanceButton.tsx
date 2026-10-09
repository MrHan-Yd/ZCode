/**
 * Composer 的「增强提示词」入口。
 *
 * 纯入口件：草稿文本的事实源仍在 Lexical 编辑器，这里只负责发起一次一次性生成、
 * 把过程状态（pending / 取消）留在组件内，结果交给 onEnhanced 写回草稿。
 * 不用全局 store 存 pending，避免出现第二份「草稿是否正在被增强」的事实。
 *
 * 取消靠 requestId 而不是 AbortSignal：AbortSignal 过不了 @zcode/rpc 的序列化边界
 * （会被退化成 {}），服务端在途表的键必须是可序列化的 id。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { LoaderIcon, SparklesIcon } from "lucide-react";
import { TID_V4_COMPOSER_PROMPT_ENHANCE, createUuid, type ModelSelection } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { toast } from "@/components/ui/toast.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";

interface V4ComposerPromptEnhanceButtonProps {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  /** 当前草稿的模型选择；缺失或不可解析即视为「没有可直连的配置」。 */
  selection: ModelSelection | null | undefined;
  /**
   * 取当前草稿原文。刻意用取值函数而不是字符串 prop：调用点位于工具条的 memo 里，
   * 传字符串会让整个右下操作区跟着每次敲键重建。
   */
  readDraft: () => string;
  disabled?: boolean;
  onEnhanced: (text: string) => void;
}

type PromptEnhanceFailure = {
  reason: "empty-draft" | "model-unavailable" | "aborted" | "invalid-output" | "request-failed";
  detail?: string;
};

function V4ComposerPromptEnhanceButtonImpl({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  selection,
  readDraft,
  disabled,
  onEnhanced,
}: V4ComposerPromptEnhanceButtonProps) {
  const { intl } = useZCodeIntl();
  const services = useOptionalServices();
  const service = services?.promptEnhanceService;
  const [pending, setPending] = useState(false);
  /** 当前在途请求 id；服务端据此在途表定位要中断的那次生成。 */
  const requestIdRef = useRef<string | null>(null);
  // 取消与重入都靠版本号判定：只有仍属于当前这次运行的结果才允许写回草稿。
  const runIdRef = useRef(0);

  useEffect(
    () => () => {
      const requestId = requestIdRef.current;
      runIdRef.current += 1;
      requestIdRef.current = null;
      setPending(false);
      // 卸载/换服务时把在途请求交回服务端取消，避免已无人接收的生成继续跑完。
      if (requestId) {
        void service?.cancel(requestId).catch((error: unknown) => {
          // 组件已不在，取消失败也没有可展示的落点，只留诊断日志。
          logger.warn("[promptEnhance] 卸载时取消增强请求失败", { requestId, error });
        });
      }
    },
    [service],
  );

  const reportFailure = useCallback(
    (failure: PromptEnhanceFailure) => {
      const id =
        failure.reason === "model-unavailable"
          ? "chat.promptEnhance.unsupported"
          : failure.reason === "empty-draft"
            ? "chat.promptEnhance.empty"
            : failure.reason === "aborted"
              ? "chat.promptEnhance.cancelled"
              : failure.detail
                ? "chat.promptEnhance.errorWithDetail"
                : "chat.promptEnhance.error";
      toast(
        intl.formatMessage(
          { id },
          failure.reason === "request-failed" && failure.detail
            ? { error: failure.detail }
            : undefined,
        ),
        { variant: "warning" },
      );
    },
    [intl],
  );

  const handleClick = useCallback(() => {
    if (!service) return;

    if (pending) {
      // 再点一次取消：把 requestId 交给服务端在途表，由 host 真正中断本次生成
      // （workspace/cancelGenerateText）。本地立刻回到空闲并丢弃随后到达的结果。
      const requestId = requestIdRef.current;
      runIdRef.current += 1;
      requestIdRef.current = null;
      setPending(false);
      reportFailure({ reason: "aborted" });
      if (requestId) {
        // 取消是 best-effort 控制面操作：失败不回滚「本地已回到空闲」这个状态，
        // 服务端那次生成最坏情况就是跑完。
        void service.cancel(requestId).catch((error: unknown) => {
          logger.warn("[promptEnhance] 取消增强请求失败", { requestId, error });
        });
      }
      return;
    }

    const draft = readDraft().trim();
    if (!draft) {
      reportFailure({ reason: "empty-draft" });
      return;
    }
    if (!selection?.providerId?.trim() || !selection.modelId?.trim()) {
      reportFailure({ reason: "model-unavailable" });
      return;
    }

    const runId = (runIdRef.current += 1);
    const requestId = createUuid();
    requestIdRef.current = requestId;
    setPending(true);

    void service
      .enhance({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        ...(remoteSessionId ? { remoteSessionId } : {}),
        selection,
        text: draft,
        requestId,
      })
      .then((result) => {
        if (runId !== runIdRef.current) return;
        if (result.ok) {
          onEnhanced(result.text);
          return;
        }
        reportFailure(result);
      })
      .catch((error: unknown) => {
        if (runId !== runIdRef.current) return;
        reportFailure({
          reason: "request-failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (runId !== runIdRef.current) return;
        requestIdRef.current = null;
        setPending(false);
      });
  }, [
    onEnhanced,
    pending,
    readDraft,
    remoteSessionId,
    reportFailure,
    selection,
    service,
    workspaceIdentity,
    workspacePath,
  ]);

  // host 没提供这个服务（Web / 旧 host / 测试 double）时不渲染入口。
  if (!service) return null;

  const title = intl.formatMessage({
    id: pending ? "chat.promptEnhance.cancel" : "chat.promptEnhance.title",
  });

  return (
    <ControlHintTooltip
      title={title}
      description={intl.formatMessage({
        id: pending ? "chat.promptEnhance.cancelDescription" : "chat.promptEnhance.description",
      })}
    >
      <Button
        type="button"
        variant="ghost"
        size="icon-md"
        disabled={disabled}
        onClick={handleClick}
        data-testid={TID_V4_COMPOSER_PROMPT_ENHANCE}
        // e2e / 排障锚点：不暴露 pending 之外的状态，避免测试去反推图标类名。
        data-prompt-enhance-state={pending ? "pending" : "idle"}
        aria-label={title}
        // 刻意不带 data-composer-collapse-priority：折叠阶梯只收模型/思考档位，
        // 让增强入口跟着收起会让「有草稿就能增强」这个能力凭空消失。
        className="shrink-0"
      >
        {pending ? (
          <LoaderIcon className="size-4 animate-spin" aria-hidden />
        ) : (
          <SparklesIcon className="size-4" aria-hidden />
        )}
      </Button>
    </ControlHintTooltip>
  );
}

export const V4ComposerPromptEnhanceButton = memo(V4ComposerPromptEnhanceButtonImpl);
