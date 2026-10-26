# 运行期能力目录刷新（MCP / Skill / Subagent）

## 背景

MCP、Skill、Subagent 都在 Session runtime 创建时形成快照：

- MCP server 集合写入 `runtimeConfig.mcp`，`startMcpStartup` / `registerMcpTools` 只执行一次；
- Skill 由 `AgentRuntime.skillLoadOutcome` 冻结，供系统提示词与 `getSkillCatalog` 共用；
- Subagent profile 由 bootstrap 启动时加载进 `config.subagents.profiles`，Agent/Task 工具描述与派发端口各自捕获。

因此用户在设置页新增、或直接往 `.zcode` / `.agents` 目录放文件后，已经启动的会话看不到新能力，只能重启应用。本 spec 定义两类处理：

1. **MCP 是启动期配置**：不允许会话内热加/热删 server。设置页变更必须失效未发送的 draft 预热会话，并明确告知已开始的会话需要重载会话。
2. **Skill / Subagent 是可按需重新发现的能力目录**：面板打开时允许本 Session 重新扫描，并把变化同步到提示词、工具描述与派发端口。

## 状态所有者

| 事实                | 唯一所有者                                                                     | 刷新入口                                                                |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| MCP server 集合     | `~/.zcode/cli/config.json` 与 workspace `.zcode/config.json`（设置页只写文件） | 无热刷新；Session runtime 创建时读取                                    |
| Skill 快照          | `AgentRuntime.skillLoadOutcome`                                                | `refreshAgentCatalogs` → `skillPort.discoverSkills`                     |
| Subagent profile    | `AgentRuntime.config.subagents.profiles`                                       | `refreshAgentCatalogs` → `SubagentProfilePort.loadProfiles`             |
| Subagent 派发       | `ExploreSubagentPort`                                                          | 端口通过 `getProfiles()` 读取当前 config，不捕获启动期数组              |
| Agent/Task 工具描述 | `ToolRegistry` 中的内置工具条目                                                | profile 变化后 `refreshBuiltInTools()` 重注册 + `invalidateToolCache()` |
| Composer 目录列表   | `useSkills` / `useSubagents` 的视图状态                                        | 面板打开时分别带 `refresh` 重扫 / `list` 重读                           |

## 事件顺序

```text
用户打开 / 或 $ 面板
  → UI: getSkillReferenceCatalog({ sessionId, refresh: true })
  → runtime.ensureContextInitialized()          （仅首次）
  → discoverSkillsForContext()                  （Skill）
  → SubagentProfilePort.loadProfiles()          （Subagent）
  → 集合有变化？
      Skill:     skillLoadOutcome = next
      Subagent:  config.subagents.profiles = next
                 refreshBuiltInTools() + invalidateToolCache()
  → 返回当前 catalog
  → UI: useSubagents.refresh() 重读 workspace 目录（`/` 面板）
  → 下一个 model step: turn.ts rebuildContextPrefix() 使用最新 Skill/Subagent 快照
```

MCP 变更：

```text
设置页保存 / 开关 / 删除
  → 先落盘 MCP 配置
  → invalidateDeferredDraftSessionForRuntimeChange()
      → draftRuntimeInvalidationVersion++（v4 预热会话重建）
      → legacy draftSessionId 关闭（如存在）
  → 下一次首发使用新 MCP 集合
已开始的会话：不发命令、不重连，UI 提示“重载会话/重启应用”
```

## 不变量

1. **MCP 不热更新**：引用、面板刷新、Settings 状态轮询都不改变 Session 已连接的 server 集合；`mcp/list` 的 `protocol-settings` lease 与 Session lease 隔离。
2. **刷新不重建 context prefix**：`refreshAgentCatalogs` 只改 snapshot。context prefix 的重建归 turn loop 每个 model step；面板请求可能落在进行中的 turn 内，直接替换 message history 会破坏流式请求。
3. **只有集合变化才产生副作用**：
   - Skill key 由名称、描述、路径、来源等“模型可见字段”组成；正文改动不触发提示词重建（`Skill` 工具按调用读文件）。
   - Subagent key 包含 `systemPrompt` 等全部派发字段；改正文也会触发重注册。
   - key 相同则不动 registry / tool cache，避免无谓的 prompt cache 失效。
4. **失败保留旧快照**：Skill 扫描出现 `skill_scan_failed`、或 profile loader 抛错时，不覆盖当前快照；对话本身 fail open。
5. **身份边界不变**：`sessionId` 必须命中 resident Session；未知 Session 仍 fail closed，不退化成 workspace 扫描。

## 接口

```ts
// packages/shared/src/zcode-protocol/index.ts
export const zcodeSkillsReferenceCatalogParamsSchema: {
  workspace: ZCodeWorkspaceRef;
  sessionId?: string;
  /** 面板打开时要求 runtime 重新发现 Skill/Subagent；缺省为只读快照。 */
  refresh?: boolean;
};

// apps/zcode-cli/packages/core/src/subagent/profile-port.ts
export interface SubagentProfilePort {
  loadProfiles(input: { workingDirectory: string; trace: TraceContext }): Promise<{
    profiles: AgentProfile[];
    builtInModelSelectionOverrides?: BuiltInSubagentModelSelectionOverrides;
  }>;
}

// apps/zcode-cli/packages/core/src/runtime/methods/catalogs.ts
export function refreshAgentCatalogs(
  traceContext: TraceContext,
): Promise<{ skillsChanged: boolean; subagentsChanged: boolean }>;

// apps/zcode-cli/packages/core/src/subagent/runner.ts
interface ExploreSubagentPortOptions {
  profiles?: readonly AgentProfile[];
  /** 优先于 profiles；每次 launch/run/start/sendMessage 读取当前 config。 */
  getProfiles?: () => readonly AgentProfile[] | undefined;
}
```

## 验收场景

1. 空 pane 已预热（draft session 已创建）→ 设置页新增 MCP → 直接首发：新 server 的工具在首轮可用，无需重启。
2. 已开始（有 turn）的会话里新增 MCP：设置页显示“已开始的对话需要重载会话/重启应用”；不出现“设置页绿色但静默不可用”的误导。
3. 运行中的会话新增 Skill 文件 → 打开 `$` 或 `/` 面板：列表立即出现；该轮模型请求的系统提示词包含新技能；`Skill` 工具可按名加载。
4. 运行中的会话新增 Subagent（设置页或直接放 Markdown）→ 打开 `/` 面板：列表立即出现；模型按 `subagent_type` 派发成功；Agent/Task 工具描述包含新 profile。
5. 打开面板但磁盘目录没有变化：不重注册工具、不 invalidate tool cache、不改变消息历史。
6. 扫描/读取失败：UI 保留旧 Skill/Subagent 列表；下一轮对话正常，日志有 warn（`subagent.catalog.refresh.failed` / Skill diagnostics）。
7. 已禁用或处于 trust 边界的 Subagent/Skill 仍按原规则过滤，刷新不得绕过启用状态。

## 已知限制

- MCP 不参与运行期刷新：这需要动态注册/注销 provider 工具并重算权限与子代理工具面，另行设计。
- 面板刷新是用户动作触发，不做文件系统 watcher；后台放着不打开面板的会话不会自动变化。
- 刷新只作用于收到请求的 Session；同一 workspace 的其他 resident Session 在各自面板打开时刷新。
- Skill 的启用/禁用覆盖在启动时固化进 `NodeSkillAdapter`；运行期刷新只能发现新增/删除/改元数据，不能改变禁用集合。切换 Skill 开关仍需要重载会话（draft 由设置页失效逻辑处理）。
- Subagent 的插件来源沿用 App 创建时的插件元数据；启用/停用插件造成的 profile 变化不经过本刷新，仍走插件自己的 reload 路径。
