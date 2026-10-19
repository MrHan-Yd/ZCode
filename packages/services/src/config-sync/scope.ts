import { basename } from "node:path";

/**
 * 同步作用域：用户级（`{storageRoot}` 下）或工作区（项目）级（某个项目目录下）。
 *
 * 作用域决定三件事：本机读写路径、远端 gist 的 description、元数据与备份的分片键。
 * 这里只做纯计算，不碰文件系统，也不感知具体功能。
 */
export type ConfigSyncScope =
  | { readonly kind: "user" }
  | { readonly kind: "workspace"; readonly label: string };

export const USER_CONFIG_SYNC_SCOPE: ConfigSyncScope = { kind: "user" };

/** 目录名取不出来时（例如路径是盘符根）的兜底标识。 */
const FALLBACK_WORKSPACE_LABEL = "workspace";

/** 备份子目录前缀；用户级沿用原来的根目录，所以不加前缀。 */
const WORKSPACE_DIR_PREFIX = "ws-";

// eslint-disable-next-line no-control-regex -- 控制字符正是要转义的对象（与 MCP server 文件名的口径一致）
const UNSAFE_DIR_CHARS = /[%\\/\u0000-\u001f\u007f]/gu;

/**
 * 作用域判别只看「有没有 workspacePath」，与 MCP 既有的 `projectPath ? workspace : user` 同一口径。
 */
export function resolveConfigSyncScope(workspacePath?: string): ConfigSyncScope {
  const trimmed = workspacePath?.trim() ?? "";
  return trimmed.length > 0
    ? { kind: "workspace", label: resolveWorkspaceLabel(trimmed) }
    : USER_CONFIG_SYNC_SCOPE;
}

/**
 * 项目标识 = 工作区目录名。
 *
 * 用它当标识换来的是零交互：切到某个项目就能直接上传，换机器打开同名项目也能按 description 发现回来。
 * 代价是同名目录的两个项目会共用一份 gist 并互相覆盖，项目改名/换路径后要重新上传——这是该方案已知的
 * 取舍，见 `specs/subagent-config-sync.md` 的「作用域」节。
 */
export function resolveWorkspaceLabel(workspacePath: string): string {
  const label = basename(workspacePath).trim();
  return label.length > 0 ? label : FALLBACK_WORKSPACE_LABEL;
}

/**
 * 远端 gist 的 description：用户级就是基础标记，工作区级拼上项目名（`<base>:<label>`）。
 *
 * 发现走 description 全等比较，所以项目名必须进 description——否则同名标记的多份 gist 无法区分，
 * 也不需要为此给 manifest 加字段。
 */
export function scopeGistDescription(base: string, scope: ConfigSyncScope): string {
  return scope.kind === "user" ? base : `${base}:${scope.label}`;
}

/** 备份子目录名；用户级返回空串，表示直接用功能的备份根目录。 */
export function scopeBackupDirName(scope: ConfigSyncScope): string {
  return scope.kind === "user" ? "" : `${WORKSPACE_DIR_PREFIX}${encodeDirSegment(scope.label)}`;
}

/**
 * 目录名里的 `%`、路径分隔符与控制字符做百分号转义（与 MCP server 文件名的转义口径一致）：
 * 项目名虽然来自本机目录名，但拼进备份路径前仍要挡住「把路径带出目录」的字符。
 */
function encodeDirSegment(label: string): string {
  return label.replace(UNSAFE_DIR_CHARS, (char) => {
    const code = char.codePointAt(0) ?? 0;
    return `%${code.toString(16).padStart(2, "0")}`;
  });
}
