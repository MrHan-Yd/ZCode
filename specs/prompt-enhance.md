# 提示词增强（Prompt Enhance）

## 背景

composer 提供一个「增强提示词」按钮：用草稿当前选中的模型，把用户已经写下的草稿润色成更完整、更可执行的提示词，再写回输入框。

旧的 `prompt/enhance` 协议簇（含 `promptEnhanceResult` 通知）已连根删除（见 `packages/shared/src/zcode-protocol/index.ts:12`），本功能基于仍然存活的 `workspace/generateText` 一次性文本生成通道重建，不恢复旧协议簇。

## 产品规则

1. **触发**：点击 composer 右下操作区最左侧的增强按钮（模型控件组之前）。
2. **空草稿**：不发起请求，提示 `chat.promptEnhance.empty`。
3. **生成中**：按钮进入 pending；再次点击＝取消本次增强，提示 `chat.promptEnhance.cancelled`。
4. **成功**：用返回文本整体替换输入框内容，焦点回到输入框。该替换可被编辑器撤销（Ctrl+Z）。
5. **模型不可用**：草稿的选择无法解析出可用模型（未配置 / 未登录 / 无直连配置）时提示 `chat.promptEnhance.unsupported`，不发起请求。
6. **失败**：提示 `chat.promptEnhance.error`；错误带可展示详情时用 `chat.promptEnhance.errorWithDetail`。失败时输入框内容保持原样。
7. **不可见条件**：宿主的 accessor 未提供 `promptEnhanceService` 字段时不渲染按钮。
   - 注意 renderer 走 `RemoteServiceAccess` 时该字段**总是存在**（RPC 代理无条件构造），所以这条只在宿主直接组装 accessor 的场景（测试 double）真正生效。
   - renderer 与宿主版本不一致时（例如宿主进程没有随改动重启/重建），按钮可见但点击会失败，报错形如 `Channel name 'prompt-enhance' timed out after 1000ms`。这是宿主侧 `ServiceCollection` 里没有该频道（`packages/rpc/src/channelServer.ts:236` 的未知频道超时），不是模型配置问题：重建并重启宿主即可。

## 状态所有者

- **草稿文本**：`LexicalChatInput` 的编辑器状态是事实源，composer 的 `text` 只是镜像。写入必须走 `setText` → `updateText` → `scheduleDraftPersist`，不新增第二份草稿状态。
- **增强过程状态**（pending、取消控制器、结果版本号）：按钮组件内部，随组件卸载终止。
- **选中模型**：沿用 composer 草稿配置里已有的 modelSelection，不额外存一份。

## 接口

服务 `IPromptEnhanceService`（channel `prompt-enhance`）：

```ts
enhance(params: {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  selection: ModelSelection;
  text: string;
  signal?: AbortSignal;
}): Promise<
  | { ok: true; text: string }
  | { ok: false; reason: PromptEnhanceFailureReason; detail?: string }
>;
```

`reason` 取值：`empty-draft | model-unavailable | aborted | invalid-output | request-failed`。

**为什么是判别联合而不是抛错**：renderer 经 `ProxyChannel` 调用服务，抛出的 `Error` 过 RPC 边界只保留 message，自定义字段会丢，调用方无法区分「模型没配置」和「请求失败」。异常只在传输层失败时抛出。

- 底层通道：`zcodeAgentService.generateWorkspaceText`。
- `querySource` 固定为 `prompt_enhance`：轨迹面板已按该值显示「提示优化」（`packages/ui/src/ModelTrajectoryPaneParts.tsx:144`），且该值不覆盖输入栏 context meter（只有 `main_turn` 会覆盖，见 `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts:5610`）。
- 输出上限 4096 tokens；不改动用户选择的推理档位。
- 输出清洗：去首尾空白、剥掉整体代码围栏、空结果按 `invalid-output` 处理。
- 取消：`signal` → 协议 `workspace/cancelGenerateText`。

## 验收场景

1. 空草稿点按钮 → 提示「请先输入需要增强的提示词」，无模型请求。
2. 有草稿点按钮 → 按钮转圈；成功后输入框内容被替换，焦点回到输入框。
3. 生成中再点 → 立刻回到空闲并提示已取消；本地 workspace 下服务端生成被真正中断。
4. 草稿模型未配置 → 提示「当前选中的模型暂时没有可直连的增强配置。」，无模型请求。
5. 请求失败 → 提示失败文案，输入框内容保持原样。
6. 替换后 Ctrl+Z → 恢复增强前的草稿。
7. 按钮不参与工具条折叠阶梯：不要给它加 `data-composer-collapse-priority`。

## 已知限制

- **远端 workspace 的取消不会真正中断服务端生成**：`AbortSignal` 不经 `@zcode/rpc` 的 ProxyChannel 序列化。表现是 UI 立即停止等待并丢弃结果，但服务端那次生成会跑完。
- 通道非流式：整段返回，无逐字输出。

## E2E 锚点

`TID_V4_COMPOSER_PROMPT_ENHANCE`（定义在 `packages/shared/src/test-ids.ts`）。
