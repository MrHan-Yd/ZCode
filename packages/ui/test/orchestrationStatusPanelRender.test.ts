import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@zcode/services";
import {
  BUILT_IN_SUBAGENT_DEFINITIONS,
  ZCODE_AGENT_PROVIDER,
  type AgentSummary,
} from "@zcode/shared";
import { SUBAGENT_TEXT_COLOR_CLASS } from "@/lib/subagentColors.js";
import { getSubagentsContextKey, useSubagentsContextStore } from "@/store/subagentsContextStore.js";
import { useSubagentsStore } from "@/store/subagentsStore.js";
import type {
  OrchestrationRunProjection,
  RunningSubagentSummary,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationStatusPanel } from "@/v4/ConversationStatusPanel.js";

const RUN: OrchestrationRunProjection = {
  runId: "run-1",
  planId: "status-panel-orchestration",
  revision: 1,
  generation: 1,
  status: "running",
  team: ["general-purpose", "Explore", "frontend", "reviewer"],
  maxConcurrency: 3,
  startedAt: 1_767_225_600_000,
  updatedAt: 1_767_225_630_000,
  active: true,
  steps: [
    {
      stepId: "spec",
      title: "更新 spec",
      role: "general-purpose",
      status: "completed",
      dependsOn: [],
      attempts: 1,
      startedAt: 1_767_225_600_000,
      endedAt: 1_767_225_610_000,
    },
    {
      stepId: "frontend",
      title: "实现入口",
      role: "frontend",
      status: "running",
      dependsOn: ["spec"],
      attempts: 1,
      startedAt: 1_767_225_610_000,
      childSessionId: "child-frontend",
    },
    {
      stepId: "review",
      title: "审查实现",
      role: "reviewer",
      status: "pending",
      dependsOn: ["frontend"],
      attempts: 0,
    },
  ],
};

function renderPanel(
  locale: "zh-CN" | "en-US",
  runs: readonly OrchestrationRunProjection[] = [RUN],
  workspaceIdentity?: string,
): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(
        TooltipProvider,
        null,
        createElement(ConversationStatusPanel, {
          workspacePath: "/workspace",
          workspaceIdentity,
          parentSessionId: "session-1",
          open: true,
          orchestrationRuns: runs,
          orchestrationSectionOpen: true,
          onOrchestrationSectionOpenChange: () => {},
          onStopOrchestrationRun: () => {},
          onRequestOrchestrationReplan: () => {},
          onOpenSubagentSession: () => {},
        }),
      ),
    }),
  );
}

const RUNNING_SUBAGENTS: readonly RunningSubagentSummary[] = [
  {
    childSessionId: "child-frontend",
    subagentType: "frontend",
    title: "实现入口",
    status: "running",
    startedAt: 1_767_225_610_000,
  },
  {
    childSessionId: "child-reviewer",
    subagentType: "reviewer",
    title: "审查实现",
    status: "waiting",
    startedAt: 1_767_225_620_000,
  },
  {
    childSessionId: "child-blocked",
    subagentType: "general-purpose",
    title: "等待权限",
    status: "blocked",
    startedAt: 1_767_225_630_000,
  },
];

function renderSubagentPanel(
  runningSubagents: readonly RunningSubagentSummary[] = RUNNING_SUBAGENTS,
  workspaceIdentity?: string,
  onCancelBackgroundWork?: (workId: string) => void,
  endedSubagentCount = 0,
): string {
  // useSessionPerformanceBatch 只在渲染期读取 zcodeAgentService；SSR 不执行 effect，
  // 因此这里只需要一个带该方法的最小 accessor，不触发任何请求。
  const services = {
    zcodeAgentService: {
      readSessionPerformanceBatch: async () => ({ entries: [] }),
    },
  } as unknown as IServiceAccessor;
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(ServiceProvider, {
        services,
        children: createElement(
          TooltipProvider,
          null,
          createElement(ConversationStatusPanel, {
            workspacePath: "/workspace",
            workspaceIdentity,
            parentSessionId: "session-1",
            open: true,
            runningSubagents,
            endedSubagentCount,
            agentSectionOpen: true,
            onAgentSectionOpenChange: () => {},
            onOpenSubagentDirectory: () => {},
            ...(onCancelBackgroundWork ? { onCancelBackgroundWork } : {}),
          }),
        ),
      }),
    }),
  );
}

function stepRowHtml(html: string, stepId: string): string {
  const start = html.indexOf(`data-orchestration-step-id="${stepId}"`);
  assert.ok(start >= 0, `missing step ${stepId}`);
  const end = html.indexOf("</li>", start);
  assert.ok(end > start, `unterminated step ${stepId}`);
  return html.slice(start, end);
}

test("状态面板的计划分区渲染 run、步骤、等待依赖与动作", () => {
  const html = renderPanel("zh-CN");

  assert.match(html, /编排计划/u);
  // planId 可截断、修订号独立存在：两者不再拼成同一个截断串。
  assert.match(html, /status-panel-orchestration/u);
  assert.match(html, />r1</u);
  assert.ok(html.includes('data-orchestration-run-id="run-1"'));
  assert.ok(html.includes('data-orchestration-step-id="spec"'));
  assert.ok(html.includes('data-step-status="running"'));
  assert.match(html, /更新 spec/u);
  assert.match(html, /frontend/u);
  assert.match(html, /等待 frontend/u);
  // 运行级动作都在计划分区里，图标按钮由 aria-label 承载可读名称。
  assert.match(html, /aria-label="停止"/u);
  assert.match(html, /aria-label="重排"/u);
  // 步骤行只做总览：子会话入口留在智能体分区与已结束目录，步骤行不再是按钮。
  assert.ok(!html.includes("查看子会话"));
  assert.ok(!stepRowHtml(html, "frontend").includes("<button"));
});

test("面板只有一个滚动视口：分区内部不再限高自滚", () => {
  const html = renderPanel("zh-CN");

  assert.ok(html.includes('data-status-panel-scroll="panel"'));
  assert.ok(!html.includes("data-status-section-scroll"));
});

test("计划步骤沿用进程分区图标：运行中静态箭头、已完成弱色，不使用加载动画与删除线", () => {
  const html = renderPanel("zh-CN");

  // 运行中步骤：静态 → 图标，整个面板不再出现旋转加载图标。
  const runningRow = stepRowHtml(html, "frontend");
  assert.ok(runningRow.includes("lucide-arrow-right"));
  assert.ok(!runningRow.includes("animate-spin"));
  assert.ok(!html.includes("animate-spin"));
  // 行尾只保留紧凑时长值，不再复制「已运行 X」句子。
  assert.ok(!runningRow.includes("已运行"));
  assert.match(runningRow, /小时|分|秒/u);

  // 已完成步骤：✓ + 弱色表达完成，不再整行删除线。
  const completedRow = stepRowHtml(html, "spec");
  assert.ok(completedRow.includes("lucide-circle-check"));
  assert.ok(!completedRow.includes("line-through"));
  assert.match(completedRow, /10 秒|10秒/u);

  // 待执行步骤仍是空心圆，且没有起止时间就不编造时长。
  const pendingRow = stepRowHtml(html, "review");
  assert.match(pendingRow, /lucide-circle(?!-)/u);
  assert.ok(!pendingRow.includes("lucide-circle-check"));
  assert.ok(!/秒/u.test(pendingRow));
});

test("智能体分区用前置状态图标表达 running / waiting / blocked", () => {
  const html = renderSubagentPanel();

  const rowFor = (childSessionId: string) => {
    const start = html.indexOf(`data-child-session-id="${childSessionId}"`);
    assert.ok(start >= 0, `missing subagent ${childSessionId}`);
    const end = html.indexOf("</li>", start);
    assert.ok(end > start, `unterminated subagent ${childSessionId}`);
    return html.slice(start, end);
  };

  const runningRow = rowFor("child-frontend");
  assert.ok(runningRow.includes("lucide-arrow-right"));
  assert.match(runningRow, /运行中/u);
  assert.ok(!runningRow.includes("animate-spin"));

  const waitingRow = rowFor("child-reviewer");
  assert.match(waitingRow, /lucide-circle(?!-)/u);
  assert.match(waitingRow, /等待/u);

  const blockedRow = rowFor("child-blocked");
  assert.ok(blockedRow.includes("lucide-circle-slash"));
  assert.match(blockedRow, /阻塞/u);

  assert.ok(!html.includes("animate-spin"));
});

test("运行中子智能体没有后台 work 时仍渲染 Stop，句柄回退到行自身 agentId", () => {
  // 编排调度直接进入 subagent port，没有 BackgroundTaskStarted，backgroundWorks 为空。
  const subagents: readonly RunningSubagentSummary[] = [
    {
      childSessionId: "child-orchestrated",
      agentId: "agent-orchestrated",
      subagentType: "general-purpose",
      title: "落地元数据契约",
      status: "running",
      startedAt: RUN.startedAt! + 10,
    },
  ];
  const html = renderSubagentPanel(subagents, undefined, () => {});

  // workId ≡ agentId：停止命令的身份与 runtime taskId 相同，不按标题猜。
  assert.ok(html.includes('data-testid="v4-background-work-cancel-agent-orchestrated"'));
  assert.ok(html.includes('data-work-id="agent-orchestrated"'));
  assert.match(html, /aria-label="停止运行中的子智能体"/u);
  assert.match(html, />停止</u);
});

test("只有已结束页脚时仍保留分区头下的上间距，不贴住分隔线", () => {
  const html = renderSubagentPanel([], undefined, undefined, 1);
  assert.match(html, /已结束/u);

  // 页脚行的容器必须同时有上间距；没有前一条运行行时不得多出一条 border-t。
  const endedIndex = html.indexOf("已结束");
  const containerStart = html.lastIndexOf('<div class="', endedIndex);
  assert.ok(containerStart >= 0, "missing ended footer container");
  const containerTag = html.slice(containerStart, html.indexOf(">", containerStart) + 1);
  assert.ok(containerTag.includes("pt-2"), containerTag);
  assert.ok(!containerTag.includes("border-t"), containerTag);
});

test("没有停止回调的宿主（只读/分享）不渲染不可用的 Stop", () => {
  const subagents: readonly RunningSubagentSummary[] = [
    {
      childSessionId: "child-orchestrated",
      agentId: "agent-orchestrated",
      subagentType: "general-purpose",
      title: "落地元数据契约",
      status: "running",
      startedAt: RUN.startedAt! + 10,
    },
  ];
  const html = renderSubagentPanel(subagents);

  assert.ok(!html.includes("v4-background-work-cancel"));
});

function assertIdentityColor(
  html: string,
  name: string,
  color: keyof typeof SUBAGENT_TEXT_COLOR_CLASS,
): void {
  const span = html.match(new RegExp(`<span[^>]*data-agent-name="${name}"[^>]*>`))?.[0];
  assert.ok(span, `missing identity ${name}`);
  assert.ok(span.includes(`data-agent-color="${color}"`), span);
  for (const token of SUBAGENT_TEXT_COLOR_CLASS[color].split(" ")) {
    assert.ok(span.includes(token), span);
  }
  assert.ok(!span.includes("text-warning"), span);
  assert.ok(!span.includes("text-[var(--color-destructive)]"), span);
}

test("真实 SSR 中全部内置角色在编排和智能体分区使用同源身份色，失败/阻塞状态保持独立", () => {
  const statuses = ["running", "waiting", "blocked"] as const;
  const runningSubagents = BUILT_IN_SUBAGENT_DEFINITIONS.map((definition, index) => ({
    childSessionId: `child-${definition.name}`,
    subagentType: definition.name,
    title: `task-${index}`,
    status: statuses[index % statuses.length]!,
    startedAt: RUN.startedAt! + index,
  }));
  const run = {
    ...RUN,
    steps: BUILT_IN_SUBAGENT_DEFINITIONS.map((definition, index) => ({
      stepId: `step-${definition.name}`,
      title: `task-${index}`,
      role: definition.name,
      status: index % 2 === 0 ? ("failed" as const) : ("running" as const),
      dependsOn: [],
      attempts: 1,
      startedAt: RUN.startedAt,
      error: index % 2 === 0 ? "step failed" : undefined,
    })),
  };
  const subagentsHtml = renderSubagentPanel(runningSubagents);
  // 编排纯展示 SSR 不需要 Services；身份 hook 不能偷偷新增 service 依赖或请求。
  const orchestrationHtml = renderPanel("zh-CN", [run]);
  for (const definition of BUILT_IN_SUBAGENT_DEFINITIONS) {
    assertIdentityColor(subagentsHtml, definition.name, definition.color);
    const row = stepRowHtml(orchestrationHtml, `step-${definition.name}`);
    assertIdentityColor(row, definition.name, definition.color);
    const step = run.steps.find((entry) => entry.role === definition.name)!;
    assert.ok(
      row.includes(step.status === "failed" ? "text-[var(--color-destructive)]" : "text-warning"),
    );
  }
  assert.ok(subagentsHtml.includes("text-warning"));
  assert.ok(subagentsHtml.includes("text-[var(--color-destructive)]"));
  assert.ok(subagentsHtml.includes('data-subagent-status="waiting"'));
});

test("真实 SSR 不通过 getState 兜底复用其他 workspace 的可变全局快照", () => {
  const contextState = useSubagentsContextStore.getState();
  const legacyState = useSubagentsStore.getState();
  // SSR 使用 store 初始快照；已加载配置的 identity 选择由纯函数与浏览器回归覆盖。
  const custom: AgentSummary = {
    id: "user:workspace:frontend",
    name: "frontend",
    description: "custom frontend",
    systemPrompt: "custom frontend",
    path: "/workspace/agents/frontend.md",
    enabled: true,
    scope: "workspace",
    source: "user",
    color: "deepBlue",
  };
  const key = getSubagentsContextKey("/workspace", ZCODE_AGENT_PROVIDER, "remote-a");
  try {
    useSubagentsContextStore.setState({
      contexts: {
        [key]: {
          workspacePath: "/workspace",
          workspaceIdentity: "remote-a",
          provider: ZCODE_AGENT_PROVIDER,
          agents: [custom],
          capability: null,
          loading: false,
          loaded: true,
          error: null,
        },
      },
    });
    useSubagentsStore.setState({
      agents: [{ ...custom, color: "fuchsia" }],
      loadedWorkspacePath: "/workspace",
      loadedWorkspaceIdentity: "remote-a",
      loadedProvider: ZCODE_AGENT_PROVIDER,
    });
    assertIdentityColor(renderPanel("zh-CN", [RUN], "remote-b"), "frontend", "teal");
    assertIdentityColor(renderSubagentPanel(RUNNING_SUBAGENTS, "remote-b"), "frontend", "teal");
    assertIdentityColor(renderPanel("zh-CN", [RUN], "remote-c"), "frontend", "teal");
    assertIdentityColor(renderSubagentPanel(RUNNING_SUBAGENTS, "remote-c"), "frontend", "teal");
  } finally {
    useSubagentsContextStore.setState(contextState, true);
    useSubagentsStore.setState(legacyState, true);
  }
});

test("计划分区随 locale 切换，不改动角色名与标题", () => {
  const html = renderPanel("en-US");
  assert.match(html, /Orchestration plan/u);
  assert.match(html, /更新 spec/u);
  assert.match(html, /aria-label="Stop"/u);
  assert.match(html, /aria-label="Replan"/u);
});

function renderStatusCardPanel(open: boolean, locale: "zh-CN" | "en-US" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: locale,
      children: createElement(
        TooltipProvider,
        null,
        createElement(ConversationStatusPanel, {
          workspacePath: "/workspace",
          parentSessionId: "session-1",
          open,
          orchestrationRuns: [RUN],
          orchestrationSectionOpen: true,
          onOrchestrationSectionOpenChange: () => {},
          onStopOrchestrationRun: () => {},
          onRequestOrchestrationReplan: () => {},
          onOpenSubagentSession: () => {},
        }),
      ),
    }),
  );
}

function cardHtml(html: string, testId: string): string {
  const start = html.indexOf(`data-testid="${testId}"`);
  assert.ok(start >= 0, `missing ${testId}`);
  const end = html.indexOf("</aside>", start);
  assert.ok(end > start, `unterminated ${testId}`);
  return html.slice(start, end);
}

function renderEmptyStatusPanel(open: boolean): string {
  return renderToStaticMarkup(
    createElement(ZCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(
        TooltipProvider,
        null,
        createElement(ConversationStatusPanel, {
          workspacePath: "/workspace",
          parentSessionId: "session-1",
          open,
        }),
      ),
    }),
  );
}

test("标题栏图标未唤醒时面板不渲染", () => {
  assert.equal(renderStatusCardPanel(false), "");
  assert.equal(renderEmptyStatusPanel(false), "");
});

test("唤醒后面板渲染在会话区顶部，只包含状态分区", () => {
  const html = renderStatusCardPanel(true);
  const statusCard = cardHtml(html, "chat-status-sections-panel");

  assert.ok(statusCard.includes('data-state="expanded"'));
  assert.ok(statusCard.includes('data-orchestration-run-id="run-1"'));
  assert.ok(!statusCard.includes('data-status-section="environment"'));
  // 面板锚在会话区顶部（与标题栏图标同侧），不贴输入框底部。
  assert.ok(html.includes("absolute right-4 top-0 z-20 pt-4"));
  // Git 已迁到标题栏浮层：面板里不再渲染旧摘要面板或 Git chip。
  assert.ok(!html.includes('data-testid="chat-summary-panel"'));
  assert.ok(!html.includes("data-summary-chip"));
});

test("唤醒但没有状态内容：渲染空态，图标点击不静默失效", () => {
  const html = renderEmptyStatusPanel(true);
  const statusCard = cardHtml(html, "chat-status-sections-panel");

  assert.ok(statusCard.includes('data-status-section="empty"'));
  assert.match(statusCard, /当前没有进行中的计划、终端或智能体/u);
});
