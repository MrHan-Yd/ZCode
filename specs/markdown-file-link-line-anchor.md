# 聊天文件链接的行锚点

## 背景

聊天消息里的本地文件链接支持 `path:12`、`path:12:34`、`path#L12` 三种带行号写法。解析层（`packages/ui/src/lib/markdownFileLink.ts`）一直能解析出行号，但渲染层把它丢了：`message.tsx` 的 `buildMessageFileLinkTarget` 没有行号入参，点击后打开的是不含行字段的 `FileCodeViewerSource`，所以点开永远停在文件开头，模型标注的「第 263 行」要用户自己再找。

查看器本身已经具备定位能力：`CodeViewer` 的 `focusedRange` + `focusRequestId` 会让 `@pierre/diffs` 渲染出的目标行居中。原先只有代码评论卡片（`code-review` 源）接在这条通路上。本次把已经解析出的行号接到同一条通路，不新增 IPC、协议字段或第二套滚动实现。

## 产品规则

1. Markdown 链接渲染层解析出行号时，点击必须打开内置查看器并定位到该行（滚动居中 + 高亮）。
2. 行号是「打开时的定位意图」，**不参与 tab 身份**。tab 仍按 workspace scope + 路径复用（`lib/workspaceSidePane.ts` 的 `getCodeViewerTabSourceKey`），重新点击同一文件只会替换该 tab 的 source。
3. 定位必须可重复：用户滚动离开后再次点击同一链接（行号相同）也要回到目标行，因此每次点击生成新的 `requestId`。
4. 目标行超出文件实际行数（消息发出后文件被改动）时不定位、不报错，顶部显示一行提示，文件停在开头。
5. 目录链接、无行号的链接、右键菜单的「在编辑器中打开」行为不变（外部编辑器链路不在本次范围）。
6. Markdown、SVG 预览模式下不定位（这两类内容不走 `CodeContent`）；切到代码视图后按规则 1 生效。
7. 芯片的悬停提示带完整路径；解析出行号时提示写成 `路径:行号`（芯片正文仍是模型写的链接文本，不改写）。

## 状态所有者

- **行号解析**：`parseMarkdownFileLinkTarget` / `resolveMarkdownFileLink`（`lib/markdownFileLink.ts`）是唯一来源，渲染层不再二次解析字符串。
- **行锚点载体**：`FileCodeViewerSource.lineAnchor`（`lib/codeViewer.ts`），随 tab 的 source 存续，由 `PreviewPane` 读出后交给 `CodeContent`。
- **requestId 序列**：`lib/codeViewerLineAnchor.ts` 的模块级计数器。与 `AssistantCodeCommentCards` 的 `navigationRequestSequence`、`message.tsx` 的 attachment reader epoch 同构：只在单次进程内递增，不需要持久化，也不需要跨 Host 协同。
- **定位执行**：`components/ui/code-viewer.tsx` 里已有的 `focusRequestId` effect 是唯一执行者，不新增滚动路径。

不做的事实：不缓存「上次打开的行号」，不做 tab 级记忆；`MessageFileLinkTarget.lineNumber` 只用于打开动作，不写入任何 store。

## 事件顺序

```text
点击链接
  → WorkspacePathOpenRequest（CustomEvent，新增 lineNumber）
  → WorkspaceShellLayout.handleOpenMarkdownFileLink（stat 判文件/目录）
  → handleOpenCodeViewer（按 sourceKey 复用或新建 tab，source 带 lineAnchor）
  → PreviewPaneContent（判定目标行是否在当前内容里）
  → CodeViewer focus effect（滚动居中 + 高亮；行数不含目标行时只出提示）
```

## 接口

```ts
// packages/ui/src/lib/codeViewer.ts
export interface FileCodeViewerLineAnchor {
  lineNumber: number;
  requestId: string;
}
export interface FileCodeViewerSource extends CodeViewerWorkspaceScope {
  type: "file";
  title: string;
  path: string;
  lineAnchor?: FileCodeViewerLineAnchor;
}

// packages/ui/src/lib/codeViewerLineAnchor.ts
export function createFileCodeViewerLineAnchor(lineNumber: number): FileCodeViewerLineAnchor;
export function isCodeViewerLineRangeVisible(
  content: string,
  startLine: number | undefined,
  endLine: number | undefined,
): boolean;
export function resolveFileLineAnchorProjection(
  anchor: FileCodeViewerLineAnchor,
  content: string,
): { focusedRange: CodeCommentRange | null; targetLineOutOfRange: boolean };

// packages/ui/src/components/ai-elements/message.tsx
export interface MessageFileLinkTarget {
  // ...既有字段
  /** 打开时的定位行；不参与身份匹配。 */
  lineNumber?: number;
}
```

`isCodeViewerLineRangeVisible` 同时被 `previewPaneCodeReview.ts` 复用，行区间是否落在内容内只有一份判定。

新增 i18n：`codeViewer.lineAnchor.targetLineMissing`（zh-CN / en-US）。

## 验收场景

1. 消息里出现 `[Foo.java:263](.../Foo.java#L263)` → 点击 → 右侧查看器打开该文件，目标行居中并高亮。
2. 同一文件再点击另一行（如 `:158`）→ 复用同一 tab，滚动到新行。
3. 滚动离开后再点同一行 → 仍回到该行（依赖递增的 requestId）。
4. 链接行号超过文件行数 → 文件停在开头，顶部出现「目标行不存在」提示。
5. 无行号链接、目录链接、右键「在编辑器中打开」与改动前一致。
6. 远程 workspace / 手机远控下点击带行号链接，定位与本地一致（source 已带 workspace scope 字段）。

交互层验证方式：`packages/ui` 没有 E2E 框架，按既有约定用单测覆盖解析与投影逻辑（`node --import tsx --test test/fileLineAnchor.test.ts`），滚动与高亮需要人工在桌面端确认。
