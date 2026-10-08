import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectMemoryFileSummary } from "@zcode/services";
import {
  PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE,
  PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE,
} from "@zcode/services";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { LoaderIcon } from "lucide-react";
import { MarkdownPreviewContent } from "@/previewPaneMarkdownContent.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

type MemoryFilePreviewState =
  | { status: "loading" }
  | { status: "ready"; content: string; updatedAt: number; fetchedAt: number }
  | { status: "limit-exceeded" }
  | { status: "changed" }
  | { status: "error"; message: string };

function readErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 记忆文件正文预览。正文由弹窗自己按需拉取，不进入目录状态：
 * 它只是一次读取结果，不属于目录事实（见 specs/memory-file-preview.md）。
 */
export function MemoryFilePreviewDialog({
  file,
  readFile,
  onFileChanged,
  onOpenChange,
}: {
  file: ProjectMemoryFileSummary | null;
  /** 由上层绑定当前选中的 workspaceId，弹窗不感知工作区选择。 */
  readFile: (fileName: string) => Promise<{ content: string; updatedAt: number }>;
  /** 文件在读取期间被改写时回调，用于刷新目录列表。 */
  onFileChanged: () => void;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const theme = useZCodeStore((state) => state.theme);
  const codePreviewSettings = useZCodeStore((state) => state.codePreviewSettings);
  const [state, setState] = useState<MemoryFilePreviewState>({ status: "loading" });
  // 用请求序号丢弃过期响应：用户可能连续点开不同文件，慢的那个不能覆盖新的。
  const requestIdRef = useRef(0);
  const fileName = file?.name ?? null;
  // 回调走 ref：拉取只应在文件名变化时发生。若把回调放进依赖，
  // 父级任何一次传入新函数（内联箭头）都会触发重复请求，甚至互相递归。
  const readFileRef = useRef(readFile);
  const onFileChangedRef = useRef(onFileChanged);
  useEffect(() => {
    readFileRef.current = readFile;
    onFileChangedRef.current = onFileChanged;
  });

  useEffect(() => {
    if (!fileName) {
      return;
    }

    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setState({ status: "loading" });

    void readFileRef.current(fileName).then(
      (result) => {
        if (requestIdRef.current !== requestId) {
          return;
        }
        setState({
          status: "ready",
          content: result.content,
          updatedAt: result.updatedAt,
          // 相对时间以这次读取时刻为基准，避免弹窗长期挂载后显示成"很久以前"。
          fetchedAt: Date.now(),
        });
      },
      (error: unknown) => {
        if (requestIdRef.current !== requestId) {
          return;
        }

        const code = readErrorCode(error);
        if (code === PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED_ERROR_CODE) {
          setState({ status: "limit-exceeded" });
          return;
        }
        if (code === PROJECT_MEMORY_FILE_CHANGED_ERROR_CODE) {
          setState({ status: "changed" });
          // 内容已被改写，目录里的 updatedAt/size 也已过期。
          onFileChangedRef.current();
          return;
        }
        setState({ status: "error", message: getErrorMessage(error) });
      },
    );
  }, [fileName]);

  const handleOpenExternalUrl = useCallback(
    (url: string) => {
      platform.openExternal(url);
    },
    [platform],
  );

  return (
    <Dialog open={Boolean(file)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-4rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0">
        <DialogHeader className="shrink-0 gap-1 border-b border-border/50 px-5 py-4">
          <DialogTitle className="truncate">{file?.name ?? ""}</DialogTitle>
          <DialogDescription>
            {state.status === "ready"
              ? formatMemoryUpdatedAt({
                  formatMessage: intl.formatMessage,
                  locale,
                  now: state.fetchedAt,
                  updatedAt: state.updatedAt,
                })
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {state.status === "loading" ? (
            <div className="flex h-full items-center justify-center text-foreground-subtle">
              <LoaderIcon className="size-5 animate-spin" />
            </div>
          ) : state.status === "ready" ? (
            <MarkdownPreviewContent
              content={state.content}
              sourceKey={file?.name}
              sourceTitle={file?.name}
              theme={theme}
              codePreviewSettings={codePreviewSettings}
              onOpenBrowserUrl={handleOpenExternalUrl}
            />
          ) : (
            <div className="p-5">
              <Alert>
                <AlertDescription>
                  {state.status === "limit-exceeded"
                    ? intl.formatMessage({ id: "settings.memory.preview.limitExceeded" })
                    : state.status === "changed"
                      ? intl.formatMessage({ id: "settings.memory.preview.changed" })
                      : intl.formatMessage(
                          { id: "settings.memory.preview.failed" },
                          { message: state.status === "error" ? state.message : "" },
                        )}
                </AlertDescription>
              </Alert>
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end border-t border-border/50 px-5 py-3">
          {file ? <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} /> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
