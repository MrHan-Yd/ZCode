import type { ModelSelection } from "@zcode/shared";

export interface ComposerModelSelectionScope {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string | null;
}

export type ComposerModelSelectionReader = () => ModelSelection | null;

export interface ComposerModelSelectionPort {
  register(scope: ComposerModelSelectionScope, read: ComposerModelSelectionReader): () => void;
  read(scope: ComposerModelSelectionScope): ModelSelection | null;
}

export function composerModelSelectionScopeKey(scope: ComposerModelSelectionScope): string {
  return JSON.stringify([scope.workspaceIdentity?.trim() || scope.workspacePath, scope.sessionId]);
}

export function createComposerModelSelectionPort(): ComposerModelSelectionPort {
  const readers = new Map<string, { read: ComposerModelSelectionReader }>();
  return {
    register(scope, read) {
      const key = composerModelSelectionScopeKey(scope);
      const registration = { read };
      readers.set(key, registration);
      return () => {
        // 同 scope 重挂载后，旧清理不能删除新 Composer 的读端口。
        if (readers.get(key) === registration) readers.delete(key);
      };
    },
    read(scope) {
      return readers.get(composerModelSelectionScopeKey(scope))?.read() ?? null;
    },
  };
}
