import { useCallback } from "react";
import { ZCODE_AGENT_PROVIDER, type ZCodeProvider } from "@zcode/shared";
import {
  resolveSubagentIdentityColor,
  selectSubagentIdentityProfiles,
} from "@/lib/subagentColors.js";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";

/** 身份色只派生自当前已加载配置，不触发 RPC，也不维护第二份颜色状态。 */
export function useSubagentColorResolver(
  workspacePath: string,
  workspaceIdentity?: string,
  provider: ZCodeProvider = ZCODE_AGENT_PROVIDER,
) {
  const contextKey = getSubagentsContextKey(workspacePath, provider, workspaceIdentity);
  const context = useSubagentsContextStore((state) => state.contexts[contextKey]);
  const profiles = useSubagentsStore((state) =>
    selectSubagentIdentityProfiles({ workspacePath, workspaceIdentity, provider }, context, state),
  );
  return useCallback(
    (name: string, color?: unknown) => resolveSubagentIdentityColor({ name, color, profiles }),
    [profiles],
  );
}
