import type {
  GitCommitMessageConversationContext,
  GitDiffResult,
  GitFileChange,
  Locale,
  ModelSelection,
  ZCodeWorkspaceGenerateTextParams,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";

const MAX_PROMPT_FILES = 20;
const MAX_DIFF_FILES = 8;
const MAX_DIFF_CHARS = 12_000;
const MAX_DIFF_CHARS_PER_FILE = 2_000;
const MAX_CONVERSATION_CONTEXT_MESSAGES = 12;
const MAX_CONVERSATION_CONTEXT_CHARS = 4_000;
const MAX_CONVERSATION_CONTEXT_CHARS_PER_MESSAGE = 600;
const MAX_COMMIT_MESSAGE_CHARS = 1_000;
const COMMIT_MESSAGE_QUERY_SOURCE = "git_commit_message";

const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]+\))?!?: .{1,100}$/;

/** 生成物不合规的原因：长度超限单独一档，便于日志区分"写歪了"和"写太长了"。 */
type GitCommitMessageValidationFailureReason = "empty" | "invalid" | "too-long";

interface GitCommitMessageCurrentModelProvider {
  readCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"] | null>;
}

interface GitCommitMessageTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    prompt: string;
    querySource: string;
  }): Promise<{ text: string; selection: ZCodeWorkspaceGenerateTextParams["selection"] }>;
}

interface GitCommitMessageGeneratorOptions {
  currentModelProvider: GitCommitMessageCurrentModelProvider;
  textGenerator: GitCommitMessageTextGenerator;
  logger?: ServiceLogger;
}

class GitCommitMessageGenerationError extends Error {
  constructor(
    message: string,
    readonly reason: "model-unavailable" | "request-failed" | "invalid-output",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GitCommitMessageGenerationError";
  }
}

export class GitCommitMessageGenerator {
  constructor(private readonly options: GitCommitMessageGeneratorOptions) {}

  async generate(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    branchName: string | null;
    locale?: Locale;
    files: readonly GitFileChange[];
    diffs: readonly GitDiffResult[];
    conversationContext?: GitCommitMessageConversationContext;
    /** 调用方（当前会话）的模型选择；缺省时退回 Host 的 preferredSelection。 */
    selection?: ModelSelection;
  }): Promise<{ message: string; providerId: string; model: string }> {
    const resolved = await this.resolveSelection(params);
    const selection = resolved.selection;
    const prompt = buildGitCommitMessageGenerationPrompt({
      branchName: params.branchName,
      locale: params.locale,
      files: params.files,
      diffs: params.diffs,
      conversationContext: params.conversationContext,
    });

    this.options.logger?.info(undefined, "开始生成 Git 提交消息", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      providerId: selection.providerId,
      model: selection.modelId,
      // 会话模型与 Host 默认模型会打到完全不同的 provider；排障必须能区分来源。
      selectionSource: resolved.source,
      fileCount: params.files.length,
      diffCount: params.diffs.length,
      conversationMessageCount: params.conversationContext?.messages.length ?? 0,
      conversationOmittedMessageCount: params.conversationContext?.omittedMessageCount ?? 0,
    });

    const rawMessage = await this.complete({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      selection,
      prompt,
    });
    const validation = validateGeneratedGitCommitMessage(rawMessage);
    if (!validation.ok) {
      // 模型可能重复 prompt 或返回解释性长文本，直接塞给 UI 会让错误提示失控。
      // 这里只保留短 preview 给用户，完整模型调用细节由 agent runtime 的模型日志记录。
      this.options.logger?.debug(undefined, "模型生成的 Git 提交消息不合规", {
        workspacePath: params.workspacePath,
        providerId: selection.providerId,
        model: selection.modelId,
        reason: validation.reason,
        preview: validation.preview,
      });
      throw new GitCommitMessageGenerationError(
        "模型没有返回可用的 Conventional Commit 提交消息。",
        "invalid-output",
        validation.preview,
      );
    }

    return {
      message: validation.message,
      providerId: selection.providerId,
      model: selection.modelId,
    };
  }

  /**
   * 模型来源按调用方传入优先：UI 传入的是当前会话正在用的模型，比 Host 的默认偏好更贴近
   * 用户此刻的意图。只有没有会话上下文的调用方（脚本、自动化）才退回 preferredSelection。
   */
  private async resolveSelection(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection?: ModelSelection;
  }): Promise<{
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    source: "session" | "preferred";
  }> {
    const requested = params.selection;
    if (!requested) {
      return { selection: await this.resolveCurrentModel(params), source: "preferred" };
    }

    const providerId = requested.providerId?.trim();
    const modelId = requested.modelId?.trim();
    if (!providerId || !modelId) {
      // 不完整的传入选择不能静默换成别的模型：那会让用户以为用的是自己选的那个。
      throw new GitCommitMessageGenerationError("提交消息模型选择不完整。", "model-unavailable");
    }
    const reasoningLevel = requested.options?.reasoningLevel?.trim();
    return {
      selection: {
        providerId,
        modelId,
        ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
      },
      source: "session",
    };
  }

  private async resolveCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"]> {
    const currentModel = await this.options.currentModelProvider.readCurrentModel({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const modelId = currentModel?.modelId?.trim();
    const providerId = currentModel?.providerId?.trim();
    const options = currentModel?.options;
    if (!providerId || !modelId) {
      throw new GitCommitMessageGenerationError("未读取到当前模型。", "model-unavailable");
    }
    return {
      providerId,
      modelId,
      ...(options
        ? {
            options: {
              ...options,
            },
          }
        : {}),
    };
  }

  private async complete(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    prompt: string;
  }): Promise<string> {
    try {
      const result = await this.options.textGenerator.generateText({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        selection: params.selection,
        prompt: params.prompt,
        querySource: COMMIT_MESSAGE_QUERY_SOURCE,
      });
      return normalizeModelText(result.text);
    } catch (error) {
      if (error instanceof GitCommitMessageGenerationError) {
        throw error;
      }
      throw new GitCommitMessageGenerationError(
        "模型请求失败。",
        "request-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

function buildGitCommitMessageGenerationPrompt(params: {
  branchName: string | null;
  locale?: Locale;
  files: readonly GitFileChange[];
  diffs: readonly GitDiffResult[];
  conversationContext?: GitCommitMessageConversationContext;
}): string {
  const normalizedBranchName = params.branchName?.trim() || "(detached or unknown)";
  const language = resolveCommitMessageLanguage(params.locale);
  const visibleFiles = params.files.slice(0, MAX_PROMPT_FILES);
  const omittedFileCount = Math.max(0, params.files.length - visibleFiles.length);
  const fileSummary = visibleFiles
    .map((file) => `- ${file.kind} ${file.repoRelativePath} (+${file.added}/-${file.removed})`)
    .join("\n");
  const diffSummary = buildDiffSummary(params.diffs);
  const conversationSummary = buildConversationContextSummary(params.conversationContext);

  return [
    "Write exactly one Git commit message for the workspace changes below.",
    "Return only the commit message text.",
    "",
    "Hard requirements:",
    "- The first line must be a valid Conventional Commit subject.",
    "- Use one of: feat, fix, docs, style, refactor, perf, test, build, ci, chore, revert.",
    "- Keep the Conventional Commit type and optional scope in English.",
    "- Write the subject and any body in the current language.",
    "- Keep the subject under 72 characters.",
    // 长度上限写进提示词，和校验用的是同一个常量：超限会被判为不可用（不是被裁剪），
    // 所以这里必须让模型看得见确切数字。见 specs/git-commit-message-format.md。
    `- Keep the whole message, subject and body together, within ${MAX_COMMIT_MESSAGE_CHARS} characters.`,
    "- Prefer the subject alone; add a body only for information the subject cannot carry.",
    "- Use the current session conversation context only to infer user intent.",
    "- Do not mention the conversation, chat, prompt, or user request explicitly.",
    "- Do not explain your reasoning.",
    "- Do not repeat these instructions.",
    "",
    `Current branch: ${normalizedBranchName}`,
    `Current language: ${language}`,
    "",
    "Current session conversation context:",
    conversationSummary || "(not provided)",
    "",
    "Changed files:",
    fileSummary || "- (no file summary available)",
    omittedFileCount > 0 ? `- ... ${omittedFileCount} more files` : "",
    "",
    "Diff excerpts:",
    diffSummary || "(diff unavailable; infer only from the changed file summary)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function resolveCommitMessageLanguage(locale?: Locale): "Chinese" | "English" {
  const candidate = locale ?? readRuntimeLocale();
  return candidate?.toLowerCase().startsWith("zh") ? "Chinese" : "English";
}

function readRuntimeLocale(): string | undefined {
  try {
    // 系统默认语言没有从 UI 显式传入时，服务层只能读取当前运行时的 Intl locale。
    // 这里仍只接受 zh 为中文，其它未知或读取失败都按英文处理，避免误生成第三种语言。
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return undefined;
  }
}

/**
 * 校验模型生成的提交消息：只做判定，任何情况下都不裁剪模型输出。
 *
 * 之前这里会把超长输出 `slice` 到 1000 字符，裁剪点常落在句子中间，提交历史里留下一句
 * 断掉的话——用户看到的是"一条看着正常的消息"，而不是"生成失败"。现在长度上限改由提示词
 * 约束（模型可见），超限直接判不合规，让失败显性化。见 specs/git-commit-message-format.md。
 */
function validateGeneratedGitCommitMessage(
  rawMessage: string,
):
  | { ok: true; message: string }
  | { ok: false; reason: GitCommitMessageValidationFailureReason; preview?: string } {
  const message = stripGeneratedCommitMessageDecorations(rawMessage).trim();
  if (!message) {
    return { ok: false, reason: "empty" };
  }

  const subject = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!CONVENTIONAL_COMMIT_RE.test(subject)) {
    return { ok: false, reason: "invalid", preview: subject || message.slice(0, 120) };
  }
  if (message.length > MAX_COMMIT_MESSAGE_CHARS) {
    return {
      ok: false,
      reason: "too-long",
      preview: `${message.slice(0, 120)}…（${message.length} 字符，上限 ${MAX_COMMIT_MESSAGE_CHARS}）`,
    };
  }
  return { ok: true, message };
}

function buildDiffSummary(diffs: readonly GitDiffResult[]): string {
  let totalChars = 0;
  const chunks: string[] = [];
  for (const diff of diffs.slice(0, MAX_DIFF_FILES)) {
    const header = `--- ${diff.path}`;
    const body = diff.patch?.trim() || diff.summary?.trim() || "(diff unavailable)";
    const remainingChars = MAX_DIFF_CHARS - totalChars;
    if (remainingChars <= 0) {
      break;
    }
    const clippedBody = clipText(
      body,
      Math.min(MAX_DIFF_CHARS_PER_FILE, remainingChars),
      "...diff truncated...",
    );
    const chunk = `${header}\n${clippedBody}`;
    chunks.push(chunk);
    totalChars += chunk.length;
  }
  return chunks.join("\n\n");
}

function buildConversationContextSummary(
  context: GitCommitMessageConversationContext | undefined,
): string {
  const messages = context?.messages ?? [];
  if (messages.length === 0) {
    return "";
  }

  const chunks: string[] = [];
  let totalChars = 0;
  const omittedMessageCount =
    (context?.omittedMessageCount ?? 0) +
    Math.max(0, messages.length - MAX_CONVERSATION_CONTEXT_MESSAGES);
  if (omittedMessageCount > 0) {
    chunks.push(`- ${omittedMessageCount} earlier messages omitted`);
  }

  for (const message of messages.slice(-MAX_CONVERSATION_CONTEXT_MESSAGES)) {
    const content = normalizeConversationContextText(message.content);
    if (!content) {
      continue;
    }

    const role = message.role === "assistant" ? "Assistant" : "User";
    const clippedContent = clipText(
      content,
      MAX_CONVERSATION_CONTEXT_CHARS_PER_MESSAGE,
      "...message truncated...",
    );
    const nextChunk = `${role}: ${clippedContent}`;
    const remainingChars = MAX_CONVERSATION_CONTEXT_CHARS - totalChars;
    if (remainingChars <= 0) {
      break;
    }

    const clippedChunk = clipText(nextChunk, remainingChars, "...conversation truncated...");
    chunks.push(clippedChunk);
    totalChars += clippedChunk.length + 1;
  }

  return chunks.join("\n");
}

function normalizeConversationContextText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function clipText(value: string, maxChars: number, marker: string): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - marker.length - 1)).trimEnd()}\n${marker}`;
}

function stripGeneratedCommitMessageDecorations(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  const withoutFence = fenced?.[1] ?? trimmed;
  const withoutPrefix = withoutFence.replace(/^commit message:\s*/i, "").trim();
  if (
    (withoutPrefix.startsWith('"') && withoutPrefix.endsWith('"')) ||
    (withoutPrefix.startsWith("'") && withoutPrefix.endsWith("'"))
  ) {
    return withoutPrefix.slice(1, -1);
  }
  return withoutPrefix;
}

function normalizeModelText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("模型响应缺少文本内容。");
  }
  return value.trim();
}
