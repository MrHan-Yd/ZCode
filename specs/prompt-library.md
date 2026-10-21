# 提示词库（Prompt Library）

- 状态：设计稿，待评审
- 日期：2026-10-21
- 范围：桌面端、Web、手机 Web
- 目标读者：实现者、测试、评审

## 0. 结论摘要

| 决策         | 结论                                                                          |
| ------------ | ----------------------------------------------------------------------------- |
| 唤醒符号     | `;`，同时接受中文全角 `；`；必须位于行首或空白之后                            |
| 数据归属     | 用户级全局库，不区分 workspace；所有 workspace、远程会话、手机 Web 共用同一份 |
| 持久化       | 独立 JSON 文件 `~/.zcode/v2/prompt-library.json` + 专用 Host 服务             |
| 插入语义     | 纯文本插入到输入框，保留换行，不使用 chip / `PromptMentionNode`               |
| 设置入口     | 设置 › Agent 能力 › 提示词库，位于「命令」之后                                |
| 设置页层级   | 列表页 → 独立编辑视图，与 `CommandsSection` / `CommandForm` 同构              |
| 协议改动     | 不改 `zcode-protocol`；新增 RPC Channel 与 `RemoteServiceAccess` getter       |
| 列表操作     | 每行提供置顶与删除；删除需二次确认，不进入编辑视图                            |
| 同步         | 复用 MCP 同款 GitHub 私有 Gist 同步：上传、下载、状态、密钥告警、备份还原     |
| Phase 1 不做 | workspace 级、chip、变量占位、跨窗口实时同步、团队共享                        |

## 1. 目标与非目标

### 1.1 目标

1. 用户可以在设置中创建、编辑、删除、搜索、置顶常用提示词。
2. 用户在聊天输入框中输入 `;`（或 `；`）即可打开提示词选择面板，选中后把正文插入输入框。
3. 提示词是纯文本资产，插入后仍可自由编辑，不绑定会话、不自动发送。
4. 桌面、Web、远程 workspace、手机 Web 读取同一份用户级数据。

### 1.2 非目标（Phase 1）

- 不做 workspace 级 / 项目级提示词，不写入项目目录，不进入 git。
- 不做模板变量、片段占位符、自动补全嵌套。
- 不做插入为 chip 或消息级引用。
- 不做云同步、Gist 同步、团队共享。
- 不做拖拽手动排序，不做文件夹/集合。
- 不做自动发送；插入后由用户确认发送。

## 2. 唤醒符号

### 2.1 现有占用

`packages/ui/src/lib/promptInputTriggers.ts` 当前定义：

```ts
export type PromptInputTrigger = "/" | "@" | "$" | "#";
```

| 符号             | 能力                         |
| ---------------- | ---------------------------- |
| `/`              | 斜杠命令、技能、子代理、MCP  |
| `@`              | 文件、白板、插件             |
| `#`              | 会话                         |
| `$` / `¥` / `￥` | 技能（`¥` 为中文输入法别名） |
| `+`              | 输入框动作菜单（非键入触发） |

### 2.2 候选对比

| 候选 | 键盘位                   | 中文 IME        | 误触风险                                       | 结论      |
| ---- | ------------------------ | --------------- | ---------------------------------------------- | --------- |
| `;`  | 主键区右手小指，免 Shift | 同一键输出 `；` | 中英文分号通常紧贴前一个 token，不满足前置空白 | **采用**  |
| `~`  | 需要 Shift，部分布局更远 | `～`            | 低，但键位与语义一般                           | 备选      |
| `!`  | Shift+1                  | `！`            | 代码取反、感叹句高频                           | 不采用    |
| `:`  | Shift+;                  | `：`            | YAML、类型注解、中文「注意：」高频             | 不采用    |
| `>`  | Shift+.                  | `＞`            | 行首 Markdown 引用 `> ` 必然误触               | 拒绝      |
| `^`  | Shift+6                  | `＾`            | 正则/数学语义冲突，键位不直观                  | 拒绝      |
| `;;` | 两键                     | 混合全半角      | 误触最低，但破坏单字符 token 不变量            | P2 再评估 |

### 2.3 采用规则

```text
(^ | 行首) (空白) ; 或 ； (任意非空白、非分号字符序列) 光标
```

- 只接受行首或空白后（空格、Tab、换行、NBSP、全角空格 U+3000）。
- 不接受汉字或中文标点作为前置字符。否则中文正文里的 `；` 会频繁弹面板并截获 Enter/方向键。
- `；` 只作为触发别名，不重写用户实际输入的字符。
- 面板打开后，`;` 本身保留在文本中；插入时连同 query 一起替换。
- 输入框 `disabled`（运行中禁用）时不打开。

以下情况**不触发**：

```text
你好；世界          // 前置是汉字
const a = 1;        // 前置是空格，但光标不在分号后
foo;bar             // 前置不是空白
https://a.com;x     // 前置不是空白
@foo;bar            // @ mention 查询仍包含分号
```

### 2.4 精确改动

`packages/ui/src/lib/promptInputTriggers.ts`：

```ts
export type PromptInputTrigger = "/" | "@" | "$" | "#" | ";";

// `;` 为提示词库；`；` 为中文输入法全角别名。
const ACTIVE_TRIGGER_RE = /(^|\s)([/@$#¥￥;；])([^\s/@$#¥￥;；]*)$/;

// 保持 @ 的 query 字符集不变：Unix 文件名可以包含 `;`，
// 不能让 `@foo;bar` 因为新触发器而无法继续作为文件 mention 查询。
const ACTIVE_MENTION_TRIGGER_RE =
  /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])(@)([^\s/@$#¥￥]*)$/u;

const ACTIVE_TRIGGER_TAIL_RE = /^[^\s/@$#¥￥;；]*/;
```

`normalizePromptInputTriggerAlias` 增加：

```ts
if (trigger === "；") {
  return ";";
}
```

`getActivePromptInputTokenTailLength` 的候选值清理正则增加 `;；`：

```ts
const candidate = rawCandidate.trim().replace(/^[/@$#¥￥;；]+/, "");
```

注意：

- 不要修改 `ACTIVE_MENTION_TRIGGER_RE` 的字符集。
- 不要放宽前置条件到 `\p{Script=Han}`。
- 新增 `;` 后，所有 `switch (trigger)` 与 `if (trigger !== ...)` 调用点需要回归检查；当前主要调用点在 `MentionPlugin`、`SlashCommandPlugin`、`mentionPanelRouting` 与 `activePromptInputToken`。

## 3. 信息架构与页面

### 3.1 设置导航

| 项         | 值                                                           |
| ---------- | ------------------------------------------------------------ |
| 分组       | `agentCapabilities`（Agent 能力）                            |
| 位置       | 「命令」之后、「自动化」之前                                 |
| section id | `promptLibrary`                                              |
| 导航名称   | 提示词库 / Prompt Library                                    |
| 图标       | `LibraryBig` 或 `BookMarked`（与「命令」的 `Terminal` 区分） |
| 页面标题   | `settings.promptLibrary.title`，沿用设置页 shell 渲染        |
| 导航持久化 | 沿用 `writeLastSettingsSectionPreference`                    |

放在「命令」旁边的理由：两者都是用户自建、可复用的输入侧资产；命令是「执行动作」，提示词库是「插入文本」。

### 3.2 页面层级

```text
设置（SettingsPage）
└─ 提示词库（列表）                          activeSection = "promptLibrary"
   └─ 新建 / 编辑提示词（同一内容区切换）      组件内部 view = "editor"
```

- 列表 → 编辑：点击行、Enter，或「新建」按钮。
- 编辑 → 列表：保存成功、取消、删除成功、面包屑根节点。
- 编辑态切换左侧其他分区、返回工作区、按 Esc：先走未保存拦截。
- 保存成功后保留搜索与排序；若当前搜索不匹配新记录，清空搜索并滚动到该行。

### 3.3 桌面宽屏线框

```text
┌──────────────────────┬──────────────────────────────────────────────────────────────────┐
│ ‹ 返回工作区          │  提示词库                                                        │
│                      ├──────────────────────────────────────────────────────────────────┤
│ 基础设置              │                                                                  │
│                      │  提示词库                                              [+ 新建]   │
│ Agent 能力            │  保存常用提示词，在输入框输入 ; 即可快速插入。                      │
│   记忆                │                                                                  │
│   子智能体            │  [ 搜索名称、内容或标签…                              ]  [排序：最近使用 ▾] │
│   插件                │                                                                  │
│   MCP                 │  置顶  2                                                          │
│   技能                │  ┌────────────────────────────────────────────────────────────┐  │
│   命令                │  │ [P]  代码审查                    ;review        #代码 #审查  │  │
│ ▸ 提示词库            │  │      审查以下代码，指出潜在 bug…                 2 天前使用 [P]│  │
│   自动化              │  ├────────────────────────────────────────────────────────────┤  │
│   钩子                │  │ [P]  周报整理                    ;weekly        #周报        │  │
│                      │  │      汇总本周完成事项与风险…                     从未使用   [P]│  │
│ 数据与统计            │  └────────────────────────────────────────────────────────────┘  │
│   使用统计            │                                                                  │
│   归档管理            │  全部提示词  6                                                    │
│                      │  ┌────────────────────────────────────────────────────────────┐  │
│                      │  │ [ ]  邮件润色                    ;mail          #写作 #邮件  │  │
│                      │  │      把这段文字改写得礼貌、简洁…                 3 天前使用 [ ]│  │
│                      │  ├────────────────────────────────────────────────────────────┤  │
│                      │  │ [ ]  会议纪要                    ;minutes                    │  │
│                      │  │      从以下记录中提炼决议、待办与负责人…         从未使用   [ ]│  │
│                      │  └────────────────────────────────────────────────────────────┘  │
└──────────────────────┴──────────────────────────────────────────────────────────────────┘
```

说明：

- `[P]` 为置顶按钮，`aria-pressed` 表达状态；行内其余区域点击进入编辑。
- 别名显示为 `;review`，使用 `font-mono text-ui-xs text-foreground-subtlest`。
- 标签最多显示 3 个，超出显示 `+N`；手机端最多 2 个。
- 「上次使用」使用现有相对时间格式化函数；从未使用显示弱文案。

### 3.4 窄屏与手机 Web

窄屏（`max-lg`，导航收成图标栏）：

```text
┌──────┬──────────────────────────────────────────────────┐
│  ←   │  提示词库                              [+ 新建]   │
│  ⚙   │  保存常用提示词，在输入框输入 ; 即可快速插入。      │
│  ◐   │                                                  │
│  ◇   │  [ 搜索名称、内容或标签…            ]   [排序 ▾]  │
│  ◎   │                                                  │
│  ▣   │  置顶  2                                          │
│  ▤   │  ┌────────────────────────────────────────────┐  │
│  ▸   │  │ [P] 代码审查                  ;review      │  │
│  ◷   │  │     审查以下代码…            2 天前 [P]     │  │
│      │  └────────────────────────────────────────────┘  │
│      │  全部提示词  6                                    │
│      │  ┌────────────────────────────────────────────┐  │
│      │  │ [ ] 邮件润色                  ;mail        │  │
│      │  │     把这段文字改写…          3 天前 [ ]     │  │
│      │  └────────────────────────────────────────────┘  │
└──────┴──────────────────────────────────────────────────┘
```

手机 Web 列表（390px）：

```text
┌────────────────────────────────────┐
│ ‹ 设置                    提示词库   │
├────────────────────────────────────┤
│ 保存常用提示词，输入 ; 唤醒          │
│ ┌────────────────────────────────┐ │
│ │ 搜索提示词                       │ │
│ └────────────────────────────────┘ │
│ [最近使用 ▾]              [+ 新建]  │
│                                    │
│ 置顶  2                             │
│ ┌────────────────────────────────┐ │
│ │ [P] 代码审查                    │ │
│ │     审查以下代码，指出潜在 bug…  │ │
│ │     #代码 #审查        2 天前    │ │
│ └────────────────────────────────┘ │
│ ┌────────────────────────────────┐ │
│ │ [ ] 周报整理                    │ │
│ │     汇总本周完成事项与风险…      │ │
│ │     #周报              从未使用  │ │
│ └────────────────────────────────┘ │
└────────────────────────────────────┘
```

手机 Web 编辑（全屏）：

```text
┌────────────────────────────────────┐
│ ‹ 提示词库                  [更多 ⋯] │
├────────────────────────────────────┤
│ 编辑提示词                           │
│                                    │
│ 名称 *                    12 / 60   │
│ [ 代码审查                        ] │
│                                    │
│ 内容 *               1,248 / 8,000  │
│ ┌────────────────────────────────┐ │
│ │ 请审查以下代码，按严重程度排序…  │ │
│ │                                │ │
│ └────────────────────────────────┘ │
│                                    │
│ 标签（最多 5 个）                    │
│ [代码 ×] [审查 ×]                   │
│ [ 输入后按 Enter 添加…            ] │
│                                    │
│ 快捷键别名（可选）                   │
│ [ review                          ] │
│ 输入 ;review 可优先匹配              │
├────────────────────────────────────┤
│  [取消]                    [保存]   │  ← sticky 底部操作条
└────────────────────────────────────┘
```

手机端规则：

- 触控目标 ≥ 44×44；行高 ≥ 72px。
- 输入控件使用 `text-mobile-input-safe`（16px）防止 iOS 聚焦缩放；其余文本使用 `text-ui-*`。
- 保存/取消使用 sticky 底栏，计入 `env(safe-area-inset-bottom)`。
- 删除收进「更多」菜单，仍需二次确认。

### 3.5 空态、搜索无结果、错误

```text
空库                                       搜索无结果
┌────────────────────────────────────┐    ┌────────────────────────────────────┐
│        还没有保存的提示词            │    │        没有匹配的提示词。            │
│  新建一条提示词，之后在输入框输入 ;   │    │         [ 清除搜索 ]                │
│  即可快速插入。                      │    └────────────────────────────────────┘
│            [+ 新建提示词]            │
└────────────────────────────────────┘
```

- 复用 `PluginInstallEmptyState`、`PluginSearchEmptyState`、`PluginLoadingState`。
- 加载失败但已有旧快照：保留旧列表，顶部显示可关闭的错误条，不阻塞编辑。
- 加载失败且无缓存：显示错误行与「重试」。

### 3.6 编辑表单

| 字段       | 控件                   | 必填 | 上限               | 说明                                                    |
| ---------- | ---------------------- | ---- | ------------------ | ------------------------------------------------------- |
| 名称       | `Input size="lg"`      | 是   | 60 字符            | 计数器右对齐；超限禁用保存                              |
| 内容       | `SettingsFormTextarea` | 是   | 8,000 字符         | 保留原始换行与缩进；`min-h-40`、`max-h-[50vh]` 内部滚动 |
| 标签       | 标签输入 + chips       | 否   | 5 个，每个 20 字符 | Enter/逗号提交；大小写不敏感去重；仅用于搜索            |
| 快捷键别名 | `Input` + `font-mono`  | 否   | 24 字符            | 仅 `[a-z0-9_-]`；保存时转小写；全局唯一                 |

规则：

- 名称允许重名；别名必须唯一。这样用户可以保存同一主题的不同版本。
- 内容按原样保存，不做 trim 写入；仅用 `content.trim().length > 0` 判空。
- 粘贴超限不静默截断：允许进入，计数器转破坏色并禁用保存。
- 内容下方除「按纯文本插入，换行会保留」外，再提示「以 `/`、`$`、`@` 开头的内容发送时可能被识别为命令或提及」。
- `Cmd/Ctrl+S` 保存；保存中按钮显示 `common.saving`。
- `dirty` 判定比较规范化后的名称、内容、标签集合、别名。
- 未保存拦截覆盖：取消、Esc、面包屑根节点、左侧导航切区、返回工作区、手机端返回；Web 额外注册 `beforeunload`。
- 删除只在编辑态提供，使用 `useConfirmDialog`，默认焦点在「取消」。

### 3.7 视觉规范

- 全部使用语义 token：`bg-background`、`bg-surface`、`bg-hover`、`bg-selected`、`bg-menu`、`border-border`、`text-foreground`、`text-foreground-subtle`、`text-foreground-subtlest`。
- 字号只使用 `text-ui-*`，禁止裸 `text-14px`。
- 列表容器 `rounded-xl bg-surface`；行 `px-4 py-3`；编辑卡片 `rounded-xl border border-border p-4`。
- 置顶/取消置顶同时提供 `aria-pressed` 与图标状态，不只靠颜色。
- 暗色主题下不使用 `bg-black`、`text-white/60` 等原始透明度。
- 已知偏差：`MentionPanel` 当前外壳为 `rounded-2xl`，而 `DESIGN.md` 要求建议面板使用 `rounded-lg`。Phase 1 复用共享组件不单独改半径；另立迁移项统一 `/`、`@`、`;` 三个面板。

## 4. 数据模型

文件：`packages/shared/src/prompt-library.ts`

```ts
export interface PromptTemplate {
  id: string; // "pl_<uuid>"，Host 生成
  title: string; // 1..60，去首尾空白
  content: string; // 1..8000，保留换行
  tags: string[]; // 0..5，每个 1..20
  alias?: string; // 可选，[a-z0-9_-]{1,24}，全局唯一
  pinned: boolean;
  lastUsedAt?: number; // epoch ms
  createdAt: number;
  updatedAt: number;
}

export interface PromptTemplateSummary extends Omit<PromptTemplate, "content"> {
  contentPreview: string; // 正文前 200 字，换行压成空格
}

export interface PromptLibraryFileV1 {
  version: 1;
  updatedAt: number;
  items: PromptTemplate[];
}

export const PROMPT_LIBRARY_LIMITS = {
  maxItems: 500,
  maxTitleLength: 60,
  maxContentLength: 8000,
  maxTags: 5,
  maxTagLength: 20,
  maxAliasLength: 24,
  maxFileBytes: 8 * 1024 * 1024,
} as const;
```

规则：

- ID 只由 Host 生成，客户端提交的 ID 一律忽略。
- 正文 CRLF 归一为 LF；拒绝 `\u0000` 等 C0 控制字符（`\n`、`\t` 除外）。
- `updatedAt = Math.max(Date.now(), current.updatedAt + 1)`，保证同毫秒内可排序。`recordUsage` 只更新 `lastUsedAt`，不推进单条记录的 `updatedAt`，避免“最近修改”排序被使用行为干扰。
- 排序：`pinned` 优先，其次按视图排序模式：
  - `recentUsed`：`lastUsedAt DESC`，未使用排后；
  - `recentUpdated`：`updatedAt DESC`；
  - `name`：`localeCompare`。
- 排序偏好是视图偏好，存 `localStorage`（`zcode-prompt-library-sort`），不写入记录。
- Phase 1 只有用户级；API 不接收 `workspacePath` / `workspaceIdentity` / `remoteSessionId`。

## 5. 服务与持久化

### 5.1 方案选择

| 方案                        | 结论     | 理由                                                                       |
| --------------------------- | -------- | -------------------------------------------------------------------------- |
| `setting.json`              | 不采用   | 用户内容混入 App 配置，每次编辑重写整个设置文件，且会进入设置广播/同步语义 |
| 独立 JSON 文件 + 专用服务   | **采用** | 用户内容隔离、可备份、可手工查看、原子写                                   |
| SQLite                      | 不采用   | 数据量小、无查询需求，迁移与原生依赖成本高                                 |
| 复用 `.zcode/commands/*.md` | 不采用   | 命令带「可执行 slash」语义，会混入 `/` 面板，且项目目录会进 git            |

### 5.2 文件

- 主文件：`join(getAppConfigDir(), "prompt-library.json")`
  - `getAppConfigDir()` = `{dataBaseDir}/.zcode/v2`，定义在 `packages/services/src/paths.ts`。
- 备份：`prompt-library.json.bak`，保存上一次成功写入前的有效内容。
- 损坏隔离：复用 `backupCorruptFile()`，生成 `prompt-library.json.corrupt-<hash>.bak`。

### 5.3 服务契约

`packages/services/src/prompt-library/promptLibrary.ts`（browser-safe，只依赖 `@zcode/shared` 与 `../descriptors.js`）：

```ts
export type PromptLibraryFailureReason =
  | "invalid-title"
  | "invalid-content"
  | "invalid-tags"
  | "invalid-alias"
  | "alias-conflict"
  | "too-many-items"
  | "not-found"
  | "conflict"
  | "unsupported-version"
  | "corrupt"
  | "io-error";

export interface PromptLibraryWarning {
  code: "corrupt-recovered" | "corrupt-quarantined" | "unsupported-version";
  message: string;
  quarantinePath?: string;
  version?: number;
}

export interface PromptLibraryListResult {
  items: PromptTemplateSummary[];
  warning: PromptLibraryWarning | null;
  readOnly: boolean;
}

export type PromptLibraryGetResult =
  | { ok: true; item: PromptTemplate }
  | { ok: false; reason: PromptLibraryFailureReason; message?: string };

export type PromptLibraryMutationResult =
  | { ok: true; item: PromptTemplate }
  | {
      ok: false;
      reason: PromptLibraryFailureReason;
      message?: string;
      current?: PromptTemplateSummary;
    };

export interface PromptTemplateInput {
  title: string;
  content: string;
  tags?: string[];
  alias?: string;
}

export interface IPromptLibraryService {
  list(): Promise<PromptLibraryListResult>;
  get(params: { id: string }): Promise<PromptLibraryGetResult>;
  create(params: PromptTemplateInput): Promise<PromptLibraryMutationResult>;
  update(
    params: PromptTemplateInput & { id: string; expectedUpdatedAt?: number },
  ): Promise<PromptLibraryMutationResult>;
  /** 幂等：未知 id 视为成功。 */
  remove(params: {
    id: string;
  }): Promise<{ ok: true } | { ok: false; reason: PromptLibraryFailureReason; message?: string }>;
  setPinned(params: { id: string; pinned: boolean }): Promise<PromptLibraryMutationResult>;
  /** best-effort；失败不影响插入。 */
  recordUsage(params: { id: string }): Promise<void>;
  /** 损坏恢复：先备份当前文件，再写入空 v1。 */
  reset(): Promise<
    { ok: true } | { ok: false; reason: PromptLibraryFailureReason; message?: string }
  >;
}

export const IPromptLibraryService = createServiceDescriptor<IPromptLibraryService>(
  ServiceChannels.PromptLibrary,
);
```

预期失败使用可序列化 result union，不抛带自定义字段的 Error；只有传输/进程级失败才抛异常。

### 5.4 写入流程

```text
withFileLock(filePath, async () => {
  1. 读取当前文件；ENOENT 视为空 v1
  2. 解析 + zod 校验
  3. 若损坏：quarantine 原文件，尝试 .bak
  4. 若当前有效：best-effort 写 .bak
  5. 组装 next file
  6. atomicWritePrivateTextFile(filePath, JSON.stringify(next, null, 2))
})
```

关键约束：

- 整个 read-modify-write 必须包在 `withFileLock` 内，防止两个窗口同时创建时丢失更新。
- 锁内使用 `atomicWritePrivateTextFile`，不要再调用带默认锁的 `atomicWriteText`，避免同路径嵌套锁。
- `list()` / `get()` 不加锁：原子 rename 保证读到完整旧文件或完整新文件。
- 文件读取前 `stat`，超过 `maxFileBytes` 视为损坏并只读，避免异常文件阻塞 Host。
- `version > 1` 时返回 `unsupported-version`，所有写操作拒绝，防止旧版本覆盖新数据。

### 5.5 损坏恢复顺序

1. `backupCorruptFile` 隔离原始字节。
2. 尝试 `.bak`；有效则恢复主文件并返回 `corrupt-recovered`。
3. `.bak` 也无效则返回 `corrupt-quarantined` + `readOnly: true`，不自动覆盖。
4. 设置页显示警告与「重建空库」，调用 `reset()`。

### 5.6 服务注册与注入

| 层             | 文件                                                           | 改动                                                                                    |
| -------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| channel        | `packages/shared/src/channels.ts`                              | `PromptLibrary: "prompt-library"`                                                       |
| contract       | `packages/services/src/prompt-library/promptLibrary.ts`        | 接口 + descriptor                                                                       |
| impl           | `packages/services/src/prompt-library/promptLibraryService.ts` | `createPromptLibraryService({ filePath?, now?, idFactory? })`                           |
| accessor       | `packages/services/src/accessor.ts`                            | `readonly promptLibraryService?: IPromptLibraryService`（可选，兼容旧 Host / 测试替身） |
| browser 出口   | `packages/services/src/index.ts`                               | 只导出 descriptor 和类型                                                                |
| node 出口/注册 | `packages/services/src/node.ts`                                | 导出工厂；在 `createLocalServices` 中 `.register(IPromptLibraryService, ...)`           |
| Web 代理       | `packages/client/src/remoteServiceAccess.ts`                   | 增加 `promptLibraryService` getter                                                      |

注入结论：

- 设置页：`SettingsPage.tsx` 已有 `const localHostServices = useBaseWorkspaceServices()`；新分区包一层 `<ServiceProvider services={localHostServices}>`，确保激活远程 workspace 时仍读写本机 Host。
- Composer：使用 `useOptionalBaseWorkspaceServices()`，不要用 `useWorkspaceServices(workspacePath)`。
- 桌面远程 workspace：当前 workspace 服务指向远端 Host，但提示词库始终走 base/local Host。
- Web：服务在服务端 Host，renderer 通过 `RemoteServiceAccess` 访问，因此必须加 getter。
- 旧 Host / 测试替身：`promptLibraryService` 缺失时，设置页显示「当前 Host 不支持提示词库」，Composer 输入 `;` 保持普通文本。
- 不改 `zcode-protocol`，不新增 attachment、HostMessage、PlatformChannel。

## 6. 输入框链路

### 6.1 状态所有者

| 状态              | 唯一所有者                                          | 说明                                         |
| ----------------- | --------------------------------------------------- | -------------------------------------------- |
| 提示词事实源      | Host `PromptLibraryService` + JSON 文件             | 所有写入串行化                               |
| Renderer 摘要缓存 | `promptLibraryStore`（Zustand）                     | 只缓存摘要，不缓存全文                       |
| 输入框文本        | Lexical editor                                      | 插件只读选区并插入                           |
| 草稿              | `composerDraftStore`                                | 通过 `TextContentPlugin` → `onChange` 持久化 |
| 触发状态          | `PromptLibraryPlugin` 本地 state + `activeTokenRef` | 与 `MentionPlugin` 同模式                    |
| 设置表单          | `PromptLibrarySection` 本地 state                   | 保存后以 Host 返回值为准                     |
| 排序偏好          | `localStorage`                                      | 视图偏好，不写入服务                         |

### 6.2 时序

```text
用户输入 ; / ；
  → PromptLibraryPlugin 的 update listener
  → extractActivePromptInputTrigger -> { trigger: ";", query: "" }
  → 校验前置换行/空白与 disabled
  → 若 store 过期：service.list()
  → 本地过滤 + MentionPanel 渲染
  → ↑/↓ 改 selectedIndex
  → Enter/Tab/点击
  → 关闭面板 + 捕获 token 快照
  → service.get(id) 取全文
  → 重新校验 token 快照（nodeKey + tokenText）
  → 单次 editor.update：替换 ;query，插入纯文本
  → onChange → 草稿持久化
  → recordUsage(id)（best-effort，不 await）
```

### 6.3 选中触发条件

`PromptLibraryPlugin` 只在以下条件同时满足时打开：

- 未 `disabled`；
- 不在 IME 组合态（复用 `shouldFreezeMentionRecalcWhileComposing`，建议抽到 `packages/ui/src/lib/imeComposition.ts` 共用）；
- 当前 trigger 为 `;`，且前置字符为行首或空白；
- 当前 token 未被 Esc 抑制；
- 当前没有挂载的 `/`、`@`、`$`、`#` 面板（由各自的 trigger 判定天然互斥）；
- 本次编辑器更新不是以下程序化更新：
  - `HISTORY_NAVIGATION_UPDATE_TAG`：否则 ↑ 调出以 `;foo` 结尾的历史记录会重开面板并吞掉方向键（与斜杠面板曾经的 bug 相同）；
  - `PROGRAMMATIC_UPDATE_TAG`：否则草稿恢复、队列恢复、外部预填、`setText` 会误开面板；
  - `PROMPT_LIBRARY_INSERT_UPDATE_TAG`：否则插入内容以 `;foo` 结尾时会被自己的更新再次唤醒。

实现上在 update listener 开头统一判断 tag 并直接返回，不要只依赖末尾空格。

### 6.4 插入语义

- 替换范围：`tokenStart` = 触发符位置，`tokenEnd` = 光标位置。
- 空 query 时绝不吞掉光标后的正文（沿用 `getActivePromptInputTokenTailLength` 的防护）。
- 多行内容按 `\n` 拆分，行间插入 `$createLineBreakNode()`，全部放在同一段落内；不要用段落节点，否则 `getMarkdown()` 会把单换行变成双换行。
- 分隔空格：
  - token 前一个字符是非空白 → 内容前补一个空格；
  - 插入后下一个字符是非空白 → 内容后补一个空格；
  - 内容以换行结尾 → 不再补尾随空格；
  - 行首插入且内容不以空白开头 → 不加前导空格；
  - **终止不变量**：插入完成后，内容末尾必须是空白或文本结尾且已补空格。这样内容以 `;`、`@`、`/`、`$`、`#` 结尾时，后续继续输入不会落回同一个 token。
- 光标落在插入内容末尾（若补了尾随空格，落在空格之后）。
- 整次替换在一个 `editor.update` 中完成，使用专用 tag `PROMPT_LIBRARY_INSERT_UPDATE_TAG`。
- `Cmd/Ctrl+Z` 一次恢复 `;query` 与光标位置。撤销后沿用 `dismissedTokenStart` 抑制，避免恢复出的 `;query` 立即重开面板；光标离开该 token 后再清除抑制。
- 不自动发送，不改变附件、模型、权限等其他 composer 状态。
- 插入 update 必须让 `MentionPlugin` / `SlashCommandPlugin` 忽略，避免内容以 `@`、`/`、`$`、`#`、`;` 结尾时误开其他面板；新插件自己同样忽略该 tag。

### 6.5 键盘行为

| 输入                          | 行为                                                     |
| ----------------------------- | -------------------------------------------------------- |
| `↑` / `↓`                     | 移动选中，到边界夹紧，自动滚入视野                       |
| `Enter`                       | 有候选则插入并阻止换行；无候选则关闭面板并按默认行为换行 |
| `Tab`                         | 有候选则插入并阻止焦点移动；无候选保持默认焦点行为       |
| `Esc`                         | 关闭面板，保留 `;query`；同一 token 内不再自动重开       |
| `←` / `→`                     | 移动光标；token 失效时关闭                               |
| `Backspace`                   | 删除 query；删掉 `;` 后关闭                              |
| 空格 / 换行 / Tab（query 后） | token 结束，面板关闭，文本原样保留                       |
| 鼠标移动                      | 只改变 hover，不改变键盘选中项                           |
| 鼠标按下                      | `preventDefault` 保持编辑器焦点，点击即插入              |
| 点击面板外                    | 关闭，保留文本                                           |
| IME 组合中                    | 不打开、不响应选择键；组合结束后再判定                   |

字面量规则：

- `;` 后接空格：面板立即关闭，保留 `; `。
- `;` 后按 Esc 再继续输入：同 token 内不重开。
- Phase 1 不特殊处理 `\;`；反斜杠原样保留，用户需要字面量时用 Esc 或空格。

### 6.6 异步与并发边界

- 选中时先关闭面板并捕获 token 快照，再 `get(id)`；插入前重新校验快照，若用户已改动则放弃插入。
- `selectingRef` 防止重复 Enter 触发两次插入。
- `remove` 幂等；`update` 使用 `expectedUpdatedAt` 检测并返回 `conflict`，不静默覆盖。
- `recordUsage` 失败只记 warn，不阻塞插入。
- 不做跨窗口实时同步；面板打开超过 30 秒或重新打开时刷新。

### 6.7 发送链路与内联编辑

纯文本插入不会绕过发送时的既有解析：

- `parseV4VisibleSlashCommand` 会 `trim()` 后判断是否以 `/` 开头，`/plan`、`/compact`、`/compress`、`/goal`、`/target` 会被 App 消费；`parseSelectionSideSlashCommand` 会消费 `/side`、`/btw`。
- `INLINE_MENTION_TOKEN_PATTERN` 会把被行首或空白包围的 `$skill`、`/command`、`@file`、`#sess_xxx` 识别为 mention。
- 因此以 `/`、`$`、`@`、`#` 开头的提示词，发送时可能被当作命令或提及。P0 不自动转义（会改变原文），只在编辑表单内容下方展示提示：`以 /、$、@ 开头的内容发送时可能被识别为命令或提及。`

内联消息编辑复用 `ChatPromptEditor`，且已开启 mention / slash 入口。新插件挂载在 `LexicalChatInput` 上后，内联编辑同样可用 `;` 唤出提示词库；这是有意的行为一致性，不额外加开关。若后续产品决定禁用，再给 `ChatPromptEditor` 增加显式 prop。

## 7. 输入框面板 UI

### 7.1 骨架

```text
                             ┌──────────────────────────────────────────────┐
                             │ 置顶                                          │  ← 分组标题 h-8
                             │ ┌──────────────────────────────────────────┐ │
                             │ │ 代码审查   ;review   审查以下代码…  #代码  │ │  ← selected
                             │ ├──────────────────────────────────────────┤ │
                             │ │ 周报整理   ;weekly   汇总本周完成…  #周报  │ │
                             │ └──────────────────────────────────────────┘ │
                             │ 最近使用                                      │
                             │ ┌──────────────────────────────────────────┐ │
                             │ │ 邮件润色   ;mail     把这段文字改写… #邮件  │ │
                             │ └──────────────────────────────────────────┘ │
                             │ 全部提示词                                    │
                             │ ┌──────────────────────────────────────────┐ │
                             │ │ 会议纪要   ;minutes  提炼决议与待办…        │ │
                             │ └──────────────────────────────────────────┘ │
                             │ ──────────────────────────────────────────── │
                             │ ; 提示词库  ↑↓ 选择  Enter/Tab 插入  Esc 关闭 │
                             └──────────────────────────────────────────────┘
                                            │
┌──────────────────────────────────────────────────────────────────────────────┐
│ ;ema|                                                                        │
│ [+] [模型 ▾]                                                    [发送 →]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

有查询时只显示一个「搜索结果」分组。

### 7.2 行与分组

- 行高与 `MentionPanel` 一致：虚拟行 34px，可见 32px；触控 44px。
- 行结构：名称（`text-ui-base font-medium`，截断）+ 内容摘要（`text-ui-sm text-foreground-subtle`，单行，最多 120 字符）+ 标签（最多 2 个）+ 别名（`font-mono text-ui-xs`，最右）。
- 空查询分组：`置顶` → `最近使用`（未置顶，最多 5 条）→ `全部提示词`；每条只出现一次。
- 有查询：先过滤再做相关性排序，不显示分组标题（只有一个 section 时 `MentionPanel` 自动隐藏标题）。
- 过滤范围：名称、内容、标签、别名；大小写不敏感，NFKC 归一化。
- 相关性：别名精确匹配 > 名称前缀 > 名称子串 > 标签子串 > 内容子串；同分时置顶优先，再按最近使用时间。
- 不做逐字符高亮；键盘选中用 `bg-selected`，hover 用 `bg-hover`。

### 7.3 空、加载、错误

| 状态                 | 展示                                                   |
| -------------------- | ------------------------------------------------------ |
| 空库（无 query）     | `还没有保存的提示词。` + `前往 设置 › 提示词库 新建。` |
| 空库（有 query）     | `没有匹配的提示词。`                                   |
| 加载中               | 延迟 150ms 显示 `正在加载提示词…`，避免本地库闪烁      |
| 加载失败有缓存       | 显示缓存列表；composer 级 toast 提示一次               |
| 加载失败无缓存       | `提示词库加载失败。`，不阻塞输入                       |
| 记录在打开期间被删除 | 刷新并夹紧选中项；点击已删除项时 no-op 并提示          |

### 7.4 可访问性

- 编辑器：`role="textbox"`、`aria-multiline="true"`、`aria-autocomplete="list"`、`aria-expanded`、`aria-controls`、`aria-activedescendant`。
- 列表：`role="listbox"`、`aria-label="提示词库"`；行 `role="option"`、`aria-selected`。
- 焦点始终留在编辑器，不使用 roving tabindex。
- 加载/空态 `role="status"`，错误 `role="alert"`。
- 插入成功后通过 composer 级 `aria-live="polite"` 播报「已插入提示词「{name}」」。
- 设置列表行 `role="button"`、`tabIndex=0`，Enter/Space 进入编辑；置顶按钮有 `aria-label` 与 `aria-pressed`。
- 校验错误使用 `aria-invalid` + `aria-describedby`，提交时聚焦第一个错误字段。
- 触控目标手机端 ≥ 44×44。

## 8. 文案

复用 `common.save`、`common.saving`、`common.cancel`、`common.delete`、`common.retry`、`common.close`。

### 8.1 `settings.promptLibrary.*`

| Key                              | zh-CN                                               | en-US                                                                              |
| -------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| title                            | 提示词库                                            | Prompt Library                                                                     |
| description                      | 保存常用提示词，在输入框输入 ; 即可快速插入。       | Save reusable prompts and insert them from the composer with ;.                    |
| searchPlaceholder                | 搜索名称、内容或标签…                               | Search name, content, or tag…                                                      |
| sort.label                       | 排序                                                | Sort                                                                               |
| sort.recentUsed                  | 最近使用                                            | Recently used                                                                      |
| sort.recentUpdated               | 最近修改                                            | Recently updated                                                                   |
| sort.name                        | 名称                                                | Name                                                                               |
| new                              | 新建提示词                                          | New prompt                                                                         |
| edit                             | 编辑提示词                                          | Edit prompt                                                                        |
| backToList                       | 返回提示词库                                        | Back to Prompt Library                                                             |
| group.pinned                     | 置顶                                                | Pinned                                                                             |
| group.all                        | 全部提示词                                          | All prompts                                                                        |
| group.search                     | 搜索结果                                            | Search results                                                                     |
| empty.title                      | 还没有保存的提示词                                  | No saved prompts yet                                                               |
| empty.description                | 新建一条提示词，之后在输入框输入 ; 即可快速插入。   | Create your first prompt, then type ; in the composer to insert it.                |
| searchEmpty                      | 没有匹配的提示词。                                  | No prompts match your search.                                                      |
| loading                          | 正在加载提示词…                                     | Loading prompts…                                                                   |
| loadFailed                       | 提示词库加载失败。                                  | Couldn't load the prompt library.                                                  |
| pin.add                          | 置顶                                                | Pin                                                                                |
| pin.remove                       | 取消置顶                                            | Unpin                                                                              |
| row.lastUsed                     | 上次使用：{time}                                    | Last used {time}                                                                   |
| row.neverUsed                    | 从未使用                                            | Never used                                                                         |
| row.aliasHint                    | 输入 ;{alias} 快速筛选                              | Type ;{alias} to filter                                                            |
| form.name.label                  | 名称                                                | Name                                                                               |
| form.name.validation.required    | 名称不能为空                                        | Name is required                                                                   |
| form.name.validation.tooLong     | 名称不能超过 {max} 个字符                           | Name must be {max} characters or fewer                                             |
| form.content.label               | 内容                                                | Content                                                                            |
| form.content.placeholder         | 输入要插入会话的提示词…                             | Enter the prompt to insert into the conversation…                                  |
| form.content.helper              | 提示词按纯文本插入，换行会保留。                    | Prompts are inserted as plain text; line breaks are preserved.                     |
| form.content.sendHint            | 以 /、$、@ 开头的内容发送时可能被识别为命令或提及。 | Content starting with /, $, or @ may be treated as a command or mention when sent. |
| form.content.validation.required | 内容不能为空                                        | Content is required                                                                |
| form.content.validation.tooLong  | 内容不能超过 {max} 个字符                           | Content must be {max} characters or fewer                                          |
| form.tags.label                  | 标签（可选，最多 {max} 个）                         | Tags (optional, up to {max})                                                       |
| form.tags.placeholder            | 输入后按 Enter 添加                                 | Type and press Enter to add                                                        |
| form.tags.hint                   | 用于搜索和筛选，不会插入会话。                      | Used for search and filtering; tags are not inserted.                              |
| form.tags.remove                 | 移除标签 {tag}                                      | Remove tag {tag}                                                                   |
| form.alias.label                 | 快捷键别名（可选）                                  | Shortcut alias (optional)                                                          |
| form.alias.placeholder           | 例如：review                                        | e.g. review                                                                        |
| form.alias.hint                  | 输入 ;{alias} 可优先匹配该提示词。                  | Type ;{alias} to match this prompt first.                                          |
| form.alias.validation.characters | 仅允许字母、数字、连字符和下划线                    | Use letters, numbers, hyphens, and underscores only                                |
| form.alias.validation.duplicate  | 该别名已被其他提示词使用                            | This alias is already used by another prompt                                       |
| form.unsaved.title               | 放弃未保存的更改？                                  | Discard unsaved changes?                                                           |
| form.unsaved.keepEditing         | 继续编辑                                            | Keep editing                                                                       |
| form.unsaved.discard             | 放弃更改                                            | Discard changes                                                                    |
| form.delete.title                | 删除提示词                                          | Delete prompt                                                                      |
| form.delete.description          | 确定要删除提示词「{name}」吗？此操作无法撤销。      | Delete "{name}"? This can't be undone.                                             |
| toast.created                    | 提示词已创建                                        | Prompt created                                                                     |
| toast.saved                      | 提示词已保存                                        | Prompt saved                                                                       |
| toast.deleted                    | 提示词已删除                                        | Prompt deleted                                                                     |

### 8.2 `composer.promptLibrary.*`

| Key                  | zh-CN                                  | en-US                                        |
| -------------------- | -------------------------------------- | -------------------------------------------- |
| title                | 提示词库                               | Prompt Library                               |
| section.pinned       | 置顶                                   | Pinned                                       |
| section.recent       | 最近使用                               | Recently used                                |
| section.all          | 全部提示词                             | All prompts                                  |
| section.results      | 搜索结果                               | Results                                      |
| emptyLibrary         | 还没有保存的提示词。                   | No saved prompts yet.                        |
| emptyLibraryHint     | 前往 设置 › 提示词库 新建。            | Create one in Settings › Prompt Library.     |
| emptyResults         | 没有匹配的提示词。                     | No matching prompts.                         |
| loading              | 正在加载提示词…                        | Loading prompts…                             |
| error                | 提示词库加载失败。                     | Couldn't load prompts.                       |
| deletedWhileOpen     | 该提示词已被删除。                     | This prompt was deleted.                     |
| insertedAnnouncement | 已插入提示词「{name}」，光标位于文末。 | Inserted "{name}"; the cursor is at the end. |
| footer.trigger       | 提示词库                               | Prompt library                               |
| footer.navigate      | 选择                                   | Navigate                                     |
| footer.insert        | 插入                                   | Insert                                       |
| footer.close         | 关闭                                   | Close                                        |

## 9. 文件改动清单

### 9.1 shared

| 文件                                             | 改动                                   |
| ------------------------------------------------ | -------------------------------------- |
| `packages/shared/src/prompt-library.ts`          | 新增类型、常量、排序比较函数           |
| `packages/shared/src/validationPromptLibrary.ts` | 新增 zod schema（Host 与 UI 共用）     |
| `packages/shared/src/channels.ts`                | 新增 `PromptLibrary: "prompt-library"` |
| `packages/shared/src/index.ts`                   | 导出类型/schema/常量                   |
| `packages/shared/src/test-ids.ts`                | 新增设置页与面板 test id               |

### 9.2 services / client

| 文件                                                           | 改动                   |
| -------------------------------------------------------------- | ---------------------- |
| `packages/services/src/prompt-library/promptLibrary.ts`        | 接口 + descriptor      |
| `packages/services/src/prompt-library/promptLibraryService.ts` | Node 实现              |
| `packages/services/src/accessor.ts`                            | 新增可选字段           |
| `packages/services/src/index.ts`                               | 只导出 descriptor/类型 |
| `packages/services/src/node.ts`                                | 导出工厂并注册         |
| `packages/client/src/remoteServiceAccess.ts`                   | 新增 getter            |

### 9.3 ui

| 文件                                                 | 改动                                            |
| ---------------------------------------------------- | ----------------------------------------------- |
| `packages/ui/src/lib/promptInputTriggers.ts`         | 类型、正则、别名、tail                          |
| `packages/ui/src/lib/editorUpdateTags.ts`            | 新增 `PROMPT_LIBRARY_INSERT_UPDATE_TAG`         |
| `packages/ui/src/lib/imeComposition.ts`              | 新增；从 `MentionPlugin` 抽出组合态判断         |
| `packages/ui/src/mentions/MentionPlugin.tsx`         | 使用共享组合态帮助函数；忽略插入 tag            |
| `packages/ui/src/SlashCommandPlugin.tsx`             | 忽略插入 tag                                    |
| `packages/ui/src/mentions/PromptLibraryPlugin.tsx`   | 新增 Lexical 插件                               |
| `packages/ui/src/mentions/promptLibraryInsert.ts`    | 新增纯文本插入 helper                           |
| `packages/ui/src/LexicalChatInput.tsx`               | 挂载插件                                        |
| `packages/ui/src/hooks/usePromptLibrary.ts`          | 新增 Hook，解析 base Host 服务                  |
| `packages/ui/src/store/promptLibraryStore.ts`        | 新增 Zustand store                              |
| `packages/ui/src/settings/PromptLibrarySection.tsx`  | 新增设置分区                                    |
| `packages/ui/src/settings/PromptLibraryForm.tsx`     | 新增表单                                        |
| `packages/ui/src/settings/settingsPageConfig.ts`     | 注册 `promptLibrary` 分区                       |
| `packages/ui/src/lib/settingsNavigation.ts`          | 新增 id 与校验                                  |
| `packages/ui/src/SettingsPage.tsx`                   | 渲染分支 + `ServiceProvider(localHostServices)` |
| `packages/ui/src/i18n/locales/zh-CN.ts` / `en-US.ts` | 新增文案                                        |

### 9.4 spec 与测试

| 文件                                           | 说明                     |
| ---------------------------------------------- | ------------------------ |
| `specs/prompt-library.md`                      | 本文件，先于代码         |
| `packages/ui/test/promptInputTriggers.test.ts` | 触发正则单测             |
| `packages/ui/test/promptLibraryInsert.test.ts` | 插入单测                 |
| `packages/ui/test/promptLibraryStore.test.ts`  | store 单测               |
| `packages/services/test/promptLibrary.test.ts` | 持久化/并发/损坏恢复单测 |

## 10. 分阶段计划

### P0（MVP）

1. 新增 shared 类型、zod schema、channel、test id。
2. 新增 service descriptor、Node 实现、注册、accessor 字段。
3. 新增 `RemoteServiceAccess` getter。
4. 修改触发正则、别名、tail，并补单测。
5. 新增 store、hook、插件、插入 helper，挂载到 `LexicalChatInput`。
6. 设置页新增分区、列表、表单、导航、i18n。
7. 单测与 E2E。

P0 不做：workspace 级、chip、内容搜索服务端化、拖拽排序、跨窗口实时同步、云同步、`+` 菜单入口。

### P1

- `+` 动作菜单入口与 `LexicalChatInputHandle.openPromptLibrary()`（提升可发现性，尤其手机端）。
- 粘贴/拖放触发抑制。
- 面板错误态「重试」、更细的加载骨架。
- 导入/导出（JSON / Markdown），显式 opt-in。
- 跨窗口刷新：窗口 focus 时强制刷新，或接入 `BroadcastService`。

### P2

- workspace 级提示词（`.zcode/prompts/*.md`），与用户级合并；远程路由需带 `workspaceIdentity` / `remoteSessionId`。
- 可选同步（config-sync / Gist），必须显式开启并提示敏感数据。
- 模板变量（`{{selection}}`、`{{file}}`）与组合。
- 使用统计与误触发遥测（只记录事件与长度，不记录正文）。

## 11. 验收场景

### 11.1 设置页

1. 设置 › Agent 能力 › 提示词库：导航项存在；退出再进入仍停留在该分区。
2. 空库点击「新建提示词」，填写名称与多行内容，保存后列表出现，重启后仍在。
3. 名称或内容为空、名称超过 60 字符、内容超过 8,000 字符时保存禁用并有内联错误。
4. 两个提示词使用相同别名时保存被阻止，提示别名冲突；重名标题允许。
5. 搜索名称、内容、标签、别名均有结果；无结果显示空态与「清除搜索」。
6. 三种排序生效，置顶始终优先；排序偏好刷新后保留。
7. 置顶/取消置顶后行移动到对应分组，`aria-pressed` 同步，刷新后保持。
8. 删除必须二次确认，弹窗展示名称且默认焦点在取消；确认后列表与面板同时消失。
9. 修改后点击面包屑、左侧其他分区、返回工作区、Esc 均触发未保存拦截；继续编辑保留草稿。

### 11.2 输入框

10. 行首输入 `;`、空格后输入 `;`、行首输入 `；`、空格后输入 `；` 均打开面板。
11. `你好；世界`、`const a = 1;`、`foo;bar`、`@foo;bar` 不打开提示词面板；`@` 面板行为不变。
12. 面板中按 ↑↓ 到边界不越界，Enter/Tab 插入，Esc 关闭且保留 `;query`。
13. 无候选时 Enter 不插入旧项、不发送消息，按默认行为换行。
14. 插入后 `;query` 被替换为纯文本，前后文本保留，多行与缩进保留，光标在文末。
15. 一次 `Cmd/Ctrl+Z` 恢复 `;query` 与光标位置。
16. 内容以 `@`、`/`、`$`、`#`、`;` 结尾时不误开其他面板。
17. Esc 后同一 token 内不再自动重开；`;` 后接空格保留 `; ` 并关闭。
18. 空库时面板显示引导文案，输入框仍可正常使用。
19. 打开面板后记录被另一端删除，点击插入不写入旧内容并提示。
20. 8,000 字符、含多段换行的提示词插入后输入框可滚动、可编辑、不卡顿。

### 11.3 平台

21. 桌面远程 workspace：面板显示本机提示词并可插入。
22. 只读/运行中禁用态：`;` 不打开面板。
23. 旧 Host / 服务缺失：设置页提示不支持，Composer 中 `;` 保持普通文本。
24. 手机 Web 390px：新建、编辑、置顶、删除、搜索、`;` 插入均可用，触控目标 ≥ 44px。
25. 暗色与 zh-CN / en-US 切换：表面、边框、hover、选中、错误态清晰可辨。

## 12. 验证命令

```bash
node scripts/check-workspace-freshness.mjs
pnpm typecheck
pnpm lint
pnpm architecture:check --changed
pnpm fmt:check
```

测试入口以目标包 `package.json` 为准；不假定统一测试命令。单测至少覆盖：

- `promptInputTriggers`：行首/空白/全角/汉字前缀/其他 trigger 回归。
- `promptLibraryInsert`：多行、尾随文本、单次撤销、末尾触发符不误开面板。
- `promptLibraryStore`：去重加载、过期刷新、旧请求不回写、增删改后的排序。
- `promptLibraryService`：边界校验、别名冲突、并发 create、损坏恢复、未来版本只读、幂等删除、`expectedUpdatedAt` 冲突。

## 13. 风险与开放问题

| 风险 / 问题                     | 处理                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| 中文正文中的 `；` 误触          | 严格要求行首或空白；不放宽到汉字前缀                                                       |
| 代码中的 `;` 误触               | 分号通常紧贴前 token；仍可能出现在行首/空格后，Esc 可关闭                                  |
| 粘贴内容触发面板                | P0 依赖前置条件；P1 监听 `beforeinput` 抑制 paste/drop                                     |
| IME 组合态                      | 复用组合态冻结逻辑，只在已上屏字符上判定                                                   |
| 大量提示词                      | 列表只传摘要；最多 500 条；结果截断 100 条；虚拟列表                                       |
| 文件损坏                        | `.bak` + quarantine + 只读提示 + `reset()`                                                 |
| 多窗口并发写                    | `withFileLock` 包住读改写；`updatedAt` 单调递增                                            |
| 敏感内容                        | 明文保存在本机；设置页提示不要保存密钥；P0 不接任何同步                                    |
| 远程 workspace                  | 库固定走 base/local Host；插入是纯文本，不触发远程库 RPC                                   |
| 旧 Host                         | 服务字段可选；缺失时降级为普通文本输入                                                     |
| 共享面板圆角与 DESIGN.md 不一致 | 本功能先复用；另立迁移项统一三个面板为 `rounded-lg`                                        |
| 插入后 `recordUsage` 写放大     | 每次插入一次 best-effort 写；P1 可做 2 秒防抖或只在面板关闭时落盘                          |
| 第三方输入法占用 `;`            | 搜狗/QQ 等可能把 `;` 绑定为快捷输入；需在目标输入法实测，应用层无法兜底，保留 `+` 菜单入口 |
| 手机端符号键可发现性            | `;` 在符号层；P1 `+` 菜单入口应尽快补齐，或与 P0 一起上                                    |
| 发送时命令/提及解析             | 纯文本插入不绕过既有解析；表单展示提示，不自动转义                                         |
| 内联消息编辑                    | 复用 `ChatPromptEditor`，提示词库同样可用；产品若不需要再显式关闭                          |

## 14. 增量需求：列表删除与 GitHub 同步

### 14.1 列表删除按钮

- 列表每一行在置顶按钮之后、行尾增加删除按钮，图标 `Trash2`，`aria-label` 使用 `settings.promptLibrary.delete`。
- 点击、键盘 Enter/Space、`onMouseDown` 都必须 `stopPropagation`，不能触发行进入编辑视图。
- 删除前使用 `useConfirmDialog`，文案复用 `settings.promptLibrary.form.delete.*`；默认焦点在取消。
- 确认后调用 `removePrompt(id)`，成功 toast `settings.promptLibrary.toast.deleted`，失败展示既有错误文案。
- `readOnly` 或服务缺失时按钮禁用；手机端触控目标 44×44。
- 新增 test id `TID_SETTINGS_PROMPT_LIBRARY_DELETE`。

### 14.2 同步模型

复用 `packages/services/src/config-sync` 的通用编排，不新写 Gist 客户端。

| 项               | 值                                                          |
| ---------------- | ----------------------------------------------------------- |
| Gist description | `zcode-prompt-library-config-sync`                          |
| 同步项           | 整库一个 item，`name = "prompts"`                           |
| 远端文件名       | `prompts.json`                                              |
| 内容             | `PromptLibraryFileV1` 的稳定序列化 JSON（items 按 id 排序） |
| 元数据           | `~/.zcode/v2/prompt-library-sync-metadata.json`             |
| 备份根目录       | `~/.zcode/v2/backups/prompt-library`                        |
| 备份条目         | `prompt-library.json`                                       |
| 最大文件         | 8 MB                                                        |

下载语义：

- `merge`（默认）：按 `id` 合并。同 id 以远端为准；本地独有的提示词保留；两端不同 id 但 alias 冲突时，保留远端的 alias，清空本地冲突项的 alias（不丢提示词）。
- `replace`：用远端整库覆盖本地；远端缺失时写入空库。必须经过下载确认弹窗里的“镜像远端”勾选。
- 合并后仍受 500 条、alias 唯一等约束；无法合并时返回 `local_invalid`，不写盘。
- 应用前由通用编排创建备份；失败不写入，用户可从备份还原。

上传语义：

- 上传前扫描疑似密钥；命中时先弹 `ConfigSyncSecretWarningDialog`，确认后才上传。
- 私有 Gist 不是加密存储；设置页文案明确提示不要保存密钥。
- 本地库损坏 / `readOnly` 时禁用上传和下载，避免用空库覆盖远端。

### 14.3 服务契约

在 `IPromptLibraryService` 上增加**可选**同步方法（旧 Host / 测试替身可不实现；UI 用 `typeof fn === "function"` 判断）：

```ts
getSyncStatus?(): Promise<ConfigSyncStatus>;
uploadToGithub?(params?: { confirmSecretUpload?: boolean }): Promise<ConfigSyncResult<ConfigSyncUploadResult>>;
previewDownload?(): Promise<ConfigSyncResult<ConfigSyncDownloadPlan>>;
applyDownload?(params: {
  strategy: "merge" | "replace";
  expectedRemoteRevision: number;
  confirmReplace?: boolean;
}): Promise<ConfigSyncResult<ConfigSyncDownloadResult>>;
listSyncBackups?(): Promise<ConfigSyncBackupList>;
restoreSyncBackup?(params: { backupDir: string }): Promise<ConfigSyncResult<ConfigSyncRestoreResult>>;
```

同步实例在 `createPromptLibraryService({ credentialService, fetchImpl, now })` 内构造；`fetchImpl` 必须由 `createLocalServices` 注入 `hostApiNetworkTransport.fetch`，与 MCP / Skills 一致。同步写盘复用提示词库自身的 `withFileLock + atomicWritePrivateTextFile`，不新增第二条写入路径。

新增文件：

- `packages/services/src/prompt-library/promptLibraryConfigSync.ts`：profile、稳定序列化、merge、`createPromptLibraryConfigSync`。
- 修改 `packages/services/src/prompt-library/promptLibrary.ts`、`promptLibraryService.ts`、`packages/services/src/node.ts`。

### 14.4 设置页交互

- 列表头部右侧增加 `SettingsResourceHeaderActions` 的“更多”菜单：上传到 GitHub、从 GitHub 下载、从本地备份还原。
- 菜单上方或下方显示 `ConfigSyncStatusRow`：连接状态、Gist 链接、上次同步时间、本地是否变更、备份数量。
- 上传：点击 → `uploadToGithub()`；`secret_warning` → `ConfigSyncSecretWarningDialog` → 确认后带 `confirmSecretUpload` 重试。
- 下载：点击 → `previewDownload()` → `ConfigSyncDownloadDialog` → 确认策略 → `applyDownload()` → `load({force:true})`。
- 还原：点击 → `listSyncBackups()` → `ConfigSyncRestoreDialog` → `restoreSyncBackup()` → `load({force:true})`。
- 同步进行中禁用所有同步动作并显示 loading；未登录时状态行提示并保留“前往同步配置”入口。
- 同步错误使用 `describeConfigSyncError` 统一映射；不要直接把服务端 message 当主文案。

### 14.5 新增文案

| Key                                          | zh-CN                                 | en-US                                               |
| -------------------------------------------- | ------------------------------------- | --------------------------------------------------- |
| settings.promptLibrary.delete                | 删除提示词                            | Delete prompt                                       |
| settings.promptLibrary.sync.uploaded         | 已上传到私有 Gist（{count} 条提示词） | Uploaded to private gist ({count} prompts)          |
| settings.promptLibrary.sync.downloaded       | 已从私有 Gist 下载提示词              | Prompts downloaded from private gist                |
| settings.promptLibrary.sync.uploadTitle      | 上传提示词库                          | Upload prompt library                               |
| settings.promptLibrary.sync.downloadTitle    | 下载提示词库                          | Download prompt library                             |
| settings.promptLibrary.sync.restoreTitle     | 还原提示词库                          | Restore prompt library                              |
| settings.promptLibrary.sync.readOnlyDisabled | 提示词库为只读状态，无法同步          | The prompt library is read-only and can't be synced |
| settings.promptLibrary.sync.planItemName     | 提示词库                              | Prompt library                                      |

复用现有 `settings.resourceActions.*`、`settings.configSync.*`、`common.*` 的通用文案。

### 14.6 验收场景

1. 列表行点击删除 → 确认弹窗展示名称 → 取消不删除；确认后行消失、toast、面板同步消失。
2. 删除按钮点击不会打开编辑视图；键盘 Enter/Space 同样不打开。
3. 未登录 GitHub → 上传/下载返回未登录提示，状态行显示未连接。
4. 登录后上传 → 私有 Gist 出现 `prompts.json` 与 manifest；再次上传内容未变时不发网络请求。
5. 上传内容含疑似密钥 → 弹出密钥告警，取消不上传，确认后上传。
6. 另一台设备下载 → 确认弹窗显示 1 个条目 → merge 后本地保留独有提示词、同 id 以远端为准。
7. 勾选镜像远端 → replace 后本地与远端完全一致。
8. 下载后可从备份还原到下载前状态。
9. 本地库损坏 / readOnly → 上传下载禁用，不覆盖远端。
10. 同步过程中重复点击 → 显示 busy 或被禁用，不并发执行。
