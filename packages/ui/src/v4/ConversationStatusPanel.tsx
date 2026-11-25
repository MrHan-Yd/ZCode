/* oxlint-disable eslint(max-lines) -- 会话状态卡片的分区组件与折叠策略集中在同文件，保证 Goal/计划/进程/终端/工作流/编排/智能体共享同一套内容与排序规则。 */
import {
  Fragment,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleCheckBigIcon,
  CircleIcon,
  CircleSlashIcon,
  GoalIcon,
  ListChecksIcon,
  PauseIcon,
  PlayIcon,
  RotateCcwIcon,
  SquareIcon,
  SquareTerminalIcon,
  Workflow,
  XIcon,
} from "lucide-react";
import {
  TID_CHAT_STATUS_SECTIONS_PANEL,
  TID_V4_BACKGROUND_WORK_CANCEL,
  TID_V4_BACKGROUND_WORK_ITEM,
  testId,
} from "@zcode/shared";
import type { ZCodeSessionRunningSubagent } from "@zcode/shared";
import type {
  BackgroundWorkSummary,
  GoalState,
  OrchestrationRunProjection,
  OrchestrationStepProjection,
  PlanState,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import {
  RUN_STATUS_DOT,
  RUN_STATUS_TEXT,
} from "@/components/workflow-graph/run-status-presentation.js";
import { useNowTicker } from "@/components/workflow-graph/use-now-ticker.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card.js";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { formatBackgroundTaskElapsedLabel } from "@/BackgroundTaskElapsedLabel.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type {
  OpenPlanDetailSideTabRequest,
  OpenSubagentDirectorySideTabRequest,
  OpenSubagentSideTabRequest,
  OpenWorkflowRunDirectorySideTabRequest,
} from "@/lib/workspaceSidePane.js";
import {
  buildConversationStatusPanelModel,
  type ConversationStatusPanelRunningSubagent,
  type ConversationStatusPanelModel,
  type ConversationStatusPanelOrchestrationRun,
  type ConversationStatusPanelSessionPlanItem,
  type ConversationStatusPanelWorkflowRun,
} from "@/v4/conversationStatusPanelModel.js";
import type { ConversationStatusPanelWorkflowRunTarget } from "@/v4/conversationStatusPanelModel.js";
import { workflowRunOpenTarget } from "@/v4/conversationStatusPanelModel.js";
import { formatSessionSpeedValue } from "@/v4/composer/sessionStatsSpeeds.js";
import {
  resolveLongestRunningSubagent,
  resolveSubagentSpeedPollIds,
  resolveSubagentSpeedReadings,
} from "@/v4/subagentSpeeds.js";
import {
  SUBAGENT_STATUS_ORDER,
  countSubagentStatuses,
  hasSubagentStatusSummary,
  sortRunningSubagentsByStatus,
} from "@/v4/subagentStatusModel.js";
import { resolveSubagentDisplayName } from "@/lib/subagentName.js";
import { SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { useSubagentColorResolver } from "@/hooks/useSubagentColorResolver.js";
import { useSessionPerformanceBatch } from "@/hooks/useSessionPerformanceBatch.js";
import {
  buildConversationGoalIterationSummaries,
  getConversationGoalElapsedSeconds,
} from "@/v4/conversationGoalSummaryModel.js";

interface ConversationStatusPanelProps {
  workspacePath: string;
  workspaceIdentity?: string;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly ZCodeSessionRunningSubagent[];
  /** 本会话 `snapshot.workflowRuns.runs`；与 backgroundWorks 在模型层按 workId ≡ runId 联接。 */
  workflowRuns?: readonly WorkflowRunState[];
  /** 活动编排 run 的只读投影（`orchestrationState`）；计划分区不持有第二份 run 状态。 */
  orchestrationRuns?: readonly OrchestrationRunProjection[];
  /**
   * 已结束的 workflow run 条数（journal 口径，`countEndedWorkflowRuns`）。
   * 面板不自己算：它手上的投影是 memory-only 的活状态，重启后为空，而这条计数恰恰要在重启后
   * 仍然正确。
   */
  endedWorkflowRunCount?: number;
  endedSubagentCount?: number;
  rootSessionId?: string;
  parentSessionId?: string;
  /** 面板是否打开：由标题栏「会话状态」图标的握手状态驱动。 */
  open: boolean;
  /** 面板自己的关闭按钮。 */
  onClose?: () => void;
  goalSectionOpen?: boolean;
  onGoalSectionOpenChange?: (open: boolean) => void;
  planSectionOpen?: boolean;
  onPlanSectionOpenChange?: (open: boolean) => void;
  terminalSectionOpen?: boolean;
  onTerminalSectionOpenChange?: (open: boolean) => void;
  agentSectionOpen?: boolean;
  onAgentSectionOpenChange?: (open: boolean) => void;
  workflowSectionOpen?: boolean;
  onWorkflowSectionOpenChange?: (open: boolean) => void;
  orchestrationSectionOpen?: boolean;
  onOrchestrationSectionOpenChange?: (open: boolean) => void;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  onOpenWorkflowRunDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  onStopOrchestrationRun?: (runId: string) => void;
  /** 只取消当前 run 并聚焦同一个输入框；不弹第二个输入框、不代发消息。 */
  onRequestOrchestrationReplan?: () => void;
}

// memo 组件默认 props 不内联创建数组，避免每次渲染生成新引用触发稳定引用边界测试。
const EMPTY_BACKGROUND_WORKS: readonly BackgroundWorkSummary[] = [];
const EMPTY_RUNNING_SUBAGENTS: readonly ZCodeSessionRunningSubagent[] = [];
const EMPTY_WORKFLOW_RUNS: readonly WorkflowRunState[] = [];
const EMPTY_ORCHESTRATION_RUNS: readonly OrchestrationRunProjection[] = [];

function formatDurationUnits(
  totalSeconds: number,
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const restSeconds = seconds % 60;
  const hourUnit = formatMessage({ id: "chat.summaryPanel.duration.hours" });
  const minuteUnit = formatMessage({ id: "chat.summaryPanel.duration.minutes" });
  const secondUnit = formatMessage({ id: "chat.summaryPanel.duration.seconds" });
  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}${hourUnit}`);
  }
  if (minutes > 0) {
    parts.push(`${minutes}${minuteUnit}`);
  }
  if (restSeconds > 0 || parts.length === 0) {
    parts.push(`${restSeconds}${secondUnit}`);
  }
  return parts.join(" ");
}

function getBackgroundWorkElapsedMs(work: BackgroundWorkSummary, now: number) {
  return Math.max(0, now - work.startedAt);
}

function getLongestRunningWorkElapsedMs(works: readonly BackgroundWorkSummary[], now: number) {
  return works.reduce(
    (longestElapsedMs, work) => Math.max(longestElapsedMs, getBackgroundWorkElapsedMs(work, now)),
    0,
  );
}

function formatRunningCount(
  formatMessage: ReturnType<typeof useZCodeIntl>["intl"]["formatMessage"],
  count: number,
) {
  return formatMessage(
    {
      id:
        count === 1
          ? "chat.summaryPanel.runningBackgroundTasksMiniValue"
          : "chat.summaryPanel.runningBackgroundTasksMiniValuePlural",
    },
    { count: String(count) },
  );
}

type StatusSectionKind =
  | "environment"
  | "goal"
  | "sessionPlans"
  | "plan"
  | "orchestration"
  | "terminal"
  | "workflow"
  | "agent";

function StatusSectionHeader({
  children,
  isOpen,
  section,
  separated,
  title,
}: {
  children?: ReactNode;
  isOpen: boolean;
  section: StatusSectionKind;
  separated: boolean;
  title: string;
}) {
  // 分区头是整个面板唯一的「我在哪」锚点：分区不再各自限高滚动后，
  // 标题必须粘在视口顶部，滚过的行被不透明底色遮住；否则长列表里只剩一片行。
  return (
    <div
      className={cn(
        "sticky top-0 z-10 -mx-2 flex h-7 min-w-0 shrink-0 items-center gap-1.5 border-b border-[var(--color-border)]/50 bg-[var(--color-popover)] px-2 pr-8",
        separated && "border-t",
      )}
    >
      <CollapsibleTrigger asChild>
        <button
          type="button"
          aria-expanded={isOpen}
          data-status-section-trigger={section}
          className="group -ml-1 flex h-6 min-w-0 shrink-0 items-center gap-1 rounded-md px-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-input-border-focused)]"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-[var(--color-foreground-subtle)] opacity-60 transition-transform duration-150 group-hover:opacity-100 group-focus-visible:opacity-100",
              isOpen && "rotate-90",
            )}
          />
          <span className="shrink-0 text-ui-base font-medium text-[var(--color-foreground-subtle)] group-hover:text-[var(--color-foreground)]">
            {title}
          </span>
        </button>
      </CollapsibleTrigger>
      {children ? (
        <div className="inline-flex min-w-0 max-w-full shrink items-center gap-1.5 text-ui-sm text-[var(--color-foreground-subtlest)]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function StatusSection({
  children,
  defaultOpen = true,
  onOpenChange,
  open,
  separated = false,
  section,
  title,
  trailing,
}: {
  children: ReactNode;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated?: boolean;
  section: StatusSectionKind;
  title: string;
  trailing?: (isOpen: boolean) => ReactNode;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const isControlled = open !== undefined;
  const isOpen = open ?? uncontrolledOpen;
  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlled) {
        setUncontrolledOpen(nextOpen);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlled, onOpenChange],
  );

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={handleOpenChange}
      data-status-section={section}
      className="min-w-0 flex-none"
    >
      <section className="min-w-0 flex-none">
        <StatusSectionHeader isOpen={isOpen} section={section} separated={separated} title={title}>
          {trailing?.(isOpen)}
        </StatusSectionHeader>
        {/* 滚动只发生在面板唯一的视口里；分区内容不再限高，也不再自带 overflow。 */}
        <CollapsibleContent>
          <div className="pb-2">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  );
}

function GoalStatusSection({
  model,
  onOpenChange,
  open,
  onPauseGoal,
  onResumeGoal,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  onPauseGoal?: () => void;
  onResumeGoal?: () => void;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const goal = model.goal;
  const isPausable =
    goal?.status === "active" || goal?.status === "verifying" || goal?.status === "notSatisfied";
  const isPaused = goal?.status === "paused";
  const isDone = goal?.status === "verified";
  const iterationRows = useMemo(
    () => (goal ? buildConversationGoalIterationSummaries(goal) : []),
    [goal],
  );
  // 用时秒针只看「有没有在跑」这一个布尔。effect 不能以整个 goal 对象为依赖：
  // 每个 goal 事件都同步 setNow 并重建 interval——落在投影帧的同步提交里，给 React 的嵌套更新计数
  // 记一笔（与工作流卡 React #185 崩溃同形）。
  const now = useNowTicker(isPausable && goal?.activeRunStartedAtMs != null);

  if (!goal) return null;

  const elapsed = formatDurationUnits(
    getConversationGoalElapsedSeconds(goal, now),
    intl.formatMessage,
  );
  const control = isPausable ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.pause" })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        data-goal-action="pause"
        disabled={!onPauseGoal}
        aria-label={intl.formatMessage({ id: "chat.target.pause" })}
        onClick={onPauseGoal}
      >
        <PauseIcon className="size-3.5" />
      </Button>
    </ControlHintTooltip>
  ) : isPaused ? (
    <ControlHintTooltip title={intl.formatMessage({ id: "chat.target.resume" })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        className="size-6 shrink-0"
        data-goal-action="resume"
        disabled={!onResumeGoal}
        aria-label={intl.formatMessage({ id: "chat.target.resume" })}
        onClick={onResumeGoal}
      >
        <PlayIcon className="size-3.5" />
      </Button>
    </ControlHintTooltip>
  ) : isDone ? (
    <CircleCheckBigIcon
      aria-label={intl.formatMessage({ id: "chat.goalVerification.complete" })}
      className="size-4 shrink-0 text-[var(--color-success)]"
    />
  ) : null;

  return (
    <StatusSection
      section="goal"
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.goal" })}
      trailing={() => (
        <>
          <span
            className="shrink-0 tabular-nums"
            data-goal-elapsed-seconds={getConversationGoalElapsedSeconds(goal, now)}
          >
            {elapsed}
          </span>
          {control ? <span className="shrink-0">·</span> : null}
          {control}
        </>
      )}
    >
      <div className="space-y-0">
        {iterationRows.map((row) => {
          const title =
            row.title ??
            intl.formatMessage(
              { id: "chat.summaryPanel.goalIterationValue" },
              { count: String(row.iteration) },
            );
          return (
            <div
              key={row.iteration}
              data-goal-iteration={row.iteration}
              data-goal-iteration-completed={row.completed}
              data-goal-verification-outcome={row.verificationOutcome ?? undefined}
              className="flex min-w-0 cursor-default items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]"
              title={title}
            >
              {row.completed ? (
                <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-[var(--color-success)] text-ui-xs tabular-nums text-[var(--color-success)]">
                  {row.iteration}
                </span>
              ) : (
                <GoalIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              )}
              <p className="line-clamp-3 min-w-0 flex-1 text-ui-base leading-4 text-[var(--color-foreground)]">
                {title}
              </p>
              {row.totalCount > 0 ? (
                <span className="shrink-0 text-ui-sm tabular-nums text-[var(--color-foreground-subtle)]">
                  {row.completedCount}/{row.totalCount}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </StatusSection>
  );
}

function PlanStatusIcon({ status }: { status: PlanState["items"][number]["status"] }) {
  if (status === "completed") {
    return (
      <CheckCircle2Icon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-success)]"
      />
    );
  }
  if (status === "inProgress") {
    return (
      <ArrowRightIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-[var(--color-foreground)]"
      />
    );
  }
  return (
    <CircleIcon
      aria-hidden
      className="mt-0.5 size-3.5 shrink-0 text-[var(--color-foreground-subtlest)]"
    />
  );
}

const COMPACT_TODO_THRESHOLD = 6;
const TODO_FOCUS_WINDOW_SIZE = 3;

interface StatusPanelTodoFocusWindow {
  compact: boolean;
  precedingItems: PlanState["items"];
  focusItems: PlanState["items"];
  followingItems: PlanState["items"];
}

function getStatusPanelTodoFocusWindow(items: PlanState["items"]): StatusPanelTodoFocusWindow {
  if (items.length <= COMPACT_TODO_THRESHOLD) {
    return {
      compact: false,
      precedingItems: [],
      focusItems: items,
      followingItems: [],
    };
  }

  const runningIndex = items.findIndex((item) => item.status === "inProgress");
  const firstUnfinishedIndex = items.findIndex((item) => item.status !== "completed");
  const focusIndex =
    runningIndex >= 0
      ? runningIndex
      : firstUnfinishedIndex >= 0
        ? firstUnfinishedIndex
        : Math.max(0, items.length - TODO_FOCUS_WINDOW_SIZE);
  // 只取“当前 + 后两条”会让靠近列表末尾的当前项只剩一两条上下文。
  // 从前面回补可以让精简窗口在项目数足够时始终保持三条，同时不改变 snapshot 原序。
  const focusStartIndex = Math.max(0, Math.min(focusIndex, items.length - TODO_FOCUS_WINDOW_SIZE));
  const focusEndIndex = Math.min(items.length, focusStartIndex + TODO_FOCUS_WINDOW_SIZE);

  return {
    compact: true,
    precedingItems: items.slice(0, focusStartIndex),
    focusItems: items.slice(focusStartIndex, focusEndIndex),
    followingItems: items.slice(focusEndIndex),
  };
}

function PlanStatusItemRows({ items }: { items: PlanState["items"] }) {
  return items.map((item) => (
    <li
      key={item.id}
      data-plan-status={item.status}
      className="flex min-h-8 items-start gap-2 rounded-lg px-2 py-1.5 text-ui-base hover:bg-[var(--color-hover)]"
    >
      <PlanStatusIcon status={item.status} />
      <span
        title={item.content}
        className={cn(
          "line-clamp-2 min-w-0 flex-1 break-words leading-5",
          item.status === "completed"
            ? "text-[var(--color-foreground-subtlest)] line-through"
            : "text-[var(--color-foreground)]",
        )}
      >
        {item.content}
      </span>
    </li>
  ));
}

const TodoPreviewTrigger = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & {
    group: "preceding" | "following";
    label: string;
    open: boolean;
    onTouchOpen: () => void;
  }
>(function TodoPreviewTrigger({ group, label, onClick, onTouchOpen, open, ...buttonProps }, ref) {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type="button"
      aria-expanded={open}
      data-status-todo-preview-trigger={group}
      className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 text-left text-ui-base text-[var(--color-foreground-subtle)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
      onClick={(event) => {
        onClick?.(event);
        // HoverCard 在桌面由 hover/focus 驱动；仅无 hover 输入补充点击打开，
        // 避免桌面点击把已经由 hover 打开的预览反向关闭。
        if (
          !event.defaultPrevented &&
          typeof window !== "undefined" &&
          window.matchMedia?.("(hover: none)").matches
        ) {
          onTouchOpen();
        }
      }}
    >
      <ChevronLeftIcon className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
});

type TodoPreviewGroup = "preceding" | "following";

function TodoHiddenGroupPreview({
  group,
  items,
  onOpenChange,
  open,
  popoverSide,
}: {
  group: TodoPreviewGroup;
  items: PlanState["items"];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  popoverSide: "bottom" | "left";
}) {
  const { intl } = useZCodeIntl();
  const messageId =
    group === "preceding"
      ? items.every((item) => item.status === "completed")
        ? "chat.statusPanel.todoCompletedFold"
        : "chat.statusPanel.todoEarlierFold"
      : items.every((item) => item.status === "pending")
        ? "chat.statusPanel.todoWaitingFold"
        : "chat.statusPanel.todoLaterFold";
  const label = intl.formatMessage({ id: messageId }, { count: String(items.length) });

  return (
    <HoverCard closeDelay={80} open={open} openDelay={120} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>
        <TodoPreviewTrigger
          group={group}
          label={label}
          open={open}
          onTouchOpen={() => onOpenChange(true)}
        />
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        side={popoverSide}
        sideOffset={4}
        data-status-todo-preview-content={group}
        className="w-80 max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-[var(--color-popover-border)] bg-[var(--color-menu)] p-3 shadow-md ring-0"
      >
        <div className="flex max-h-[min(24rem,calc(100dvh-2rem))] min-w-0 flex-col">
          <p className="flex h-8 shrink-0 items-center px-2 text-ui-base text-[var(--color-foreground-subtle)]">
            {label}
          </p>
          <ul className="min-h-0 space-y-0 overflow-y-auto pr-1">
            <PlanStatusItemRows items={items} />
          </ul>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

function PlanStatusItems({
  plan,
  popoverSide,
}: {
  plan: NonNullable<ConversationStatusPanelModel["plan"]>;
  popoverSide: "bottom" | "left";
}) {
  const [openPreviewGroup, setOpenPreviewGroup] = useState<TodoPreviewGroup | null>(null);
  const window = getStatusPanelTodoFocusWindow(plan.displayItems);
  const handlePreviewOpenChange = (group: TodoPreviewGroup, open: boolean) => {
    setOpenPreviewGroup((current) => (open ? group : current === group ? null : current));
  };

  return (
    <ul className="space-y-0 pb-1">
      {window.compact && window.precedingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            group="preceding"
            items={window.precedingItems}
            open={openPreviewGroup === "preceding"}
            onOpenChange={(open) => handlePreviewOpenChange("preceding", open)}
            popoverSide={popoverSide}
          />
        </li>
      ) : null}
      <PlanStatusItemRows items={window.focusItems} />
      {window.compact && window.followingItems.length > 0 ? (
        <li>
          <TodoHiddenGroupPreview
            group="following"
            items={window.followingItems}
            open={openPreviewGroup === "following"}
            onOpenChange={(open) => handlePreviewOpenChange("following", open)}
            popoverSide={popoverSide}
          />
        </li>
      ) : null}
    </ul>
  );
}

function SessionPlansStatusSection({
  model,
  onOpenPlanDetail,
  parentSessionId,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onOpenPlanDetail?: (request: OpenPlanDetailSideTabRequest) => void;
  parentSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const sessionPlans = model.sessionPlans;
  if (!sessionPlans) return null;

  return (
    <StatusSection
      section="sessionPlans"
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.sessionPlans" })}
    >
      <ul className="space-y-0">
        {sessionPlans.items.map((item) => {
          const title = item.title ?? intl.formatMessage({ id: "chat.statusPanel.planFallback" });
          const canOpen = Boolean(parentSessionId && onOpenPlanDetail);
          return (
            <li key={item.toolCallId}>
              <button
                type="button"
                data-plan-directory-tool-call-id={item.toolCallId}
                disabled={!canOpen}
                aria-label={intl.formatMessage({ id: "chat.statusPanel.openPlan" }, { title })}
                onClick={() => {
                  if (!parentSessionId) return;
                  onOpenPlanDetail?.(buildSessionPlanOpenRequest(parentSessionId, item));
                }}
                className={cn(
                  "flex min-h-8 w-full min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-ui-base text-[var(--color-foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]",
                  canOpen && "hover:bg-[var(--color-hover)]",
                )}
              >
                <ListChecksIcon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </StatusSection>
  );
}

function buildSessionPlanOpenRequest(
  parentSessionId: string,
  item: ConversationStatusPanelSessionPlanItem,
): OpenPlanDetailSideTabRequest {
  return {
    parentSessionId,
    toolCallId: item.toolCallId,
    markdown: item.markdown,
    ...(item.planFilePath ? { planFilePath: item.planFilePath } : {}),
  };
}

function PlanStatusSection({
  model,
  onOpenChange,
  open,
  popoverSide,
  separated,
}: {
  model: ConversationStatusPanelModel;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  popoverSide: "bottom" | "left";
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const plan = model.plan;
  if (!plan) return null;
  const isCompleted = plan.totalCount > 0 && plan.completedCount >= plan.totalCount;

  return (
    <StatusSection
      section="plan"
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={intl.formatMessage({ id: "chat.statusPanel.todo" })}
      trailing={() => (
        <span
          className={cn(
            "tabular-nums",
            isCompleted ? "text-[var(--color-success)]" : "text-[var(--color-foreground-subtle)]",
          )}
        >
          {plan.completedCount}/{plan.totalCount}
        </span>
      )}
    >
      <PlanStatusItems
        key={plan.displayItems
          .map((item) => `${item.id}\u0000${item.content}\u0000${item.status}`)
          .join("\u0001")}
        plan={plan}
        popoverSide={popoverSide}
      />
    </StatusSection>
  );
}

function RunningWorkCancelButton({
  workId,
  onCancel,
}: {
  workId: string;
  onCancel?: (workId: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      onCancel?.(workId);
    },
    [onCancel, workId],
  );

  if (!onCancel) return null;

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-testid={testId(TID_V4_BACKGROUND_WORK_CANCEL, workId)}
      aria-label={intl.formatMessage({
        id: "chat.summaryPanel.stopRunningBackgroundTask",
      })}
      onClick={handleClick}
      className="pointer-events-auto relative z-[2] ml-auto h-6 shrink-0 px-1.5 text-ui-base text-[var(--color-foreground)]"
    >
      <SquareIcon aria-hidden className="size-3 fill-current" />
      {intl.formatMessage({ id: "chat.statusPanel.runningStop" })}
    </Button>
  );
}

function buildRunningSubagentOpenRequest({
  parentSessionId,
  rootSessionId,
  subagent,
}: {
  parentSessionId?: string;
  rootSessionId?: string;
  subagent: ZCodeSessionRunningSubagent;
}): OpenSubagentSideTabRequest | null {
  if (!parentSessionId) return null;
  return {
    rootSessionId: rootSessionId ?? parentSessionId,
    parentSessionId,
    childSessionId: subagent.childSessionId,
    subagentType: subagent.subagentType,
    title: subagent.title,
  };
}

function RunningStatusItem({
  now,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  work,
}: {
  now: number;
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  work: BackgroundWorkSummary;
}) {
  const { intl } = useZCodeIntl();

  return (
    <li
      data-testid={testId(TID_V4_BACKGROUND_WORK_ITEM, work.workId)}
      data-background-task-kind={work.kind}
      data-work-id={work.workId}
      data-work-status={work.status}
      className="group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]"
    >
      {onOpenBackgroundBash ? (
        <button
          type="button"
          className="absolute inset-0 rounded-lg focus-visible:outline-ring"
          aria-label={intl.formatMessage({ id: "bashOutput.open" }, { title: work.title })}
          data-testid="background-bash-open"
          onClick={() => onOpenBackgroundBash(work)}
        />
      ) : null}
      <SquareTerminalIcon className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
      <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
          {work.title}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
          <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
            {formatBackgroundTaskElapsedLabel(
              getBackgroundWorkElapsedMs(work, now),
              intl.formatMessage,
            )}
          </span>
          {work.cancellable !== false ? (
            <RunningWorkCancelButton workId={work.workId} onCancel={onCancelBackgroundWork} />
          ) : null}
        </div>
      </div>
    </li>
  );
}

function BackgroundWorkStatusSection({
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenChange,
  open,
  separated,
  section,
  title,
  works,
}: {
  onOpenBackgroundBash?: (work: BackgroundWorkSummary) => void;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  separated: boolean;
  section: "terminal" | "agent";
  title: string;
  works: readonly BackgroundWorkSummary[];
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  const orderedRunningWorks = useMemo(
    () => [...works].sort((left, right) => left.startedAt - right.startedAt),
    [works],
  );

  useEffect(() => {
    if (works.length === 0) {
      return;
    }
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [works.length]);

  if (works.length === 0) return null;

  const collapsedElapsedLabel = formatDurationUnits(
    Math.max(1, Math.floor(getLongestRunningWorkElapsedMs(works, now) / 1000)),
    intl.formatMessage,
  );

  return (
    <StatusSection
      section={section}
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          <span>
            {intl.formatMessage(
              {
                id:
                  works.length === 1
                    ? "chat.statusPanel.runningStatusValue"
                    : "chat.statusPanel.runningStatusValuePlural",
              },
              { count: String(works.length) },
            )}
          </span>
        ) : (
          <>
            <span className="min-w-0 truncate">{collapsedElapsedLabel}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{formatRunningCount(intl.formatMessage, works.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {orderedRunningWorks.map((work) => (
          <RunningStatusItem
            key={work.workId}
            work={work}
            now={now}
            onOpenBackgroundBash={onOpenBackgroundBash}
            onCancelBackgroundWork={onCancelBackgroundWork}
          />
        ))}
      </ul>
    </StatusSection>
  );
}

/**
 * Workflows 分区：与 Terminals / Agents 并列的第三类实时活动，**外加**一条通往 run 目录的
 * 页脚行——已结束的 run 折进这条页脚行，不占活动列表的位置。
 *
 * 行的字段分三簇（见 `ConversationStatusPanelWorkflowRun`），渲染逐簇独立缺席：
 * - 无 `status`：偏斜降级行（旧 CLI 没有 workflowRuns 投影键），没有状态词与步数；
 * - 无 `startedAt`：run 还没有配对的后台任务，没有时长；
 * - 无 `workId`：停不了，不出 Stop。
 * 把它们并成一个「有没有 work」的布尔就会漏掉偏斜形态——这三簇正是偏斜的全部表现。
 *
 * **不排序**：顺序 = 投影 runs 序 = 启动序（模型层已经保证）。Terminals / Agents 按
 * startedAt 排是因为它们的投影无序；这里重排反而会让行在每次投影更新时跳位。
 */
function WorkflowStatusSection({
  endedRunCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenDirectory,
  onOpenWorkflowRun,
  open,
  parentSessionId,
  runs,
  separated,
  title,
}: {
  endedRunCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenDirectory?: (request: OpenWorkflowRunDirectorySideTabRequest) => void;
  onOpenWorkflowRun?: (target: ConversationStatusPanelWorkflowRunTarget) => void;
  open?: boolean;
  parentSessionId?: string;
  runs: readonly ConversationStatusPanelWorkflowRun[];
  separated: boolean;
  title: string;
}) {
  const { intl } = useZCodeIntl();
  const [now, setNow] = useState(() => Date.now());
  // 只有带 startedAt 的行需要秒级刷新；一行都没有时不必让面板每秒重渲染。
  const tickingRunCount = runs.filter((run) => run.startedAt !== undefined).length;
  useEffect(() => {
    if (tickingRunCount === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [tickingRunCount]);

  // 活动行与已结束计数**都**为零才收起整个分区：只按活动数开门的那一版，重启后一个 run
  // 都不在跑，于是入口连带目录页一起消失——而重启后回看被打断的 run 正是它的主要用途。
  if (runs.length === 0 && endedRunCount <= 0) return null;

  const longestElapsedMs = runs.reduce(
    (longest, run) =>
      run.startedAt === undefined ? longest : Math.max(longest, Math.max(0, now - run.startedAt)),
    0,
  );
  const openLabel = intl.formatMessage({ id: "chat.toolCall.workflow.openRunDetails" });

  return (
    <StatusSection
      section="workflow"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        isOpen ? (
          <span>
            {intl.formatMessage(
              {
                // 复用 Terminals 的计数文案而不是 Agents 的：workflow run 确实是一条后台任务
                // （它有自己的 BackgroundWorkSummary），而 subagent 可能是前台的，那条文案
                // 才需要把语义放宽成「运行」。
                id:
                  runs.length === 1
                    ? "chat.statusPanel.runningStatusValue"
                    : "chat.statusPanel.runningStatusValuePlural",
              },
              { count: String(runs.length) },
            )}
          </span>
        ) : (
          <>
            {/* 一行都没有 startedAt 时收起态只剩计数：宁可少一段，也不显示一个 0 秒的假时长。 */}
            {longestElapsedMs > 0 ? (
              <>
                <span className="min-w-0 truncate">
                  {formatDurationUnits(
                    Math.max(1, Math.floor(longestElapsedMs / 1000)),
                    intl.formatMessage,
                  )}
                </span>
                <span className="shrink-0">·</span>
              </>
            ) : null}
            <span className="shrink-0">{formatRunningCount(intl.formatMessage, runs.length)}</span>
          </>
        )
      }
    >
      <ul className="space-y-0">
        {runs.map((run) => {
          // 行 → 打开意图的换算与 composer 徽标直达共用（模型层 workflowRunOpenTarget）。
          const openTarget = onOpenWorkflowRun ? workflowRunOpenTarget(run) : null;
          const canOpen = openTarget !== null;
          // 未命名的判定：`title ≡ workId`（≡ runId）就是 core 的 workflowTaskSubject 兜底到
          // taskId 的样子，投影会把非空 description 原样抄进 title。降级行的 runId 也 ≡ workId，
          // 所以一次比较覆盖两簇。
          const displayName =
            run.title && run.title !== run.runId
              ? run.title
              : intl.formatMessage({ id: "chat.toolCall.workflow.fallbackName" });
          return (
            <li
              key={run.runId}
              data-testid={run.workId ? testId(TID_V4_BACKGROUND_WORK_ITEM, run.workId) : undefined}
              data-background-task-kind="workflow"
              data-workflow-run-id={run.runId}
              data-work-id={run.workId}
              data-work-status={run.status}
              className={cn(
                "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]",
                canOpen && "cursor-pointer",
              )}
            >
              {openTarget ? (
                // 与 Agent 行同款：行里已经有 Stop 这个嵌套交互，整行 button 会套出嵌套按钮。
                // 透明同级按钮承接「打开详情页」，Stop 保持独立交互层并阻止冒泡。
                <button
                  type="button"
                  data-workflow-run-details-trigger="true"
                  data-workflow-run-id={run.runId}
                  aria-label={openLabel}
                  onClick={() => onOpenWorkflowRun?.(openTarget)}
                  className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
                />
              ) : null}
              <Workflow className="pointer-events-none relative z-[1] mt-0.5 size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
              <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
                  {displayName}
                </span>
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                  {run.status ? (
                    <>
                      {/* 状态永远有词，绝不只靠颜色或动画表达（a11y）。 */}
                      <span
                        aria-hidden="true"
                        data-workflow-run-status-dot={run.status}
                        className={cn("size-1.5 shrink-0 rounded-full", RUN_STATUS_DOT[run.status])}
                      />
                      <span className={cn("shrink-0", RUN_STATUS_TEXT[run.status])}>
                        {intl.formatMessage({
                          id: `chat.toolCall.workflow.run.status.${run.status}`,
                        })}
                      </span>
                      <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
                        {intl.formatMessage(
                          { id: "chat.toolCall.workflow.card.steps" },
                          {
                            // 步数与 status 在模型层同簇出现（present iff status present），
                            // 但类型上是各自独立的可选字段；`?? 0` 只是补这道类型形式，
                            // 真跑到它意味着模型违反了自己的不变量。
                            done: String(run.nodesSettled ?? 0),
                            total: String(run.nodesTotal ?? 0),
                          },
                        )}
                      </span>
                    </>
                  ) : null}
                  {run.startedAt === undefined ? null : (
                    <span className="shrink-0 tabular-nums text-[var(--color-foreground-subtle)]">
                      {formatBackgroundTaskElapsedLabel(
                        Math.max(0, now - run.startedAt),
                        intl.formatMessage,
                      )}
                    </span>
                  )}
                  {run.workId && run.cancellable !== false ? (
                    <RunningWorkCancelButton
                      workId={run.workId}
                      onCancel={onCancelBackgroundWork}
                    />
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {/* 已结束的 run 折进这条页脚行（与 Agents 分区共用同一个 affordance）：终态 run 不占
          活动列表的位置，但入口必须留着——被打断的那些正是最需要点进去的。 */}
      <EndedDirectoryRow
        count={endedRunCount}
        icon={
          <CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />
        }
        label={intl.formatMessage({ id: "chat.statusPanel.endedWorkflows" })}
        separated={runs.length > 0}
        testId="workflow-run-directory-trigger"
        onOpen={
          parentSessionId && onOpenDirectory
            ? () => onOpenDirectory({ parentSessionId })
            : undefined
        }
      />
    </StatusSection>
  );
}

function OrchestrationStepStatusIcon({
  status,
}: {
  status: OrchestrationStepProjection["status"];
}) {
  // 与「进程」分区同一套图标语言：进行中用 →、待执行用 ○、完成用 ✓。
  // 运行中不使用加载动画——同一份状态在「进程」里已经用静态箭头表达，
  // 编排计划继续用转圈会让两个分区看起来是两套语义。
  const className = "mt-0.5 size-3.5 shrink-0";
  switch (status) {
    case "running":
      return (
        <ArrowRightIcon aria-hidden className={cn(className, "text-[var(--color-foreground)]")} />
      );
    case "completed":
      return (
        <CheckCircle2Icon aria-hidden className={cn(className, "text-[var(--color-success)]")} />
      );
    case "failed":
      return <XIcon aria-hidden className={cn(className, "text-[var(--color-destructive)]")} />;
    case "blocked":
    case "cancelled":
    case "interrupted":
      return (
        <CircleSlashIcon
          aria-hidden
          className={cn(className, "text-[var(--color-foreground-subtle)]")}
        />
      );
    default:
      return (
        <CircleIcon
          aria-hidden
          className={cn(className, "text-[var(--color-foreground-subtlest)]")}
        />
      );
  }
}

function orchestrationStepStatusTone(status: OrchestrationStepProjection["status"]) {
  if (status === "running") return "text-warning";
  if (status === "failed") return "text-[var(--color-destructive)]";
  return "text-[var(--color-foreground-subtle)]";
}

function orchestrationRunStatusTone(status: OrchestrationRunProjection["status"]) {
  if (status === "running") return "text-warning";
  if (status === "failed") return "text-[var(--color-destructive)]";
  return "text-[var(--color-foreground-subtle)]";
}

function OrchestrationStepRow({
  now,
  step,
  stepById,
  resolveAgentColor,
}: {
  now: number;
  step: OrchestrationStepProjection;
  stepById: ReadonlyMap<string, OrchestrationStepProjection>;
  resolveAgentColor: ReturnType<typeof useSubagentColorResolver>;
}) {
  const { intl } = useZCodeIntl();
  const roleColor = resolveAgentColor(step.role);
  const waitingOn = step.dependsOn.filter((dependency) => {
    const state = stepById.get(dependency)?.status;
    return state !== "completed" && state !== "failed" && state !== "cancelled";
  });
  const elapsedMs =
    step.startedAt === undefined
      ? null
      : step.status === "running"
        ? Math.max(0, now - step.startedAt)
        : step.endedAt === undefined
          ? null
          : Math.max(0, step.endedAt - step.startedAt);
  // 行尾只给时长值：「已运行 X」句子在每行复制会盖过标题；动词短语留给智能体/终端分区，
  // 那里一行只有一个运行中的任务。
  const elapsedLabel =
    elapsedMs === null
      ? null
      : formatDurationUnits(Math.floor(elapsedMs / 1000), intl.formatMessage);

  return (
    <li
      data-orchestration-step-id={step.stepId}
      data-step-status={step.status}
      className="grid min-w-0 grid-cols-[14px_minmax(0,1fr)_auto] items-start gap-x-2 rounded-lg px-2 py-1 transition-colors hover:bg-[var(--color-hover)]"
    >
      <OrchestrationStepStatusIcon status={step.status} />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span
          className={cn(
            "line-clamp-2 min-w-0 text-ui-base leading-5",
            step.status === "completed"
              ? "text-[var(--color-foreground-subtle)]"
              : "text-[var(--color-foreground)]",
          )}
        >
          {step.title}
        </span>
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-ui-sm leading-4 text-[var(--color-foreground-subtle)]">
          <span className={cn("shrink-0", orchestrationStepStatusTone(step.status))}>
            {intl.formatMessage({ id: `chat.orchestration.step.${step.status}` })}
          </span>
          {step.role ? (
            <span
              data-agent-name={step.role}
              data-agent-color={roleColor}
              className={cn(
                "min-w-0 max-w-24 truncate font-mono text-ui-xs",
                SUBAGENT_TEXT_COLOR_CLASS[roleColor],
              )}
            >
              {step.role}
            </span>
          ) : null}
          {step.status === "pending" && waitingOn.length > 0 ? (
            <span className="min-w-0 truncate">
              {intl.formatMessage(
                { id: "chat.orchestration.step.waiting" },
                { steps: waitingOn.join(", ") },
              )}
            </span>
          ) : null}
          {step.attempts > 1 ? (
            <span className="shrink-0 text-warning">
              {intl.formatMessage(
                { id: "chat.orchestration.step.attempts" },
                { count: String(step.attempts) },
              )}
            </span>
          ) : null}
        </span>
      </span>
      {elapsedLabel ? (
        <span className="shrink-0 pt-0.5 text-ui-xs tabular-nums text-[var(--color-foreground-subtlest)]">
          {elapsedLabel}
        </span>
      ) : null}
      {step.error ? (
        <span className="col-span-2 col-start-2 mt-0.5 line-clamp-2 text-ui-sm leading-4 text-[var(--color-destructive)]">
          {step.error}
        </span>
      ) : null}
    </li>
  );
}

/**
 * 编排计划分区：run / step 的只读投影 + 两个显式动作（停止 / 重排）。
 *
 * 计划过去住在 composer 上方的运行条和弹窗里，主会话结束后只看到一条“已工作 X”；
 * 放进状态面板后与 Todo / 子智能体同层，折叠成 chip 也能看到进度。
 * 数据来自 `orchestrationState` 的只读投影，组件不维护 run 状态。
 */
function OrchestrationStatusSection({
  onOpenChange,
  onRequestReplan,
  onStopRun,
  open,
  runs,
  separated,
  title,
  workspacePath,
  workspaceIdentity,
}: {
  onOpenChange?: (open: boolean) => void;
  onRequestReplan?: () => void;
  onStopRun?: (runId: string) => void;
  open?: boolean;
  runs: readonly ConversationStatusPanelOrchestrationRun[];
  separated: boolean;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
}) {
  const { intl } = useZCodeIntl();
  const resolveAgentColor = useSubagentColorResolver(workspacePath, workspaceIdentity);
  const hasRunningStep = runs.some(({ run }) =>
    run.steps.some((step) => step.status === "running"),
  );
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!hasRunningStep) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRunningStep]);

  if (runs.length === 0) return null;
  const primary = runs[0]!;

  return (
    <StatusSection
      section="orchestration"
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={() => (
        <span className="shrink-0 tabular-nums">
          {intl.formatMessage(
            { id: "chat.orchestration.progress" },
            {
              completed: String(primary.completedCount),
              total: String(primary.totalCount),
              running: String(primary.runningCount),
            },
          )}
        </span>
      )}
    >
      <div className="flex flex-col pb-1">
        {runs.map((entry, index) => (
          <OrchestrationRunBlock
            key={entry.run.runId}
            entry={entry}
            now={now}
            resolveAgentColor={resolveAgentColor}
            onRequestReplan={onRequestReplan}
            onStopRun={onStopRun}
            separated={index > 0}
          />
        ))}
      </div>
    </StatusSection>
  );
}

function OrchestrationRunBlock({
  entry,
  now,
  onRequestReplan,
  onStopRun,
  separated,
  resolveAgentColor,
}: {
  entry: ConversationStatusPanelOrchestrationRun;
  now: number;
  resolveAgentColor: ReturnType<typeof useSubagentColorResolver>;
  onRequestReplan?: () => void;
  onStopRun?: (runId: string) => void;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  const { run } = entry;
  const stepById = useMemo(
    () => new Map(run.steps.map((step) => [step.stepId, step])),
    [run.steps],
  );
  const canAct = run.active;
  const stopLabel = intl.formatMessage({ id: "chat.orchestration.timeline.stop" });
  const replanLabel = intl.formatMessage({ id: "chat.orchestration.timeline.replan" });

  return (
    <section
      data-orchestration-run-id={run.runId}
      data-orchestration-run-status={run.status}
      className={cn(
        "flex min-w-0 flex-col",
        // run 之间只用一条发丝线：面板里已经有一层边框，run 再套卡片会变成三层描边。
        separated && "mt-2 border-t border-[var(--color-border)]/50 pt-2",
      )}
    >
      <div className="flex h-7 min-w-0 items-center gap-1.5 px-2">
        {/* planId 可截断，修订号独立且永远可见：丢掉 rN 就判断不了这是哪一版计划。 */}
        <span
          className="min-w-0 flex-1 truncate font-mono text-ui-sm font-medium text-[var(--color-foreground)]"
          title={run.planId}
        >
          {run.planId}
        </span>
        <span className="shrink-0 text-ui-xs tabular-nums text-[var(--color-foreground-subtlest)]">
          r{run.revision}
        </span>
        <span
          className={cn("shrink-0 text-ui-xs font-medium", orchestrationRunStatusTone(run.status))}
        >
          {intl.formatMessage({ id: `chat.orchestration.run.${run.status}` })}
        </span>
        {canAct && onStopRun ? (
          <ControlHintTooltip title={stopLabel} side="left">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 rounded-md"
              aria-label={stopLabel}
              onClick={() => onStopRun(run.runId)}
            >
              <SquareIcon className="size-3.5" aria-hidden />
            </Button>
          </ControlHintTooltip>
        ) : null}
        {canAct && onRequestReplan ? (
          <ControlHintTooltip title={replanLabel} side="left">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6 shrink-0 rounded-md"
              aria-label={replanLabel}
              onClick={onRequestReplan}
            >
              <RotateCcwIcon className="size-3.5" aria-hidden />
            </Button>
          </ControlHintTooltip>
        ) : null}
      </div>
      <ol className="flex flex-col gap-0.5 px-1">
        {run.steps.map((step) => (
          <OrchestrationStepRow
            key={step.stepId}
            step={step}
            stepById={stepById}
            now={now}
            resolveAgentColor={resolveAgentColor}
          />
        ))}
      </ol>
    </section>
  );
}

/**
 * 运行中子智能体的前置状态图标：沿用「进程」分区的图标语言（→ / ○ / ⊘），
 * 不再使用旋转加载图标。状态词仍在信息行保留，图标只做快速扫读辅助。
 */
function SubagentStatusGlyph({
  status,
}: {
  status: ConversationStatusPanelRunningSubagent["status"];
}) {
  const className = "size-3.5 shrink-0";
  if (status === "running") {
    return (
      <ArrowRightIcon aria-hidden className={cn(className, "text-[var(--color-foreground)]")} />
    );
  }
  if (status === "waiting") {
    return (
      <CircleIcon
        aria-hidden
        className={cn(className, "text-[var(--color-foreground-subtlest)]")}
      />
    );
  }
  return (
    <CircleSlashIcon aria-hidden className={cn(className, "text-[var(--color-destructive)]")} />
  );
}

function SubagentStatusSection({
  endedSubagentCount,
  onCancelBackgroundWork,
  onOpenChange,
  onOpenSubagentDirectory,
  onOpenSubagentSession,
  open,
  parentSessionId,
  rootSessionId,
  separated,
  title,
  subagents,
  workspaceIdentity,
  workspacePath,
}: {
  endedSubagentCount: number;
  onCancelBackgroundWork?: (workId: string) => void;
  onOpenChange?: (open: boolean) => void;
  onOpenSubagentDirectory?: (request: OpenSubagentDirectorySideTabRequest) => void;
  onOpenSubagentSession?: (request: OpenSubagentSideTabRequest) => void;
  open?: boolean;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
  title: string;
  subagents: readonly ConversationStatusPanelRunningSubagent[];
  workspaceIdentity?: string;
  workspacePath: string;
}) {
  const { intl } = useZCodeIntl();
  const resolveAgentColor = useSubagentColorResolver(workspacePath, workspaceIdentity);
  const [now, setNow] = useState(() => Date.now());
  // 状态事实来自 snapshot.subagents.running[].status：running → waiting → blocked，
  // 组内按 startedAt 升序（缺失排组尾），同值保持投影原序（规则 11）。
  const ordered = useMemo(() => sortRunningSubagentsByStatus(subagents), [subagents]);
  const statusCounts = useMemo(() => countSubagentStatuses(subagents), [subagents]);
  useEffect(() => {
    if (subagents.length === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [subagents.length]);

  // 每行显示该子会话**自己的**累计平均 TPS（specs/session-performance-stats.md 规则 7）。
  // 一次批量读覆盖全部运行中的子智能体：请求频率是 1 秒一次，与并发子代理数无关；
  // 分区卸载（面板收起成胶囊、会话切换）或没有运行中子智能体时不发请求。
  // id 顺序与行渲染共用同一份排序结果：32 上限因此优先保留运行中、再等待、再阻塞。
  const pollIds = useMemo(
    () => resolveSubagentSpeedPollIds(ordered.map((item) => item.childSessionId)),
    [ordered],
  );
  const { entries: speedEntries } = useSessionPerformanceBatch({
    workspacePath,
    workspaceIdentity,
    sessionIds: pollIds,
    enabled: ordered.length > 0,
  });
  const speeds = useMemo(
    () => resolveSubagentSpeedReadings(speedEntries, pollIds),
    [speedEntries, pollIds],
  );

  if (subagents.length === 0 && endedSubagentCount <= 0) return null;
  // 收起态 trailing 的时长与速度必须同指一个子智能体：两者都取「运行最久」的那个。
  // 全部缺 startedAt 时它回落成第一个，时长仍是既有的 1 秒兜底显示。
  const longestRunning = resolveLongestRunningSubagent(subagents, now);
  const longestElapsedMs = longestRunning
    ? Math.max(0, now - (longestRunning.startedAt ?? now))
    : 0;
  const longestSpeed = longestRunning ? (speeds.get(longestRunning.childSessionId) ?? null) : null;
  // 状态摘要只列非零项，顺序固定 running/waiting/blocked（规则 12）。展开态与收起态共用，
  // data-subagent-status-summary 只用于断言，不参与渲染。
  const hasStatusSummary = hasSubagentStatusSummary(statusCounts);
  const statusSummaryNode = hasStatusSummary ? (
    <span
      data-subagent-status-summary={`running:${statusCounts.running},waiting:${statusCounts.waiting},blocked:${statusCounts.blocked}`}
      className="inline-flex min-w-0 items-center gap-1"
    >
      {SUBAGENT_STATUS_ORDER.filter((status) => statusCounts[status] > 0).map((status, index) => (
        <Fragment key={status}>
          {index > 0 ? <span className="shrink-0">·</span> : null}
          <span className="shrink-0">
            {intl.formatMessage(
              { id: `chat.statusPanel.subagentStatusSummary.${status}` },
              { count: String(statusCounts[status]) },
            )}
          </span>
        </Fragment>
      ))}
    </span>
  ) : null;

  return (
    <StatusSection
      section="agent"
      defaultOpen={false}
      open={open}
      onOpenChange={onOpenChange}
      separated={separated}
      title={title}
      trailing={(isOpen) =>
        subagents.length === 0 ? null : isOpen ? (
          statusSummaryNode
        ) : (
          <>
            <span className="min-w-0 truncate">
              {formatDurationUnits(
                Math.max(1, Math.floor(longestElapsedMs / 1000)),
                intl.formatMessage,
              )}
            </span>
            <span className="shrink-0">·</span>
            {/* 读数拿不到（还没有已完成请求 / 旧 CLI 不支持批量读）时整段缺席，不留 0 或 --。 */}
            {longestSpeed === null ? null : (
              <>
                <span className="shrink-0 tabular-nums" data-subagent-speed="true">
                  {formatSessionSpeedValue(longestSpeed, intl)}
                </span>
                {hasStatusSummary ? <span className="shrink-0">·</span> : null}
              </>
            )}
            {statusSummaryNode}
          </>
        )
      }
    >
      <ul className="space-y-0">
        {ordered.map((subagent) => {
          const request = buildRunningSubagentOpenRequest({
            parentSessionId,
            rootSessionId,
            subagent,
          });
          const canOpenSubagentSession = Boolean(request && onOpenSubagentSession);
          // 该子会话自己的累计平均 TPS；没有已完成请求（或旧 CLI 不支持批量读）时为 undefined。
          const speed = speeds.get(subagent.childSessionId);
          // 标题说的是「让它干什么」，名字说的是「它是谁」；缺名字时整段缺席（见 subagentName.ts）。
          const displayName = resolveSubagentDisplayName(subagent.subagentType);
          const agentColor = resolveAgentColor(subagent.subagentType);
          // 状态图标与状态词表达同一事实（规则 10）：图标负责扫读，颜色只是辅助，
          // 可读状态始终由文字承担。
          const statusTone =
            subagent.status === "running"
              ? "text-warning"
              : subagent.status === "waiting"
                ? "text-[var(--color-foreground-subtle)]"
                : "text-[var(--color-destructive)]";
          return (
            <li
              key={subagent.childSessionId}
              data-testid={
                subagent.controlWorkId
                  ? testId(TID_V4_BACKGROUND_WORK_ITEM, subagent.controlWorkId)
                  : undefined
              }
              data-background-task-kind="agent"
              data-child-session-id={subagent.childSessionId}
              data-work-id={subagent.controlWorkId}
              // 与 data-subagent-status 保持同一事实（snapshot.subagents.running[].status），
              // 不再硬编码 running，避免两个属性互相矛盾。
              data-work-status={subagent.status}
              data-subagent-status={subagent.status}
              className={cn(
                "group relative flex min-w-0 items-start gap-2 rounded-lg px-2 py-2 hover:bg-[var(--color-hover)]",
                canOpenSubagentSession && "cursor-pointer",
              )}
            >
              {canOpenSubagentSession ? (
                // Agent 行同时包含“打开详情”和 Stop，不能用整行 button 包住
                // Stop 形成嵌套按钮。透明同级按钮承接详情，Stop 保持独立交互层且阻止冒泡。
                <button
                  type="button"
                  data-running-subagent-session-trigger="true"
                  data-child-session-id={subagent.childSessionId}
                  aria-label={intl.formatMessage({
                    id: "chat.summaryPanel.openRunningSubagentSession",
                  })}
                  onClick={() => request && onOpenSubagentSession?.(request)}
                  className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
                />
              ) : null}
              {/* 状态图标前置到行首，与「进程」分区一致：扫一眼图标就能分清谁在跑、谁在等、谁被阻塞。 */}
              <span className="pointer-events-none relative z-[1] mt-0.5 flex shrink-0 items-center">
                <SubagentStatusGlyph status={subagent.status} />
              </span>
              <div className="pointer-events-none relative z-[1] flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="line-clamp-2 text-ui-base leading-5 text-[var(--color-foreground)]">
                  {subagent.title}
                </span>
                {/* 信息行从状态词开始：状态词 → 角色名 → 时长 → TPS → Stop。
                    状态图标已经前置到行首；各项用间距分隔，不使用 `·`，
                    窄面板下整段换行而不是挤掉 Stop。 */}
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-ui-base">
                  <span className={cn("shrink-0", statusTone)}>
                    {intl.formatMessage({
                      id: `chat.statusPanel.subagentStatus.${subagent.status}`,
                    })}
                  </span>
                  {/* 名字排在时长之前：先认出「是谁在跑」，再看跑了多久。哨兵值/空值整段缺席。
                      这一行整体 pointer-events-none（整行点击由 z-0 那层透明按钮承接），所以
                      title 提示在这里永远不会弹——长名只截断，完整名字在打开的子会话页签上。 */}
                  {displayName === undefined ? null : (
                    <span
                      data-subagent-name={displayName}
                      data-agent-name={displayName}
                      data-agent-color={agentColor}
                      className={cn(
                        "max-w-40 shrink-0 truncate font-mono font-medium text-ui-base",
                        SUBAGENT_TEXT_COLOR_CLASS[agentColor],
                      )}
                    >
                      {displayName}
                    </span>
                  )}
                  <span className="text-ui-base tabular-nums text-[var(--color-foreground-subtle)]">
                    {formatBackgroundTaskElapsedLabel(
                      Math.max(0, now - (subagent.startedAt ?? now)),
                      intl.formatMessage,
                    )}
                  </span>
                  {/* 该子会话自己的累计平均 TPS；没有已完成请求时不渲染这一段。 */}
                  {speed === undefined ? null : (
                    <span
                      className="text-ui-base tabular-nums text-[var(--color-foreground-subtle)]"
                      data-subagent-speed="true"
                    >
                      {formatSessionSpeedValue(speed, intl)}
                    </span>
                  )}
                  {subagent.controlWorkId && subagent.cancellable !== false ? (
                    <RunningWorkCancelButton
                      workId={subagent.controlWorkId}
                      onCancel={onCancelBackgroundWork}
                    />
                  ) : null}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <EndedSubagentDirectoryRow
        count={endedSubagentCount}
        parentSessionId={parentSessionId}
        rootSessionId={rootSessionId}
        onOpen={onOpenSubagentDirectory}
        separated={subagents.length > 0}
      />
    </StatusSection>
  );
}

/**
 * 「已结束的 X · N ›」页脚行：分区里那条通往目录页的入口。
 *
 * Agents 与 Workflows **共用这一个** affordance（图标/文案/计数/回调由调用方给）。抽出来的
 * 理由不是省行数，而是不出现第二套画法：两个分区的页脚行若各写一遍，两者会随时间长出不同的
 * 间距、不同的 hover、不同的计数位置，而它们在读者眼里本来是同一个动作。
 *
 * `count <= 0` 或缺回调即整行缺席：一个点了没反应的入口比没有入口更糟。
 */
function EndedDirectoryRow({
  count,
  icon,
  label,
  onOpen,
  separated,
  testId,
}: {
  count: number;
  icon: ReactNode;
  label: string;
  onOpen?: () => void;
  separated: boolean;
  testId?: string;
}) {
  if (count <= 0 || !onOpen) return null;
  return (
    <div className={cn(separated && "border-t border-[var(--color-border)] pt-2")}>
      <button
        type="button"
        data-testid={testId}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-ui-base text-[var(--color-foreground)] hover:bg-[var(--color-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-input-border-focused)]"
        onClick={onOpen}
      >
        {icon}
        <span>{label}</span>
        <span className="ml-auto text-[var(--color-foreground-subtle)]">{count}</span>
        <ChevronRightIcon className="size-4 text-[var(--color-foreground-subtle)]" />
      </button>
    </div>
  );
}

function EndedSubagentDirectoryRow({
  count,
  onOpen,
  parentSessionId,
  rootSessionId,
  separated,
}: {
  count: number;
  onOpen?: (request: OpenSubagentDirectorySideTabRequest) => void;
  parentSessionId?: string;
  rootSessionId?: string;
  separated: boolean;
}) {
  const { intl } = useZCodeIntl();
  return (
    <EndedDirectoryRow
      count={count}
      icon={<CheckCircle2Icon className="size-4 shrink-0 text-[var(--color-foreground-subtle)]" />}
      label={intl.formatMessage({ id: "chat.statusPanel.endedAgents" })}
      separated={separated}
      onOpen={
        parentSessionId && onOpen
          ? () =>
              onOpen({
                rootSessionId: rootSessionId ?? parentSessionId,
                parentSessionId,
              })
          : undefined
      }
    />
  );
}

function ConversationStatusPanelImpl({
  workspacePath,
  workspaceIdentity,
  goal,
  sessionPlans,
  plan,
  backgroundWorks = EMPTY_BACKGROUND_WORKS,
  runningSubagents = EMPTY_RUNNING_SUBAGENTS,
  workflowRuns = EMPTY_WORKFLOW_RUNS,
  orchestrationRuns = EMPTY_ORCHESTRATION_RUNS,
  endedWorkflowRunCount = 0,
  endedSubagentCount = 0,
  rootSessionId,
  parentSessionId,
  open,
  onClose,
  goalSectionOpen,
  onGoalSectionOpenChange,
  planSectionOpen,
  onPlanSectionOpenChange,
  terminalSectionOpen,
  onTerminalSectionOpenChange,
  agentSectionOpen,
  onAgentSectionOpenChange,
  workflowSectionOpen,
  onWorkflowSectionOpenChange,
  orchestrationSectionOpen,
  onOrchestrationSectionOpenChange,
  onPauseGoal,
  onResumeGoal,
  onOpenPlanDetail,
  onOpenBackgroundBash,
  onCancelBackgroundWork,
  onOpenSubagentSession,
  onOpenSubagentDirectory,
  onOpenWorkflowRun,
  onOpenWorkflowRunDirectory,
  onStopOrchestrationRun,
  onRequestOrchestrationReplan,
}: ConversationStatusPanelProps) {
  const model = useMemo(
    () =>
      buildConversationStatusPanelModel({
        goal,
        sessionPlans,
        workspacePath,
        plan,
        backgroundWorks,
        runningSubagents,
        workflowRuns,
        orchestrationRuns,
      }),
    [
      backgroundWorks,
      goal,
      orchestrationRuns,
      sessionPlans,
      plan,
      runningSubagents,
      workflowRuns,
      workspacePath,
    ],
  );
  const { intl } = useZCodeIntl();
  // 面板是右下覆盖式浮层，分区内的二级浮层统一向左展开。
  const useVerticalFloatingPanels = false;
  const canRenderGoal = Boolean(model.goal);
  const canRenderSessionPlans = Boolean(model.sessionPlans);
  const canRenderPlan = Boolean(model.plan);
  const canRenderOrchestration = model.activeOrchestrationRuns.length > 0;
  const canRenderTerminals = model.runningBashWorks.length > 0;
  // 已结束的 run 也开门：重启后活动数为零，若只按它开门，通往 run 目录的唯一入口会消失。
  const canRenderEndedWorkflows = Boolean(
    endedWorkflowRunCount > 0 && parentSessionId && onOpenWorkflowRunDirectory,
  );
  const canRenderWorkflows = model.runningWorkflowRuns.length > 0 || canRenderEndedWorkflows;
  const canRenderEndedAgents = Boolean(
    endedSubagentCount > 0 && parentSessionId && onOpenSubagentDirectory,
  );
  const canRenderAgents = model.runningSubagentWorks.length > 0 || canRenderEndedAgents;
  const hasStatusSections =
    canRenderGoal ||
    canRenderSessionPlans ||
    canRenderPlan ||
    canRenderTerminals ||
    canRenderWorkflows ||
    canRenderOrchestration ||
    canRenderAgents;
  // 面板由标题栏「会话状态」图标唤醒；没有内容时也渲染空态，保证点击图标有反馈。
  if (!open) {
    return null;
  }
  const closeLabel = intl.formatMessage({ id: "common.close" });
  return (
    <div className="pointer-events-none absolute right-4 top-0 z-20 pt-4">
      <aside
        aria-label={intl.formatMessage({ id: "chat.summaryPanel.title" })}
        data-testid={TID_CHAT_STATUS_SECTIONS_PANEL}
        data-state="expanded"
        data-goal-status={model.goal?.status}
        data-goal-objective={model.goal?.objective}
        data-running-background-count={
          model.runningBashWorks.length +
          model.runningSubagentWorks.length +
          model.runningWorkflowRuns.length
        }
        data-running-terminal-count={model.runningBashWorks.length}
        data-running-agent-count={model.runningSubagentWorks.length}
        data-running-workflow-count={model.runningWorkflowRuns.length}
        data-ended-workflow-count={endedWorkflowRunCount}
        className="pointer-events-auto relative flex max-h-[min(70dvh,36rem)] w-80 max-w-[calc(100vw-1.5rem)] flex-col overflow-hidden rounded-2xl border border-[var(--color-popover-border)] bg-[var(--color-popover)] text-[var(--color-foreground)] shadow-md"
      >
        {/* 关闭按钮必须高于粘性分区头，否则滚上来的标题会盖住它的点击区。 */}
        <div className="absolute right-3 top-3 z-20 flex items-center">
          <ControlHintTooltip title={closeLabel} side="left">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-6"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <XIcon className="size-3.5" />
            </Button>
          </ControlHintTooltip>
        </div>
        {/* 全面板唯一的滚动视口：分区不再各自限高滚动，标题用 sticky 常驻。
            scrollbar-gutter 保证滚动条出现/消失时行宽不跳动，overscroll-contain 阻止滚动链传回时间线。 */}
        <div
          data-status-panel-scroll="panel"
          className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain px-2 pt-1 pb-2 [scrollbar-gutter:stable]"
        >
          {!hasStatusSections ? (
            <p
              data-status-section="empty"
              className="px-2 py-6 text-center text-ui-sm text-[var(--color-foreground-subtle)]"
            >
              {intl.formatMessage({ id: "chat.statusPanel.empty" })}
            </p>
          ) : null}
          {canRenderGoal ? (
            <GoalStatusSection
              model={model}
              open={goalSectionOpen}
              onOpenChange={onGoalSectionOpenChange}
              separated={false}
              onPauseGoal={onPauseGoal}
              onResumeGoal={onResumeGoal}
            />
          ) : null}
          {canRenderSessionPlans ? (
            <SessionPlansStatusSection
              model={model}
              parentSessionId={parentSessionId}
              onOpenPlanDetail={onOpenPlanDetail}
              separated={canRenderGoal}
            />
          ) : null}
          {canRenderPlan ? (
            <PlanStatusSection
              model={model}
              open={planSectionOpen}
              onOpenChange={onPlanSectionOpenChange}
              popoverSide={useVerticalFloatingPanels ? "bottom" : "left"}
              separated={canRenderGoal || canRenderSessionPlans}
            />
          ) : null}
          {canRenderTerminals ? (
            <BackgroundWorkStatusSection
              onOpenBackgroundBash={onOpenBackgroundBash}
              section="terminal"
              title={intl.formatMessage({ id: "chat.statusPanel.terminals" })}
              works={model.runningBashWorks}
              open={terminalSectionOpen}
              onOpenChange={onTerminalSectionOpenChange}
              separated={canRenderGoal || canRenderSessionPlans || canRenderPlan}
              onCancelBackgroundWork={onCancelBackgroundWork}
            />
          ) : null}
          {canRenderWorkflows ? (
            <WorkflowStatusSection
              title={intl.formatMessage({ id: "chat.statusPanel.workflows" })}
              runs={model.runningWorkflowRuns}
              endedRunCount={canRenderEndedWorkflows ? endedWorkflowRunCount : 0}
              open={workflowSectionOpen}
              onOpenChange={onWorkflowSectionOpenChange}
              separated={
                canRenderGoal || canRenderSessionPlans || canRenderPlan || canRenderTerminals
              }
              parentSessionId={parentSessionId}
              onCancelBackgroundWork={onCancelBackgroundWork}
              onOpenWorkflowRun={onOpenWorkflowRun}
              onOpenDirectory={onOpenWorkflowRunDirectory}
            />
          ) : null}
          {canRenderOrchestration ? (
            <OrchestrationStatusSection
              title={intl.formatMessage({ id: "chat.statusPanel.orchestration" })}
              runs={model.activeOrchestrationRuns}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              open={orchestrationSectionOpen}
              onOpenChange={onOrchestrationSectionOpenChange}
              separated={
                canRenderGoal ||
                canRenderSessionPlans ||
                canRenderPlan ||
                canRenderTerminals ||
                canRenderWorkflows
              }
              onStopRun={onStopOrchestrationRun}
              onRequestReplan={onRequestOrchestrationReplan}
            />
          ) : null}
          {canRenderAgents ? (
            <SubagentStatusSection
              title={intl.formatMessage({ id: "chat.statusPanel.agents" })}
              subagents={model.runningSubagentWorks}
              workspacePath={workspacePath}
              workspaceIdentity={workspaceIdentity}
              endedSubagentCount={canRenderEndedAgents ? endedSubagentCount : 0}
              onCancelBackgroundWork={onCancelBackgroundWork}
              open={agentSectionOpen}
              onOpenChange={onAgentSectionOpenChange}
              separated={
                canRenderGoal ||
                canRenderSessionPlans ||
                canRenderPlan ||
                canRenderTerminals ||
                canRenderWorkflows ||
                canRenderOrchestration
              }
              parentSessionId={parentSessionId}
              rootSessionId={rootSessionId}
              onOpenSubagentSession={onOpenSubagentSession}
              onOpenSubagentDirectory={onOpenSubagentDirectory}
            />
          ) : null}
        </div>
      </aside>
    </div>
  );
}

export const ConversationStatusPanel = memo(ConversationStatusPanelImpl);
