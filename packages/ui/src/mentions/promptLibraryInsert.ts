import {
  $createLineBreakNode,
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  type LexicalEditor,
  type LexicalNode,
} from "lexical";
import { PROMPT_LIBRARY_INSERT_UPDATE_TAG } from "@/lib/editorUpdateTags.js";
import type { ActivePromptInputTokenSnapshot } from "@/mentions/activePromptInputToken.js";

interface InsertPromptLibraryArgs {
  /** 面板选中时捕获的 token 快照（nodeKey + 文本范围）。 */
  token: ActivePromptInputTokenSnapshot;
  /** 提示词全文；换行保留为同一段落内的 LineBreakNode。 */
  content: string;
}

function buildContentNodes(content: string): LexicalNode[] {
  const lines = content.split("\n");
  const nodes: LexicalNode[] = [];

  lines.forEach((line, index) => {
    // 多行内容必须落在同一段落内：段落节点会把单个换行序列化成空行。
    if (index > 0) {
      nodes.push($createLineBreakNode());
    }
    if (line.length > 0) {
      nodes.push($createTextNode(line));
    }
  });

  return nodes;
}

/**
 * 用提示词正文替换 `;query` token。返回是否真正执行了替换。
 *
 * 快照校验同时覆盖 nodeKey 与 tokenText：`service.get(id)` 是异步的，期间用户可能已经
 * 修改了触发词或把光标移走；此时放弃插入，避免覆盖用户新输入的内容。
 */
export function insertPromptLibraryAtToken(
  editor: LexicalEditor,
  { token, content }: InsertPromptLibraryArgs,
): boolean {
  if (content.length === 0) {
    return false;
  }

  let inserted = false;
  editor.update(
    () => {
      const node = $getNodeByKey(token.nodeKey);
      if (!$isTextNode(node)) {
        return;
      }

      const nodeText = node.getTextContent();
      if (nodeText.slice(token.tokenStart, token.tokenEnd) !== token.tokenText) {
        return;
      }

      const selection = $getSelection();
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
        return;
      }
      const anchor = selection.anchor;
      if (anchor.type !== "text" || anchor.getNode().getKey() !== token.nodeKey) {
        return;
      }
      if (anchor.offset < token.tokenStart || anchor.offset > token.tokenEnd) {
        return;
      }

      const previousChar = token.tokenStart > 0 ? (nodeText[token.tokenStart - 1] ?? "") : "";
      // 触发符必须位于行首或空白之后，正常情况下不会命中前导补空格；
      // 保留该分支是为了覆盖 `@foo` 等 token 被替换后紧贴前文的情况。
      const needsLeadingSpace = previousChar.length > 0 && !/\s/.test(previousChar);
      // 光标后已经有空白时不再补尾随空格，避免出现双空格；文本结尾仍要补，
      // 保证正文以 `;`、`@`、`/`、`$`、`#` 结尾时下一次输入不会重新激活面板。
      const nextChar = nodeText[token.tokenEnd] ?? "";
      const needsTrailingSpace = !/\s$/.test(content) && !/\s/.test(nextChar);

      const nodes: LexicalNode[] = [];
      if (needsLeadingSpace) {
        nodes.push($createTextNode(" "));
      }
      nodes.push(...buildContentNodes(content));
      if (needsTrailingSpace) {
        nodes.push($createTextNode(" "));
      }

      selection.setTextNodeRange(node, token.tokenStart, node, token.tokenEnd);
      selection.insertNodes(nodes);

      const lastNode = nodes[nodes.length - 1];
      lastNode?.selectEnd();
      inserted = true;
    },
    // 单次 update 即单次撤销单元：Cmd/Ctrl+Z 能一次恢复 `;query` 与光标位置。
    { tag: PROMPT_LIBRARY_INSERT_UPDATE_TAG },
  );

  return inserted;
}
