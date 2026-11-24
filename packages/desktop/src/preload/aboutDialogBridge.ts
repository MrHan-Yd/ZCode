import { desktopAboutDialogPayloadSchema, type DesktopAboutDialogPayload } from "@zcode/shared";

export function createAboutDialogBridge() {
  const listeners = new Set<(payload: DesktopAboutDialogPayload) => void>();
  let pending: DesktopAboutDialogPayload | null = null;
  return {
    receive(value: unknown): void {
      const result = desktopAboutDialogPayloadSchema.safeParse(value);
      if (!result.success) return;
      if (listeners.size === 0) {
        pending = result.data;
        return;
      }
      for (const listener of listeners) listener(result.data);
    },
    subscribe(listener: (payload: DesktopAboutDialogPayload) => void): () => void {
      listeners.add(listener);
      if (pending) {
        const payload = pending;
        // 启动早到请求只消费一次，关闭后重订阅不能幽灵重开 About。
        pending = null;
        listener(payload);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
