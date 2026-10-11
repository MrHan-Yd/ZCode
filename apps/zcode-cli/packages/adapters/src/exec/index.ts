export { resolveEffectiveBashShellSelection } from "./bash-shell-provider.js";
export {
  applyResolvedShellCommandForTest,
  buildExecutionEnv,
  resolveExecutionCommand,
  setResolvedShellLoginMode,
} from "./execution-command.js";
export type { ResolvedSpawnCommand } from "./execution-command.js";
export type { NodeExecutionAdapterOptions } from "./execution-adapter-types.js";
export { createNodeExecutionAdapter, NodeExecutionAdapter } from "./node-execution-adapter.js";
export { decodeExecutionOutputBuffer } from "./outputEncoding.js";
// 会话产物目录名归一化：storage（artifacts/媒体缓存）、exec 输出与「彻底删除」的清理
// 必须共用同一实现，否则删除路径与写入路径会分叉。
export { sanitizePathSegment } from "./execution-utils.js";
