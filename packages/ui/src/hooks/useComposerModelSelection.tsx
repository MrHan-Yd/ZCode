import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  composerModelSelectionScopeKey,
  createComposerModelSelectionPort,
  type ComposerModelSelectionPort,
  type ComposerModelSelectionReader,
  type ComposerModelSelectionScope,
} from "@/v4/composer/composerModelSelectionPort.js";

const ComposerModelSelectionContext = createContext<ComposerModelSelectionPort | null>(null);

export function ComposerModelSelectionProvider({ children }: { children: ReactNode }) {
  const [port] = useState(createComposerModelSelectionPort);
  return (
    <ComposerModelSelectionContext.Provider value={port}>
      {children}
    </ComposerModelSelectionContext.Provider>
  );
}

export function useRegisterComposerModelSelection(
  scope: ComposerModelSelectionScope,
  read: ComposerModelSelectionReader,
  enabled = true,
): void {
  const port = useContext(ComposerModelSelectionContext);
  const key = composerModelSelectionScopeKey(scope);
  const binding = useRef({ key, read, enabled });
  binding.current = { key, read, enabled };
  useLayoutEffect(() => {
    if (!port || !enabled) return;
    // 只注册读取原 owner 的函数；切 scope 的 render 到清理之间不能读到下一会话的值。
    return port.register(scope, () => {
      const current = binding.current;
      return current.enabled && current.key === key ? current.read() : null;
    });
  }, [port, key, enabled]);
}

export function useComposerModelSelectionReader(
  scope: ComposerModelSelectionScope,
): ComposerModelSelectionReader | undefined {
  const port = useContext(ComposerModelSelectionContext);
  const key = composerModelSelectionScopeKey(scope);
  const read = useCallback(() => port?.read(scope) ?? null, [port, key]);
  return port ? read : undefined;
}
