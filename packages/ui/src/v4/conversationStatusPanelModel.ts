import type {
  BackgroundWorkSummary,
  GoalState,
  OrchestrationRunProjection,
  PlanState,
  RunningSubagentSummary,
  ToolCallRow,
  WorkflowRunState,
} from "@zcode/shared/zcode-protocol-v4";
import { workflowRunStepCounts } from "@zcode/shared/zcode-protocol-v4";
import { extractPlanToolCallContent, getPlanDirectoryTitle } from "@/lib/planToolCall.js";

export interface ConversationStatusPanelPlanModel {
  items: PlanState["items"];
  displayItems: PlanState["items"];
  completedCount: number;
  waitingCount: number;
  totalCount: number;
}

export interface ConversationStatusPanelSessionPlanItem {
  rowId: number;
  toolCallId: string;
  markdown: string;
  title?: string;
  planFilePath?: string;
}

export interface ConversationStatusPanelSessionPlansModel {
  items: ConversationStatusPanelSessionPlanItem[];
}

export interface ConversationStatusPanelRunningSubagent extends RunningSubagentSummary {
  /**
   * 停止句柄（≡ `cancelBackgroundWork` 的 workId）：优先匹配到的后台 work，
   * 没有时回退到本行 `agentId`。缺席即不渲染 Stop（见 specs/status-panel-subagent-stop.md）。
   */
  controlWorkId?: string;
  cancellable?: boolean;
}

/**
 * Workflows 分区的一行。
 *
 * 字段成三簇，因为三种事实各自可以缺席：`status` / `nodesSettled` / `nodesTotal` 来自
 * `workflowRuns` 投影；`title` / `startedAt` 是后台任务的静态元数据；`workId` /
 * `cancellable` 是 Stop 的前提，只在后台任务仍 running 时出现。**缺席用字段不存在表达，
 * 而不是 0 或空串**——渲染层据此决定这行有没有状态词/步数、有没有时长、能不能停，一个假
 * 的 0/0 会显示成「一步都没跑」。分簇的理由见 `buildRunningWorkflowRuns`。
 */
export interface ConversationStatusPanelWorkflowRun {
  /** 身份与 React key；偏斜降级行用 workId 顶替（两者本就 ≡）。 */
  runId: string;
  /** 缺席即该行不可点（没有可开的详情页 tab），与投影里 run 无 toolCallId 同义。 */
  toolCallId?: string;
  /** 有 run 支撑才有状态词；降级行没有。 */
  status?: "pending" | "running";
  nodesSettled?: number;
  nodesTotal?: number;
  /**
   * 展示名。**`title ≡ workId` 即「未命名」**，渲染层据此换成 i18n 兜底名：core 的
   * `workflowTaskSubject` 兜底链最终落到 taskId（≡ runId ≡ workId），而投影把非空
   * description 原样抄进 title——所以「题名恰好等于 id」是唯一可靠的未命名信号。
   * 模型不做这个替换（i18n 不属于模型层），只保证 title 原样透出。
   */
  title?: string;
  startedAt?: number;
  /** 停止按钮要的控制句柄；只在 work 仍 running 时出现（已结束的 work 没有可取消的东西）。 */
  workId?: string;
  cancellable?: boolean;
}

/**
 * 「打开哪个 run 的详情页」的意图。会话与 workspace 身份由宿主补齐，面板不感知 scope
 * （与工具卡走同一个 handler，不存在第二条打开路径）。
 *
 * 住在模型文件而不是组件里：composer 徽标的直达判定（`resolveSoleRunningWorkflowRunTarget`）
 * 与面板行产出同一形状，组件层从模型取类型，不反向依赖。
 */
export interface ConversationStatusPanelWorkflowRunTarget {
  runId: string;
  toolCallId: string;
  workflowName?: string;
}

/**
 * 面板行 → 打开意图。无 `toolCallId` 即 null（没有可开的详情页 tab）。名字只在真有时带上：
 * `title ≡ runId` 是未命名 run 的兜底样子（core 的 workflowTaskSubject 落到 taskId），把 runId
 * 冻进 tab 标签比通用兜底名更糟。面板行与 composer 徽标直达共用这一处换算。
 */
export function workflowRunOpenTarget(
  run: ConversationStatusPanelWorkflowRun,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (!run.toolCallId) return null;
  return {
    runId: run.runId,
    toolCallId: run.toolCallId,
    ...(run.title && run.title !== run.runId ? { workflowName: run.title } : {}),
  };
}

export interface ConversationStatusPanelModel {
  /** 状态内容或 Git 可见，任一为真即 true（spec 规则 5）。 */
  hasContent: boolean;
  /** 不含 Git 的会话状态内容；决定右下状态卡片是否存在、是否需要让位。 */
  hasStatusContent: boolean;
  goal: GoalState | null;
  sessionPlans: ConversationStatusPanelSessionPlansModel | null;
  plan: ConversationStatusPanelPlanModel | null;
  runningBashWorks: BackgroundWorkSummary[];
  runningSubagentWorks: ConversationStatusPanelRunningSubagent[];
  runningWorkflowRuns: ConversationStatusPanelWorkflowRun[];
  /** 活动编排 run；计划分区的唯一数据源（只读投影，按投影顺序）。 */
  activeOrchestrationRuns: ConversationStatusPanelOrchestrationRun[];
}

export interface ConversationStatusPanelOrchestrationRun {
  run: OrchestrationRunProjection;
  completedCount: number;
  runningCount: number;
  totalCount: number;
}

interface BuildConversationStatusPanelModelInput {
  /** Git 是否可见（由 gitTools !== null 得到），计入 hasContent。 */
  hasGitTools?: boolean;
  goal?: GoalState | null;
  sessionPlans?: readonly ToolCallRow[];
  workspacePath?: string;
  plan?: PlanState | null;
  backgroundWorks?: readonly BackgroundWorkSummary[];
  runningSubagents?: readonly RunningSubagentSummary[];
  workflowRuns?: readonly WorkflowRunState[];
  orchestrationRuns?: readonly OrchestrationRunProjection[];
}

function buildPlanModel(plan: PlanState | null | undefined) {
  if (!plan || plan.items.length === 0) {
    return null;
  }
  const completed = plan.items.filter((item) => item.status === "completed");
  return {
    items: plan.items,
    // 按状态重新分组会让 Todo 完成时从原位置跳到列表末尾，破坏 TodoWrite
    // snapshot 的权威顺序。这里完整保留原数组，只由 renderer 负责滚动和状态样式。
    displayItems: plan.items,
    completedCount: completed.length,
    waitingCount: plan.items.length - completed.length,
    totalCount: plan.items.length,
  };
}

function buildSessionPlansModel(
  rows: readonly ToolCallRow[] | undefined,
  workspacePath: string | undefined,
): ConversationStatusPanelSessionPlansModel | null {
  if (!rows?.length) return null;
  const items = rows
    .filter(
      (row) =>
        row.toolName === "ExitPlanMode" &&
        (row.status === "success" || row.status === "error" || row.status === "cancelled"),
    )
    .toSorted((left, right) => right.rowId - left.rowId)
    .flatMap((row) => {
      const content = extractPlanToolCallContent(row, workspacePath ?? "");
      if (!content.markdown) return [];
      const title = getPlanDirectoryTitle(content.markdown);
      return [
        {
          rowId: row.rowId,
          toolCallId: row.toolCallId,
          markdown: content.markdown,
          ...(title ? { title } : {}),
          ...(content.planFilePath ? { planFilePath: content.planFilePath } : {}),
        },
      ];
    });
  return items.length > 0 ? { items } : null;
}

/**
 * Workflows 分区：活动 run 与 workflow 后台任务按 **workId ≡ runId** 联接。
 *
 * 这条等式不是猜的，是 schema 上写明的既有事实（`backgroundWorkSummarySchema` 的
 * kind 注释与 `backgroundResultOriginMetaSchema` 的 "workflow" 注释）；所以联接用主键
 * 直接对上，不需要 Agent 行那套「重复身份宁可不显示」的消歧。
 *
 * 两侧各自可以单方面缺席，缺席的处理按**字段含义**分簇，而不是按 work 的 status 一刀切：
 * - `title` / `startedAt` 是静态元数据，work 无论什么 status 都取。work 走到 resultPending
 *   时若一并丢掉它们，run 还在跑的那一行会当场闪成 i18n 兜底名并失去时长——纯视觉故障。
 * - `workId` / `cancellable` 是 Stop 的前提，**只在 work 仍 running 时给**：已结束的 work
 *   没有可取消的东西，留着按钮就是一个点了没反应的 Stop。
 * - run 有、work 全无：仍成行（状态词与步数是投影自己的事实），只是没有题名/时长/Stop。
 * - work 有、run 无：说明 CLI 老到不发 `workflowRuns` 投影键。降级成只有题名/时长/Stop
 *   的一行，**追加在 run 支撑的行之后**——它没有启动序上的位置，插进中间等于编造顺序。
 *   这条兜底的全部理由是：**cancel 入口在任何偏斜下都不许消失**；因此降级行只收 running
 *   的 work——既没有 run、work 也已结束的那条没有任何可操作的东西，显示它就是一条死行。
 */
function buildRunningWorkflowRuns(
  runs: readonly WorkflowRunState[] | undefined,
  workflowWorkByWorkId: ReadonlyMap<string, BackgroundWorkSummary>,
): ConversationStatusPanelWorkflowRun[] {
  const rows: ConversationStatusPanelWorkflowRun[] = [];
  const joinedWorkIds = new Set<string>();
  for (const run of runs ?? []) {
    // pending 也是活动态：run 已经起跑、只是还没派发第一个节点，藏起来等于让用户
    // 在「工作流启动了」和「面板出现它」之间看到一段空窗。
    if (run.status !== "pending" && run.status !== "running") continue;
    const work = workflowWorkByWorkId.get(run.runId);
    if (work) joinedWorkIds.add(run.runId);
    // 计数与聊天紧凑卡同源（唯一实现在 @zcode/shared 的 workflowRunStepCounts：表内 + 表外）。
    const steps = workflowRunStepCounts(run);
    rows.push({
      runId: run.runId,
      ...(run.toolCallId ? { toolCallId: run.toolCallId } : {}),
      status: run.status,
      nodesSettled: steps.settled,
      nodesTotal: steps.total,
      ...(work ? { title: work.title, startedAt: work.startedAt } : {}),
      ...(work?.status === "running"
        ? {
            workId: work.workId,
            // 缺省即可停，与 Agent 行同款 `!== false`：能停而不给按钮比反过来更糟。
            cancellable: work.cancellable !== false,
          }
        : {}),
    });
  }
  // 顺序 = 投影 runs 序 = 启动序，模型不排序；重排会让面板行在每次投影更新时跳位。
  for (const [workId, work] of workflowWorkByWorkId) {
    if (joinedWorkIds.has(workId) || work.status !== "running") continue;
    rows.push({
      runId: workId,
      workId,
      title: work.title,
      startedAt: work.startedAt,
      cancellable: work.cancellable !== false,
    });
  }
  return rows;
}

/**
 * composer 徽标直达：本会话的运行态**恰好**
 * 是一条可开详情页的 workflow run 时，返回它的打开意图；否则 null，徽标退回展开胶囊。
 *
 * 判定条件逐项都有理由：终端 / 子代理为零——徽标是它们唯一的入口，直达会把它们藏掉；
 * workflow 恰一条——两条以上选哪条是用户的事；带 `toolCallId`——降级行（work 有、run 无）与
 * 旧 CLI 的 run 没有可开的详情页，与面板行「不可点」同义，退回胶囊让 Stop 仍可达。
 * 输入就是 `buildConversationStatusPanelModel` 的产出：徽标与胶囊共用同一份运行态真值。
 */
export function resolveSoleRunningWorkflowRunTarget(
  model: Pick<
    ConversationStatusPanelModel,
    "runningBashWorks" | "runningSubagentWorks" | "runningWorkflowRuns"
  >,
): ConversationStatusPanelWorkflowRunTarget | null {
  if (model.runningBashWorks.length > 0 || model.runningSubagentWorks.length > 0) return null;
  if (model.runningWorkflowRuns.length !== 1) return null;
  return workflowRunOpenTarget(model.runningWorkflowRuns[0]!);
}

export function buildConversationStatusPanelModel(
  input: BuildConversationStatusPanelModelInput,
): ConversationStatusPanelModel {
  const goal = input.goal ?? null;
  const sessionPlans = buildSessionPlansModel(input.sessionPlans, input.workspacePath);
  const plan = buildPlanModel(input.plan);
  const runningBashWorks: BackgroundWorkSummary[] = [];
  const workflowWorkByWorkId = new Map<string, BackgroundWorkSummary>();
  const subagentControlByChildSessionId = new Map<string, BackgroundWorkSummary | null>();
  for (const work of input.backgroundWorks ?? []) {
    if (work.kind === "workflow") {
      // "workflow"（workflow run）曾与 bash 同列在 Terminals 下，那是保住停止入口的已记录错标；
      // 现在它有自己的 Workflows 分区，于是**只**按 workId ≡ runId 进 workflow 联接表。
      // 留在 runningBashWorks 里就是让同一个 run 在两个分区各出现一次。
      //
      // 这一支**收在 running 闸门之前**：题名与启动时刻对已结束的 work 依然有效（见
      // buildRunningWorkflowRuns 的分簇说明），status 的判断留到那里按字段做。workId 是
      // 主键，重复即上游损坏，不做消歧。
      workflowWorkByWorkId.set(work.workId, work);
      continue;
    }
    if (work.status !== "running") continue;
    if (work.kind === "bash") {
      runningBashWorks.push(work);
    } else if (work.kind === "subagent" && work.childSessionId) {
      // 目录投影接管 Agent 展示后，旧 backgroundWorks 的 workId/cancellable
      // 没有再关联回来，导致 Stop 入口消失。只接受唯一 childSessionId 精确匹配；重复或
      // 缺失身份时宁可不显示控制，也不能按标题、时间猜测并停止错误任务。
      const existing = subagentControlByChildSessionId.get(work.childSessionId);
      subagentControlByChildSessionId.set(
        work.childSessionId,
        existing === undefined ? work : null,
      );
    }
  }
  const runningSubagentWorks: ConversationStatusPanelRunningSubagent[] = (
    input.runningSubagents ?? []
  ).map((subagent) => {
    const controlWork = subagentControlByChildSessionId.get(subagent.childSessionId);
    if (controlWork) {
      return {
        ...subagent,
        controlWorkId: controlWork.workId,
        cancellable: controlWork.cancellable !== false,
      };
    }
    // 编排调度与其它直接进入 subagent port 的启动不经过 Agent 工具执行器，
    // 没有 BackgroundTaskStarted，backgroundWorks 里也就没有可联接的 work；
    // 但 running 投影里的 agentId ≡ runtime taskId ≡ cancelBackgroundWork 的 workId
    // （后台输出 backgroundTaskId ≡ agentId），这是行自己的权威身份，不是猜测。
    // 缺 agentId 的旧投影宁可不给按钮：点了没反应的 Stop 比没有更糟。
    if (!subagent.agentId) return subagent;
    return {
      ...subagent,
      controlWorkId: subagent.agentId,
      cancellable: true,
    };
  });
  const projectedChildSessionIds = new Set(
    runningSubagentWorks.map((subagent) => subagent.childSessionId),
  );
  for (const [childSessionId, controlWork] of subagentControlByChildSessionId) {
    if (!controlWork || projectedChildSessionIds.has(childSessionId)) continue;
    // backgroundWorks 已有精确 childSessionId 的 running 事实，但
    // subagents cold/live 投影交接的短窗口可能暂时缺行；旧模型会把 Agent 控制
    // 整条隐藏。这里只用唯一身份的权威 work 补齐同一控制，重复身份仍拒绝猜测。
    runningSubagentWorks.push({
      agentId: controlWork.workId,
      childSessionId,
      controlWorkId: controlWork.workId,
      subagentType: "subagent",
      title: controlWork.title,
      status: controlWork.blocked ? "blocked" : "running",
      startedAt: controlWork.startedAt,
      cancellable: controlWork.cancellable !== false,
    });
  }

  const runningWorkflowRuns = buildRunningWorkflowRuns(input.workflowRuns, workflowWorkByWorkId);
  const activeOrchestrationRuns = buildActiveOrchestrationRuns(input.orchestrationRuns);
  const hasStatusContent = Boolean(
    goal ||
    sessionPlans ||
    plan ||
    runningBashWorks.length > 0 ||
    runningSubagentWorks.length > 0 ||
    runningWorkflowRuns.length > 0 ||
    activeOrchestrationRuns.length > 0,
  );

  return {
    goal,
    sessionPlans,
    plan,
    runningBashWorks,
    runningSubagentWorks,
    runningWorkflowRuns,
    activeOrchestrationRuns,
    hasStatusContent,
    hasContent: Boolean(input.hasGitTools) || hasStatusContent,
  };
}

/**
 * 编排计划分区只收活动 run：终态 run 的结果已经由主会话的收尾消息和 completion
 * 通知呈现，留在面板里会和下一次 run 的活动行抢位置。计数与步骤顺序都直接来自只读投影。
 */
function buildActiveOrchestrationRuns(
  runs: readonly OrchestrationRunProjection[] | undefined,
): ConversationStatusPanelOrchestrationRun[] {
  return (runs ?? []).flatMap((run) => {
    if (!run.active) return [];
    let completedCount = 0;
    let runningCount = 0;
    for (const step of run.steps) {
      if (step.status === "completed") completedCount += 1;
      else if (step.status === "running") runningCount += 1;
    }
    return [{ run, completedCount, runningCount, totalCount: run.steps.length }];
  });
}
