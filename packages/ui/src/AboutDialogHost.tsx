import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { DesktopAboutDialogPayload, IPlatformService } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function AboutDialogContent({
  payload,
  onClose,
}: {
  payload: DesktopAboutDialogPayload;
  onClose: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <>
      <DialogTitle className="sr-only">
        {intl.formatMessage({ id: "desktop.about.title" })}
      </DialogTitle>
      <div className="flex min-w-0 flex-col items-center gap-4 text-center">
        <ZCodeAboutLogo className="size-12 text-foreground" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-ui-base font-medium text-foreground">
            {intl.formatMessage({ id: "desktop.about.applicationName" })}
          </p>
          <DialogDescription asChild className="text-ui-sm text-foreground-subtle">
            <div className="flex flex-col gap-1 wrap-anywhere">
              <p>
                {intl.formatMessage(
                  { id: "desktop.about.version" },
                  { version: payload.appVersion },
                )}
              </p>
              <p>
                {intl.formatMessage(
                  { id: "desktop.about.copyright" },
                  { year: new Date().getFullYear() },
                )}
              </p>
              {payload.optimizedForAppleSilicon ? (
                <p>{intl.formatMessage({ id: "desktop.about.optimizedForAppleSilicon" })}</p>
              ) : null}
            </div>
          </DialogDescription>
        </div>
        <Button
          type="button"
          autoFocus
          data-testid="desktop-about-ok"
          className="w-full rounded-lg"
          onClick={onClose}
        >
          {intl.formatMessage({ id: "desktop.about.ok" })}
        </Button>
      </div>
    </>
  );
}

function activeFocusTarget(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const target = document.activeElement;
  return target instanceof HTMLElement &&
    target !== document.body &&
    target !== document.documentElement
    ? target
    : null;
}

function isValidFocusTarget(target: HTMLElement | null): target is HTMLElement {
  return Boolean(
    target?.isConnected &&
    !target.hidden &&
    !target.inert &&
    !target.hasAttribute("disabled") &&
    target.getAttribute("aria-disabled") !== "true" &&
    target.getClientRects().length > 0,
  );
}

export function AboutDialogHost({
  platform,
}: {
  platform: Pick<IPlatformService, "onOpenAboutDialog">;
}) {
  const [dialog, setDialog] = useState<{
    open: boolean;
    payload: DesktopAboutDialogPayload | null;
  }>({ open: false, payload: null });
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  const ensureOpen = useEffectEvent((payload: DesktopAboutDialogPayload) => {
    if (!dialog.open) {
      const target = activeFocusTarget();
      if (target && !contentRef.current?.contains(target)) {
        previousFocusRef.current = target;
      }
    }
    setDialog({ open: true, payload });
  });

  useEffect(() => platform.onOpenAboutDialog?.(ensureOpen), [platform]);

  // 白闪修复只移除原生透明模态窗边界；同文档 Dialog 关闭仅改 open，保留 payload 供退出动画使用。
  const setOpen = (open: boolean) => {
    setDialog((current) => (current.open === open ? current : { ...current, open }));
  };

  return (
    <Dialog open={dialog.open} onOpenChange={setOpen}>
      {dialog.payload ? (
        <DialogContent
          ref={contentRef}
          data-testid="desktop-about-dialog"
          showCloseButton={false}
          className="w-72 max-w-[calc(100vw-2rem-2*max(env(safe-area-inset-left),env(safe-area-inset-right)))] max-h-[calc(100dvh-2rem-2*max(env(safe-area-inset-top),env(safe-area-inset-bottom)))] overflow-y-auto rounded-2xl p-5"
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={() => {
            if (isValidFocusTarget(previousFocusRef.current)) return;
            const target = activeFocusTarget();
            if (target && !contentRef.current?.contains(target)) {
              previousFocusRef.current = target;
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (dialog.open) return;
            const target = previousFocusRef.current;
            previousFocusRef.current = null;
            if (isValidFocusTarget(target)) target.focus({ preventScroll: true });
          }}
          onKeyDown={(event) => {
            if (
              event.key !== "Enter" ||
              event.defaultPrevented ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              return;
            }
            event.preventDefault();
            setOpen(false);
          }}
        >
          <AboutDialogContent payload={dialog.payload} onClose={() => setOpen(false)} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
