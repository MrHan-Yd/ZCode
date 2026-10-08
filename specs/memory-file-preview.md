# 工作区记忆的正文预览

## 背景

设置页「记忆」分区（`MemorySettingsViewer`）列出本机按工作区保存的 Project Memory 文件：图标 + 文件名 + 更新时间，行尾是一组「用外部编辑器打开」按钮。**列表里没有任何方式在应用内看到正文**——想读某条记忆写了什么，必须跳到 VS Code。

后端早已具备：`IMemoryService.readProjectMemoryFile({ workspaceId, fileName })` 返回 `{ content, updatedAt }`，并在服务层做了完整校验（路径段白名单、大小写不敏感文件系统下的精确文件匹配、stable handle 二次校验、`O_NOFOLLOW`）。前端之所以没用，是因为 `MemorySettingsSection` 把服务类型窄化成了 `Pick<IMemoryService, "listProjectMemories">` —— 类型层面就只声明了"列表"这一件事。

## 产品规则

1. 记忆文件行的**名称区域变为可点击**，点击打开正文预览弹窗。行尾的外部编辑器按钮保持原样（编辑仍走外部编辑器）。
2. 预览是**只读**的：本分区不提供应用内编辑，不引入写能力。
3. 正文按 **Markdown** 渲染，复用聊天侧同一套渲染（`MarkdownPreviewContent` → `MessageResponse`），并透传当前主题与代码预览设置，保证与仓库其它 markdown 展示一致。
4. 弹窗标题是文件名，并显示该文件的更新时间；底部保留「用外部编辑器打开」，让"看完想改"和"文件过大无法预览"两种情况都有一条出路。
5. **文件过大**（服务层上限 5 MiB，返回 `PROJECT_MEMORY_PREVIEW_LIMIT_EXCEEDED`）：不显示正文，明确提示超过预览上限，并指向外部编辑器。
6. **读取期间文件被改写**（`PROJECT_MEMORY_FILE_CHANGED`，服务层的 TOCTOU 防护）：提示文件已变更，并自动刷新目录列表，让用户重新点开拿到新内容。
7. 其它读取失败：展示服务返回的具体原因，不吞错。
8. 预览内容按文件名缓存于弹窗内的一次打开周期：切换文件重新拉取，关闭弹窗丢弃。

## 状态所有者

- **目录（工作区 ↔ 文件列表）**：仍由 `MemorySettingsSection` 持有，本次不改。
- **正文**：由预览弹窗自己按需拉取，**不进入目录状态**，也不缓存到 Section。记忆内容不属于"服务端事实"，只是一次读取结果；把它塞进目录状态会让刷新语义变复杂。
- **只读服务面**：Section 向 Viewer 暴露 `readMemoryFile(fileName)` 回调（内部绑定当前选中的 `workspaceId`），Viewer 再透传给弹窗。这样弹窗不需要知道工作区选择，也不需要直接依赖服务。

## 接口

复用既有 RPC，无协议改动：

```ts
// packages/services/src/memory/memory.ts（已存在）
readProjectMemoryFile(params: {
  workspaceId: string;
  fileName: string;
}): Promise<{ content: string; updatedAt: number }>;
```

两个错误码经 RPC 透传：`packages/rpc/src/channelClient.ts:90` 的 `passthroughKeys` 显式包含 `code`，因此 UI 侧可用 `(error as { code?: unknown }).code` 判定（与 `PreviewPane`、`pptxPreviewData` 的既有做法一致）。

## 验收场景

1. 展开记忆列表，点击任一文件名 → 弹窗打开并渲染该文件的 Markdown 正文。
2. 点击行尾的外部编辑器按钮 → 仍是打开外部编辑器，不触发预览。
3. 关闭弹窗再点另一个文件 → 拉取并显示新文件内容，不残留上一个文件的正文。
4. 文件超过 5 MiB → 不显示正文，提示超出预览上限，底部仍可打开外部编辑器。
5. 读取期间文件被替换 → 提示文件已变更，目录自动刷新。
6. 其它错误 → 显示具体原因。
7. 记忆功能关闭、或非桌面端（列表整体不渲染）→ 行为不变。

## 已知限制

- 不提供应用内编辑（写操作仍走外部编辑器）。
- 不提供全文搜索；现有搜索仍只匹配文件名。
- 不在弹窗里做实时刷新（外部改动需重新打开或刷新目录）。
