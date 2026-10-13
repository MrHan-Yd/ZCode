import {
  modelMessageContentToText,
  type ModelMessageContent,
  type ModelMessageContentBlock,
  type ToolResultBudget,
} from "@zcode/contracts";
import { findOfficialCuaFrameContentPair } from "@zcode/zcode-cua/frame-contract";
import type { ToolResultSerialization } from "../types.js";

/**
 * 与 contracts 的 `ToolResultBudget["preview"]["direction"]` 同源，避免多处重复字面量。
 * `direction` 本身是可选属性，`NonNullable` 需要套两层才能同时剥掉 `preview` 与
 * `direction` 的 `undefined`——只剥外层会让别名残留 `undefined`，下游按 `"head" | "tail"`
 * 收窄的调用点（如 `fitStringToBytes`）全部报 TS2345。
 */
export type ResultPreviewDirection = NonNullable<
  NonNullable<ToolResultBudget["preview"]>["direction"]
>;

interface HookStringProjection {
  content: string;
  truncated: boolean;
}

const OFFICIAL_CUA_TEXT_TRUNCATION_MARKER =
  "[Official CUA text truncated by resultBudget. Re-observe with detail=compact or a narrower window before relying on omitted state.]";

const OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE = "official_cua_frame_pair_not_leading";

export class OfficialCuaFrameContractError extends Error {
  readonly code = OFFICIAL_CUA_FRAME_CONTRACT_ERROR_CODE;

  constructor() {
    super("Official CUA frame pair must be the first two result blocks");
    this.name = "OfficialCuaFrameContractError";
  }
}

export function projectOfficialCuaStructuredContent(
  content: ModelMessageContentBlock[],
  maxModelBytes: number,
  direction: ResultPreviewDirection,
): { content: ModelMessageContentBlock[]; truncated: boolean } | undefined {
  const pair = findOfficialCuaFrameContentPair(content);
  if (!pair) return undefined;
  // 官方 producer 的 canonical pair 必须已经位于结果首部。consumer 只校验、
  // 预算并保序，不再猜测或提升非 canonical 布局。这里直接失败，避免后续通用
  // 小结果直通路径重新把带前缀的 frame authority 交给模型。
  if (pair.imageIndex !== 0 || pair.imageRefIndex !== 1) {
    throw new OfficialCuaFrameContractError();
  }

  const pairContent: ModelMessageContentBlock[] = [pair.image, pair.imageRef];
  const suffixBlocks = content
    .slice(2)
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text" && block.text.length > 0,
    );
  const hasOtherStructuredBlocks = content.some(
    (block, index) =>
      index !== pair.imageRefIndex && index !== pair.imageIndex && block.type !== "text",
  );
  const completeContent: ModelMessageContentBlock[] = [...pairContent, ...suffixBlocks];
  if (
    !hasOtherStructuredBlocks &&
    Buffer.byteLength(stringifyModelContentForSerialization(completeContent), "utf8") <=
      maxModelBytes
  ) {
    return { content: completeContent, truncated: false };
  }

  const suffixText = joinTextBlocks(suffixBlocks);
  const pairBytes = Buffer.byteLength(stringifyModelContentForSerialization(pairContent), "utf8");
  const remainingAfterPair = Math.max(0, maxModelBytes - pairBytes);
  const projectedMarker = fitStringToBytes(
    OFFICIAL_CUA_TEXT_TRUNCATION_MARKER,
    Math.max(0, remainingAfterPair - 2),
    "head",
  );
  const markerCost =
    projectedMarker.length > 0 ? Buffer.byteLength(projectedMarker, "utf8") + 2 : 0;
  const suffixBudget =
    projectedMarker.length > 0 ? Math.max(0, remainingAfterPair - markerCost - 2) : 0;
  const projectedSuffix =
    direction === "head-tail"
      ? fitStringToBytesHeadTail(suffixText, suffixBudget)
      : fitStringToBytes(suffixText, suffixBudget, direction);

  const projected: ModelMessageContentBlock[] = [
    pair.image,
    pair.imageRef,
    ...(projectedSuffix ? [{ type: "text" as const, text: projectedSuffix }] : []),
    ...(projectedMarker ? [{ type: "text" as const, text: projectedMarker }] : []),
  ];
  return {
    content: projected,
    truncated: true,
  };
}

export function appendHookWithoutReorderingStructuredContent(
  serialization: ToolResultSerialization,
  hookContext: string,
  suffix: string,
  maxModelBytes: number,
): ToolResultSerialization {
  const modelContent = serialization.modelContent ?? serialization.content;
  if (!Array.isArray(modelContent)) return serialization;

  const currentBytes = Buffer.byteLength(serialization.content, "utf8");
  const remainingBytes = Math.max(0, maxModelBytes - currentBytes);
  const separator = "\n\n";
  const separatorBytes = Buffer.byteLength(separator, "utf8");
  const fittedHookContext =
    remainingBytes > separatorBytes
      ? fitStringToBytes(hookContext, remainingBytes - separatorBytes, "head")
      : "";
  const fittedSuffix = fittedHookContext.length > 0 ? `${separator}${fittedHookContext}` : "";
  const hookTruncated = Buffer.byteLength(suffix, "utf8") > remainingBytes;
  const content = `${serialization.content}${fittedSuffix}`;

  return {
    ...serialization,
    content,
    // 只能在原始块之后追加 hook。这样 raster 仍然是首块、image_ref 仍紧随其后，
    // 即使 hook 超出预算也不会把文本搬到图片前或用字符串替换图片。
    modelContent:
      fittedHookContext.length > 0
        ? [...modelContent, { type: "text", text: fittedHookContext }]
        : modelContent,
    // returnedBytes 已包含受保护 raster；追加 hook 只增加实际新增的文本 bytes，
    // 避免重新拆分文本/媒体并维护第二份计量状态。
    returnedBytes: serialization.returnedBytes + Buffer.byteLength(fittedSuffix, "utf8"),
    truncated: serialization.truncated || hookTruncated,
  };
}

export function appendHookToStringContent(
  content: string,
  suffix: string,
  maxBytes: number,
  previewDirection: ResultPreviewDirection,
): HookStringProjection {
  const augmentedContent = `${content}${suffix}`;
  if (Buffer.byteLength(augmentedContent, "utf8") <= maxBytes) {
    return { content: augmentedContent, truncated: false };
  }
  return {
    content: fitContentWithSuffix(content, maxBytes, suffix, previewDirection),
    truncated: true,
  };
}

export function appendHookToPersistedArtifactPreview(
  content: string,
  suffix: string,
  maxHookBytes: number,
): HookStringProjection {
  const fittedSuffix = fitStringToBytes(suffix, maxHookBytes, "head");
  return {
    content: `${content}${fittedSuffix}`,
    truncated: Buffer.byteLength(suffix, "utf8") > maxHookBytes,
  };
}

export function projectHookAugmentedModelContent(input: {
  artifactPreview: boolean;
  contentProjection: HookStringProjection;
  hookContext: string;
  maxModelBytes: number;
  modelContent: ModelMessageContent;
  previewDirection: ResultPreviewDirection;
  suffix: string;
}): ModelMessageContent {
  if (input.artifactPreview) return input.contentProjection.content;
  if (!input.contentProjection.truncated) {
    return appendHookContextToModelContent(input.modelContent, input.hookContext);
  }
  if (!hasPreservedStructuredBlocks(input.modelContent)) return input.contentProjection.content;

  const textContent = budgetedTextFromStructuredContent(input.modelContent);
  const budgetedText = fitContentWithSuffix(
    textContent,
    input.maxModelBytes,
    input.suffix,
    input.previewDirection,
  );
  return [
    ...input.modelContent.filter(shouldPreserveStructuredBlock),
    ...(budgetedText.length > 0 ? [{ type: "text" as const, text: budgetedText }] : []),
  ];
}

export function fitContentWithSuffix(
  content: string,
  maxBytes: number,
  suffix: string,
  direction: ResultPreviewDirection,
): string {
  if (maxBytes <= 0) return "";
  const suffixContent = fitStringToBytes(suffix, maxBytes, "head");
  const remainingBytes = maxBytes - Buffer.byteLength(suffixContent, "utf8");
  if (remainingBytes <= 0) return suffixContent;
  // 预算太小（装不下省略标记 + 两端有意义的内容）时 head-tail 退化为 head，
  // 避免 marker 反而挤占全部预算。
  if (direction === "head-tail") {
    if (remainingBytes <= HEAD_TAIL_MARKER_RESERVE_BYTES + 1024) {
      return `${fitStringToBytes(content, remainingBytes, "head")}${suffixContent}`;
    }
    return fitContentHeadTail(content, remainingBytes, suffixContent);
  }
  return `${fitStringToBytes(content, remainingBytes, direction)}${suffixContent}`;
}

/** head-tail 预览里分给尾部的预算比例：build/test 输出的错误摘要通常在末尾。 */
const HEAD_TAIL_TAIL_RATIO = 0.3;
/** 省略标记的预算预留：实际标记 ~50 字节，余量覆盖省略字节数的位数增长。 */
const HEAD_TAIL_MARKER_RESERVE_BYTES = 128;
/** 收敛轮次里对 head 的额外超裁量：保证每轮严格缩 head，压过 marker 位数增长（≤2 字节/轮）。 */
const HEAD_TAIL_SHRINK_OVERSHOOT_BYTES = 8;

/**
 * head-tail 截断：head(约 70%) + 中段省略标记 + tail(约 30%)，总字节严格 ≤ maxBytes
 * （suffix 的预算已由调用方扣除，这里只需保证 head+marker+tail ≤ maxBytes）。
 * 依据 specs/tool-result-head-tail-truncation.md。
 */
function fitContentHeadTail(content: string, maxBytes: number, suffix: string): string {
  const contentBytes = Buffer.byteLength(content, "utf8");
  // 内容装得下剩余预算时，head/tail 路径仍会附加 suffixContent（见 fitContentWithSuffix）；
  // head-tail 必须同契约，否则 hook 后缀在这个分支被静默丢弃。
  if (contentBytes <= maxBytes) return `${content}${suffix}`;
  const contentBudgetBytes = maxBytes - HEAD_TAIL_MARKER_RESERVE_BYTES;
  const tailBudgetBytes = Math.floor(contentBudgetBytes * HEAD_TAIL_TAIL_RATIO);
  const headBudgetBytes = contentBudgetBytes - tailBudgetBytes;
  const tail = fitStringToBytes(content, tailBudgetBytes, "tail");
  let head = fitStringToBytes(content, headBudgetBytes, "head");
  // 收敛循环：省略标记含被丢弃中段的精确字节数，head 每次修正会反过来影响该数字的
  // 位数（每轮 ≤ 2 字节）；overshoot 常数保证严格收敛，实践 1–2 轮完成。
  for (let round = 0; round < 4; round += 1) {
    const marker = headTailOmissionMarker(contentBytes, head, tail);
    const totalBytes =
      Buffer.byteLength(head, "utf8") + Buffer.byteLength(marker, "utf8") + Buffer.byteLength(tail, "utf8");
    if (totalBytes <= maxBytes) {
      return `${head}${marker}${tail}${suffix}`;
    }
    const excessBytes = totalBytes - maxBytes + HEAD_TAIL_SHRINK_OVERSHOOT_BYTES;
    head = fitStringToBytes(head, Buffer.byteLength(head, "utf8") - excessBytes, "head");
  }
  // 防御性兜底（理论不可达）：按差额逐轮硬裁 head，直到总字节不超过预算。
  for (;;) {
    const marker = headTailOmissionMarker(contentBytes, head, tail);
    const totalBytes =
      Buffer.byteLength(head, "utf8") + Buffer.byteLength(marker, "utf8") + Buffer.byteLength(tail, "utf8");
    if (totalBytes <= maxBytes) {
      return `${head}${marker}${tail}${suffix}`;
    }
    const excessBytes = totalBytes - maxBytes;
    if (Buffer.byteLength(head, "utf8") <= excessBytes) {
      // head 裁无可裁：tail+marker 仍超预算只可能是预算本身 < marker+tail 下限，
      // 调用方已用 reserve 门槛排除；这里放弃 tail 保住字节上限。
      return `${fitStringToBytes(content, maxBytes, "head")}${suffix}`;
    }
    head = fitStringToBytes(head, Buffer.byteLength(head, "utf8") - excessBytes, "head");
  }
}

function headTailOmissionMarker(contentBytes: number, head: string, tail: string): string {
  const omittedBytes =
    contentBytes - Buffer.byteLength(head, "utf8") - Buffer.byteLength(tail, "utf8");
  return `\n\n[... ${omittedBytes} bytes in the middle omitted ...]\n\n`;
}

function joinTextBlocks(content: ModelMessageContentBlock[]): string {
  return content
    .filter(
      (block): block is Extract<ModelMessageContentBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function stringifyModelContentForSerialization(content: ModelMessageContent): string {
  return typeof content === "string" ? content : modelMessageContentToText(content);
}

function appendHookContextToModelContent(
  content: ModelMessageContent,
  hookContext: string,
): ModelMessageContent {
  if (typeof content === "string") return `${content}\n\n${hookContext}`;
  return [...content, { type: "text", text: hookContext }];
}

function hasPreservedStructuredBlocks(
  content: ModelMessageContent,
): content is ModelMessageContentBlock[] {
  return Array.isArray(content) && content.some(shouldPreserveStructuredBlock);
}

function shouldPreserveStructuredBlock(block: ModelMessageContentBlock): boolean {
  if (block.type === "text") return false;
  if (block.type === "file" && typeof block.text === "string" && block.text.length > 0) {
    return false;
  }
  return true;
}

function budgetedTextFromStructuredContent(content: ModelMessageContentBlock[]): string {
  return content
    .map((block) => {
      if (block.type === "text") return block.text;
      if (block.type === "file" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function fitStringToBytes(value: string, maxBytes: number, direction: "head" | "tail"): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;

  const chars = Array.from(value);
  let low = 0;
  let high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate =
      direction === "tail"
        ? chars.slice(chars.length - mid).join("")
        : chars.slice(0, mid).join("");
    if (Buffer.byteLength(candidate, "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return direction === "tail"
    ? chars.slice(chars.length - low).join("")
    : chars.slice(0, low).join("");
}

/**
 * head+tail 纯文本切分，**不**自带省略标记——供已有自己的截断提示的路径复用（官方 CUA 的
 * 结构化投影在文本外另挂 `OFFICIAL_CUA_TEXT_TRUNCATION_MARKER`，再叠一条通用
 * "...bytes omitted..." 会出现两个标记）。head 预算取整后 tail 补足，二者之和 ≤ maxBytes <
 * 原文长度，因此首尾切片不可能重叠。
 */
function fitStringToBytesHeadTail(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const tailBudgetBytes = Math.floor(maxBytes * HEAD_TAIL_TAIL_RATIO);
  const headBudgetBytes = maxBytes - tailBudgetBytes;
  return `${fitStringToBytes(value, headBudgetBytes, "head")}${fitStringToBytes(value, tailBudgetBytes, "tail")}`;
}
