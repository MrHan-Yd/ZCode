/* eslint-disable max-lines -- 表单字段、校验、标签交互与快捷键同属一个受控草稿，拆分会增加脏状态同步成本。 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Trash2, X } from "lucide-react";
import {
  PROMPT_LIBRARY_LIMITS,
  TID_SETTINGS_PROMPT_LIBRARY_CANCEL,
  TID_SETTINGS_PROMPT_LIBRARY_DELETE,
  TID_SETTINGS_PROMPT_LIBRARY_FORM,
  TID_SETTINGS_PROMPT_LIBRARY_FORM_ALIAS,
  TID_SETTINGS_PROMPT_LIBRARY_FORM_CONTENT,
  TID_SETTINGS_PROMPT_LIBRARY_FORM_NAME,
  TID_SETTINGS_PROMPT_LIBRARY_FORM_TAG_INPUT,
  TID_SETTINGS_PROMPT_LIBRARY_SAVE,
  type PromptTemplate,
  type PromptTemplateInput,
  type PromptTemplateSummary,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsFormTextarea } from "@/settings/SettingsFormTextarea.js";
import { SettingsFormActions } from "@/settings/SettingsFormActions.js";

const ALIAS_PATTERN = /^[a-zA-Z0-9_-]*$/;

function normalizeTagKey(tag: string): string {
  return tag.normalize("NFKC").trim().toLowerCase();
}

function buildTagsKey(tags: readonly string[]): string {
  return [...tags].map(normalizeTagKey).sort().join("\u0000");
}

function FieldHeader({
  label,
  counter,
  htmlFor,
  overLimit,
}: {
  label: string;
  counter?: string;
  htmlFor?: string;
  overLimit?: boolean;
}) {
  return (
    <div className="mb-1 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-ui-base font-medium text-foreground-subtle">
        {label}
      </label>
      {counter ? (
        <span
          className={cn(
            "shrink-0 text-ui-xs tabular-nums",
            overLimit ? "text-destructive" : "text-foreground-subtlest",
          )}
        >
          {counter}
        </span>
      ) : null}
    </div>
  );
}

interface PromptLibraryFormProps {
  initial: PromptTemplate | null;
  existingItems: readonly PromptTemplateSummary[];
  saving: boolean;
  readOnly: boolean;
  onSave: (input: PromptTemplateInput) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}

export function PromptLibraryForm({
  initial,
  existingItems,
  saving,
  readOnly,
  onSave,
  onCancel,
  onDelete,
  onDirtyChange,
}: PromptLibraryFormProps) {
  const { intl } = useZCodeIntl();
  const maxTitleLength = PROMPT_LIBRARY_LIMITS.maxTitleLength;
  const maxContentLength = PROMPT_LIBRARY_LIMITS.maxContentLength;
  const maxTags = PROMPT_LIBRARY_LIMITS.maxTags;
  const maxTagLength = PROMPT_LIBRARY_LIMITS.maxTagLength;
  const maxAliasLength = PROMPT_LIBRARY_LIMITS.maxAliasLength;

  const initialTitle = initial?.title ?? "";
  const initialContent = initial?.content ?? "";
  const initialTags = useMemo(() => initial?.tags ?? [], [initial]);
  const initialAlias = initial?.alias ?? "";

  const [title, setTitle] = useState(initialTitle);
  const [content, setContent] = useState(initialContent);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState("");
  const [alias, setAlias] = useState(initialAlias);
  const [submitted, setSubmitted] = useState(false);

  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const contentRef = useRef<HTMLTextAreaElement | null>(null);
  const aliasInputRef = useRef<HTMLInputElement | null>(null);

  const trimmedTitle = title.trim();
  const truncatedAlias = alias.trim();
  const normalizedAlias = truncatedAlias.toLowerCase();

  const titleOverLimit = title.length > maxTitleLength;
  const contentOverLimit = content.length > maxContentLength;
  const titleMissing = submitted && trimmedTitle.length === 0;
  const contentMissing = submitted && content.trim().length === 0;

  const aliasCharactersInvalid = truncatedAlias.length > 0 && !ALIAS_PATTERN.test(truncatedAlias);
  const aliasOverLimit = truncatedAlias.length > maxAliasLength;
  const aliasDuplicate =
    normalizedAlias.length > 0 &&
    existingItems.some(
      (item) =>
        item.id !== initial?.id && (item.alias ?? "").trim().toLowerCase() === normalizedAlias,
    );

  const titleError = titleMissing
    ? intl.formatMessage({ id: "settings.promptLibrary.form.name.validation.required" })
    : titleOverLimit
      ? intl.formatMessage(
          { id: "settings.promptLibrary.form.name.validation.tooLong" },
          { max: String(maxTitleLength) },
        )
      : null;
  const contentError = contentMissing
    ? intl.formatMessage({ id: "settings.promptLibrary.form.content.validation.required" })
    : contentOverLimit
      ? intl.formatMessage(
          { id: "settings.promptLibrary.form.content.validation.tooLong" },
          { max: String(maxContentLength) },
        )
      : null;
  const aliasError = aliasCharactersInvalid
    ? intl.formatMessage({
        id: "settings.promptLibrary.form.alias.validation.characters",
      })
    : aliasOverLimit
      ? intl.formatMessage(
          { id: "settings.promptLibrary.form.alias.validation.tooLong" },
          { max: String(maxAliasLength) },
        )
      : aliasDuplicate
        ? intl.formatMessage({
            id: "settings.promptLibrary.form.alias.validation.duplicate",
          })
        : null;

  const dirty =
    trimmedTitle !== initialTitle.trim() ||
    content !== initialContent ||
    buildTagsKey(tags) !== buildTagsKey(initialTags) ||
    normalizedAlias !== initialAlias.trim().toLowerCase();

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  const canSave =
    !readOnly &&
    !saving &&
    trimmedTitle.length > 0 &&
    !titleOverLimit &&
    content.trim().length > 0 &&
    !contentOverLimit &&
    !aliasCharactersInvalid &&
    !aliasOverLimit &&
    !aliasDuplicate;

  const commitTag = useCallback(() => {
    const nextTag = tagInput.trim();
    setTagInput("");
    if (!nextTag || nextTag.length > maxTagLength) {
      return;
    }
    setTags((current) => {
      if (current.length >= maxTags) {
        return current;
      }
      const nextKey = normalizeTagKey(nextTag);
      if (current.some((tag) => normalizeTagKey(tag) === nextKey)) {
        return current;
      }
      return [...current, nextTag];
    });
  }, [maxTagLength, maxTags, tagInput]);

  const removeTag = useCallback((tag: string) => {
    setTags((current) => current.filter((candidate) => candidate !== tag));
  }, []);

  const handleSubmit = useCallback(async () => {
    setSubmitted(true);
    // 用户可能正在标签输入框里输入但还未按 Enter；保存时把它一并提交，
    // 避免 Cmd/Ctrl+S 静默丢掉最后一个标签。
    const pendingTag = tagInput.trim();
    const effectiveTags =
      pendingTag.length > 0 &&
      pendingTag.length <= maxTagLength &&
      tags.length < maxTags &&
      !tags.some((tag) => normalizeTagKey(tag) === normalizeTagKey(pendingTag))
        ? [...tags, pendingTag]
        : tags;

    if (!canSave) {
      // 提交时聚焦第一个错误字段，方便键盘用户直接修正。
      if (trimmedTitle.length === 0 || titleOverLimit) {
        nameInputRef.current?.focus();
      } else if (content.trim().length === 0 || contentOverLimit) {
        contentRef.current?.focus();
      } else if (aliasError) {
        aliasInputRef.current?.focus();
      }
      return;
    }

    await onSave({
      title: trimmedTitle,
      // 正文按原样保存，不做 trim；只要求包含非空白字符。
      content,
      tags: effectiveTags,
      alias: normalizedAlias || undefined,
    });
  }, [
    aliasError,
    canSave,
    content,
    contentOverLimit,
    maxTagLength,
    maxTags,
    normalizedAlias,
    onSave,
    tagInput,
    tags,
    titleOverLimit,
    trimmedTitle,
  ]);

  const handleFormKeyDown = useCallback(
    (event: KeyboardEvent<HTMLFormElement>) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  const handleTagKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter" || event.key === "," || event.key === "，") {
        event.preventDefault();
        commitTag();
        return;
      }
      if (event.key === "Backspace" && tagInput.length === 0 && tags.length > 0) {
        event.preventDefault();
        setTags((current) => current.slice(0, -1));
      }
    },
    [commitTag, tagInput.length, tags.length],
  );

  return (
    <form
      data-testid={TID_SETTINGS_PROMPT_LIBRARY_FORM}
      onSubmit={(event) => {
        event.preventDefault();
        void handleSubmit();
      }}
      onKeyDown={handleFormKeyDown}
      className="space-y-4 rounded-xl border border-border p-4"
    >
      <div className="space-y-1.5">
        <FieldHeader
          label={intl.formatMessage({ id: "settings.promptLibrary.form.name.label" })}
          counter={`${title.length} / ${maxTitleLength}`}
          htmlFor="prompt-library-name"
          overLimit={titleOverLimit}
        />
        <Input
          ref={nameInputRef}
          id="prompt-library-name"
          type="text"
          size="lg"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          disabled={readOnly || saving}
          aria-invalid={titleError ? true : undefined}
          aria-describedby={titleError ? "prompt-library-name-error" : undefined}
          className="text-mobile-input-safe md:text-ui-base"
          data-testid={TID_SETTINGS_PROMPT_LIBRARY_FORM_NAME}
        />
        {titleError ? (
          <p id="prompt-library-name-error" className="text-ui-base text-destructive">
            {titleError}
          </p>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <FieldHeader
          label={intl.formatMessage({ id: "settings.promptLibrary.form.content.label" })}
          counter={`${content.length} / ${maxContentLength}`}
          htmlFor="prompt-library-content"
          overLimit={contentOverLimit}
        />
        <SettingsFormTextarea
          ref={contentRef}
          id="prompt-library-content"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder={intl.formatMessage({
            id: "settings.promptLibrary.form.content.placeholder",
          })}
          disabled={readOnly || saving}
          aria-invalid={contentError ? true : undefined}
          aria-describedby={contentError ? "prompt-library-content-error" : undefined}
          className="min-h-40 max-h-[50vh] text-mobile-input-safe md:text-ui-base"
          data-testid={TID_SETTINGS_PROMPT_LIBRARY_FORM_CONTENT}
        />
        {contentError ? (
          <p id="prompt-library-content-error" className="text-ui-base text-destructive">
            {contentError}
          </p>
        ) : null}
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.promptLibrary.form.content.helper" })}
        </p>
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.promptLibrary.form.content.sendHint" })}
        </p>
      </div>

      <div className="space-y-1.5">
        <FieldHeader
          label={intl.formatMessage(
            { id: "settings.promptLibrary.form.tags.label" },
            { max: String(maxTags) },
          )}
          htmlFor="prompt-library-tags"
        />
        {tags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex h-6 items-center gap-1 rounded-md bg-surface px-2 text-ui-sm text-foreground-subtle"
              >
                {tag}
                <button
                  type="button"
                  className="rounded-sm text-foreground-subtlest hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  aria-label={intl.formatMessage(
                    { id: "settings.promptLibrary.form.tags.remove" },
                    { tag },
                  )}
                  disabled={readOnly || saving}
                  onClick={() => removeTag(tag)}
                >
                  <X className="size-3" aria-hidden="true" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <Input
          id="prompt-library-tags"
          type="text"
          size="lg"
          value={tagInput}
          onChange={(event) => setTagInput(event.target.value)}
          onKeyDown={handleTagKeyDown}
          onBlur={commitTag}
          maxLength={maxTagLength}
          disabled={readOnly || saving || tags.length >= maxTags}
          placeholder={intl.formatMessage({
            id: "settings.promptLibrary.form.tags.placeholder",
          })}
          className="text-mobile-input-safe md:text-ui-base"
          data-testid={TID_SETTINGS_PROMPT_LIBRARY_FORM_TAG_INPUT}
        />
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage({ id: "settings.promptLibrary.form.tags.hint" })}
        </p>
      </div>

      <div className="space-y-1.5">
        <FieldHeader
          label={intl.formatMessage({ id: "settings.promptLibrary.form.alias.label" })}
          counter={`${truncatedAlias.length} / ${maxAliasLength}`}
          htmlFor="prompt-library-alias"
          overLimit={aliasOverLimit}
        />
        <Input
          ref={aliasInputRef}
          id="prompt-library-alias"
          type="text"
          size="lg"
          value={alias}
          onChange={(event) => setAlias(event.target.value)}
          disabled={readOnly || saving}
          maxLength={maxAliasLength}
          aria-invalid={aliasError ? true : undefined}
          aria-describedby={aliasError ? "prompt-library-alias-error" : undefined}
          placeholder={intl.formatMessage({
            id: "settings.promptLibrary.form.alias.placeholder",
          })}
          className="font-mono text-mobile-input-safe md:text-ui-base"
          data-testid={TID_SETTINGS_PROMPT_LIBRARY_FORM_ALIAS}
        />
        {aliasError ? (
          <p id="prompt-library-alias-error" className="text-ui-base text-destructive">
            {aliasError}
          </p>
        ) : null}
        <p className="text-ui-sm text-foreground-subtlest">
          {intl.formatMessage(
            { id: "settings.promptLibrary.form.alias.hint" },
            { alias: normalizedAlias || "review" },
          )}
        </p>
      </div>

      <div className="sticky bottom-0 -mx-4 border-t border-border bg-background px-4 pb-[env(safe-area-inset-bottom)] pt-2 md:static md:mx-0 md:border-0 md:bg-transparent md:p-0">
        <SettingsFormActions
          leadingAction={
            initial && onDelete ? (
              <Button
                type="button"
                variant="link"
                size="lg"
                className="h-11 px-0 text-destructive hover:text-destructive sm:h-8"
                onClick={onDelete}
                disabled={saving || readOnly}
                data-testid={TID_SETTINGS_PROMPT_LIBRARY_DELETE}
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "common.delete" })}
              </Button>
            ) : undefined
          }
        >
          <Button
            type="submit"
            variant="default"
            size="lg"
            disabled={!canSave || saving}
            data-testid={TID_SETTINGS_PROMPT_LIBRARY_SAVE}
            className="h-11 sm:h-8"
          >
            {saving
              ? intl.formatMessage({ id: "common.saving" })
              : intl.formatMessage({ id: "common.save" })}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="lg"
            onClick={onCancel}
            disabled={saving}
            data-testid={TID_SETTINGS_PROMPT_LIBRARY_CANCEL}
            className="h-11 sm:h-8"
          >
            {intl.formatMessage({ id: "common.cancel" })}
          </Button>
        </SettingsFormActions>
      </div>
    </form>
  );
}
