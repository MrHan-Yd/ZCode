# Changelog

## [3.18.9](https://github.com/MrHan-Yd/ZCode/compare/v3.18.8...v3.18.9) (2026-10-26)

### Features

* **zcode-cli:** 增加会话尾窗预览并优化冷恢复性能 ([f596710](https://github.com/MrHan-Yd/ZCode/commit/f596710fda94ab4754a73f1f9fdfabc38dc99083))

## [3.18.8](https://github.com/MrHan-Yd/ZCode/compare/v3.18.7...v3.18.8) (2026-10-21)

### Features

* **prompt-library:** 新增用户级提示词库与分号触发补全 ([1c638ac](https://github.com/MrHan-Yd/ZCode/commit/1c638ac1dddecbf927637c4b37ed3c3e98921da4))
  * 接入提示词库服务通道与共享类型，设置页支持管理提示词
  * 输入框支持 `;` 触发补全，完善 IME 合成、提及与斜杠面板交互
  * config-sync 新增 local_invalid 错误码，区分本地合并失败


### Documentation

* 补充 README 的 v3.18.8 更新说明 ([f434931](https://github.com/MrHan-Yd/ZCode/commit/f434931dba4f13dd7432fe9ca7e49f2abf4d2cef))

## [3.18.7](https://github.com/MrHan-Yd/ZCode/compare/v3.18.6...v3.18.7) (2026-10-21)

### Features

* **config:** 补齐内置模型规则并接入 CommandCode/ClinePass 模板 ([564f633](https://github.com/MrHan-Yd/ZCode/commit/564f633c209cd290a91a5ec30911dbff803fa14c))

* **skills:** 技能支持同步到 GitHub 私有 Gist ([f7e5945](https://github.com/MrHan-Yd/ZCode/commit/f7e594512a909b864208ff75381c8b9184b46506))


### Performance

* **usage-stats:** 应用用量聚合改为单遍查询并补覆盖索引 ([695a264](https://github.com/MrHan-Yd/ZCode/commit/695a264afcf1303a7d103dcea68836cf2bf8a526))


### Documentation

* 补充 README 的 v3.18.7 更新说明 ([e5f2801](https://github.com/MrHan-Yd/ZCode/commit/e5f2801570d09496fbfbd7e290766250619ad089))

## [3.18.6](https://github.com/MrHan-Yd/ZCode/compare/v3.18.5...v3.18.6) (2026-10-20)

### Bug Fixes

* **subagent:** 补齐 CLI 侧 AgentProfile.color 的四个深色 ([d4630fe](https://github.com/MrHan-Yd/ZCode/commit/d4630feaea50c6bd1786765f3472d52a35858af8))


### Documentation

* 补充 README 的 v3.18.6 更新说明 ([5bd4914](https://github.com/MrHan-Yd/ZCode/commit/5bd4914054fb60e3e660c5d5b5d468f62387e354))

## [3.18.5](https://github.com/MrHan-Yd/ZCode/compare/v3.18.4...v3.18.5) (2026-10-20)

### Features

* **config-sync:** 支持用户与工作区作用域分片同步配置 ([1af768f](https://github.com/MrHan-Yd/ZCode/commit/1af768f422dbf64eec32b0842e537a9cf68ac69f))

* **config-sync:** 状态行回显工作区作用域的项目名 ([6206f66](https://github.com/MrHan-Yd/ZCode/commit/6206f666fe2bfcea7c4ffde7d6200eda54d33354))


### Documentation

* 补充 README 的 v3.18.4 更新说明 ([747e39a](https://github.com/MrHan-Yd/ZCode/commit/747e39a05a37bfec66f3fec60381b0eb0166f256))

* 补充 README 的 v3.18.5 更新说明 ([6b76344](https://github.com/MrHan-Yd/ZCode/commit/6b76344bd5910805819ad949fea6dabc7ed8331a))

## [3.18.4](https://github.com/MrHan-Yd/ZCode/compare/v3.18.3...v3.18.4) (2026-10-19)

### Bug Fixes

* **config-sync:** 修正 gist 上传请求体形状并补 422 诊断 ([66b3783](https://github.com/MrHan-Yd/ZCode/commit/66b37839552f71a6b5fb504f72dab10b80e390d4))
  * 请求体里每个文件改为 `{ content }` 对象：裸字符串被 GitHub 以 422 拒绝，子智能体 / MCP / 模型供应商三处上传一直失败
  * 新增 GistFilesPayload 类型，buildRemoteFiles 直接产出线上形状，gistClient 只透传，不做二次转换
  * 未映射状态码带上 GitHub 校验摘要（只取 message 首行与 errors 的 field/code，不回显内容）
  * 新增 gistClient 请求体单测；三个假 GitHub 改为按真实契约校验 files，形状不符回 422
  * 补充 config-sync 三份 spec 的请求体契约与 422 失败语义


### Documentation

* 补充 README 的 v3.18.3 更新说明 ([df4ac67](https://github.com/MrHan-Yd/ZCode/commit/df4ac67763584f5d3a93ec3d2ea615fa64dbd375))

## [3.18.3](https://github.com/MrHan-Yd/ZCode/compare/v3.18.2...v3.18.3) (2026-10-18)

### Features

* **config-sync:** 模型设置支持同步到 GitHub 私有 Gist（不含 API Key） ([f0c879b](https://github.com/MrHan-Yd/ZCode/commit/f0c879b0d37a3f501e78abfb43af3106122bb8f6))


### Documentation

* 补充 README 的 v3.18.2 更新说明 ([4786414](https://github.com/MrHan-Yd/ZCode/commit/478641443568dca3ee139b6be880cb232ecdd4fa))

## [3.18.2](https://github.com/MrHan-Yd/ZCode/compare/v3.18.1...v3.18.2) (2026-10-18)

### Features

* **config-sync:** 支持列出本地备份并从备份还原配置 ([c7c4190](https://github.com/MrHan-Yd/ZCode/commit/c7c4190b44c634d23715bf48cbc58746571340d6))


### Documentation

* 补充 README 的 v3.18.1 更新说明 ([0a45fc2](https://github.com/MrHan-Yd/ZCode/commit/0a45fc297d305eb5f638654e18c72bb58c61edd8))

## [3.18.1](https://github.com/MrHan-Yd/ZCode/compare/v3.18.0...v3.18.1) (2026-10-17)

### Features

* **config-sync:** 支持将 MCP 与子智能体配置同步到 GitHub 私有 Gist ([262fd00](https://github.com/MrHan-Yd/ZCode/commit/262fd0037742a4f66bb4d5753fd380d33df82cd5))

* **services:** 新增 GitHub 设备流授权并补种文件变更摘要 ([d2957ea](https://github.com/MrHan-Yd/ZCode/commit/d2957eac4c17be6b88ad0635f98fb6d83a108b4d))

* **settings:** 模型智能配置规则列表默认收起 ([28b8378](https://github.com/MrHan-Yd/ZCode/commit/28b8378bd7d72ce03840a57ed146af5f03b5df8b))
  * 抽取列表呈现状态判定，区分 list/empty/error，错误与空状态仍直接可见
  * 「已配置规则」明细改为可折叠，默认收起，展开状态仅保存在组件内
  * 补充状态模型单测与同步规格说明
  * 增加文件引用扫描与子智能体配置同步的规划文档


### Documentation

* 补充 README 的 v3.18.0 更新说明 ([4de92b2](https://github.com/MrHan-Yd/ZCode/commit/4de92b2087fef209f88f2d347bb19b71d5128dd3))

## [3.18.0](https://github.com/MrHan-Yd/ZCode/compare/v3.17.9...v3.18.0) (2026-10-15)

### Features

* **conversation-ui:** 文件变更胶囊按缺口清单按需回填 ([ad6d016](https://github.com/MrHan-Yd/ZCode/commit/ad6d016437506c3b74342c938c49a122602a4a38))
  * 判定与映射抽成纯模块 turnFileChangeSummaryBackfillModel（可差分测试），
  * 复用既有 conversationFileChanges RPC 与 SessionPane 的 fileChangesRequestCache：终态结果
  * 回填出来的轮与正常 hydrate 的轮不可区分：files > 0 补 state: active（与投影同口径），
  * 不在缺口清单里的轮一次请求都不发——这正是该信号存在的理由
  * 接入点在 ConversationTurnGroupImpl（轮尾面板渲染、hasAssistantTurnContent、

* **session-performance:** 支持子会话统计与批量查询 ([95d4a88](https://github.com/MrHan-Yd/ZCode/commit/95d4a882209b60292dc54c2febbee9d79ab0834b))
  * 性能聚合按会话自身 query_source 取值，子会话读 subagent
  * 新增 sessionPerformanceBatch 协议入口与批量客户端方法
  * 状态面板与子智能体速度展示接入批量统计
  * 补充实时输出 token 与子代理速度计算及测试
  * 更新会话性能统计规格文档


### Bug Fixes

* **runtime:** 辅助文本生成统一走流式传输 ([bb1ec2a](https://github.com/MrHan-Yd/ZCode/commit/bb1ec2a2a31af4c9a5f0ac8823b7f39644db039d))

* **session-hydration:** 文件变更摘要缺口显式下发，供客户端按需回填 ([393f74a](https://github.com/MrHan-Yd/ZCode/commit/393f74a053aa75916806c7d77666fcb1fc7ea831))
  * snapshot 新增 additive 字段 fileChangeSummaryUnavailableTurnIds：静态只读派生元数据，
  * bridge 在既有 onArtifactError 里收集失败 messageId → loadPersistedEvents 返回值 →
  * 空清单不补种：补种会重算 wire 字节上界，没有缺口时是纯浪费


### Performance

* 优化冷恢复与增量渲染热路径 ([c6c414f](https://github.com/MrHan-Yd/ZCode/commit/c6c414fb8f6ebb2ee41c8b55f627bcf68aaa6a6a))
  * 冷恢复三段只读查询改为 Promise.all 并发，首帧不再串行等待
  * nowMs 时钟推进只重建运行中 turn，完成态 unit 引用保持稳定
  * 冷差分不可得时回退结构化 patch，避免静默 0/0 错值
  * 补充误差异常与增量渲染测试及性能/渲染规格说明


### Chores

* **session-hydration:** 冷恢复三段查询各自计时（只观测，不改行为） ([f9d51e4](https://github.com/MrHan-Yd/ZCode/commit/f9d51e455949d5473283c715ee8c3c83091158c7))
  * timedStep 包裹 file-changes / context-usage / subagents，走既有
  * 行为完全不变：包裹前后调用的入参与返回值逐一相同，异常照常透出（计时在 finally）
  * 按 AGENTS.md，debug 生产不落盘，读数需在 pnpm dev:desktop / dev:web 下抓 stderr


### Documentation

* 补充 README 的 v3.17.9 更新说明 ([76347e3](https://github.com/MrHan-Yd/ZCode/commit/76347e3254711ba88aea2b201bd8284e91b2d751))

## [3.17.9](https://github.com/MrHan-Yd/ZCode/compare/v3.17.8...v3.17.9) (2026-10-15)

### Features

* **ui:** 聊天文件链接支持跳转到标注行 ([c469c8c](https://github.com/MrHan-Yd/ZCode/commit/c469c8cac545aa308d3bbbc23e12b1059de3745d))
  * 点击带行号的链接改为打开内置查看器并定位到该行（滚动居中 + 高亮），复用
  * 行号不参与 tab 身份：同一文件重复点击复用同一 tab 并替换 source，重新定位靠每次
  * 目标行超出文件行数时不定位，顶部提示目标行不存在，不再静默无反应
  * 芯片悬停提示补上行号，正文标签仍按模型写的原文显示
  * 新增 specs/markdown-file-link-line-anchor.md 与 fileLineAnchor 单测

## [3.17.8](https://github.com/MrHan-Yd/ZCode/compare/v3.17.7...v3.17.8) (2026-10-14)

### Features

* **settings:** 使用统计摘要条改为今日 Token 数与 Cache 命中率 ([92506f3](https://github.com/MrHan-Yd/ZCode/commit/92506f345f785584c64e68a499c3e511a851800e))
  * 摘要条改为 累计 / 峰值 / 今日 / Cache 命中率 / 最长聊天时长，最长聊天时长移到最右
  * 移除「当前连续天数」「最长连续天数」两格，快照字段保留供热力图等继续使用
  * 今日 Token 数取热力图 endDate 那一天的当日累计，与 Token 活动 tooltip 同源，不新增协议字段
  * 三格 token 复用同一 compact 格式化，单位与小数位保持一致（如 24.4 亿 / 2.1 亿）
  * 取值与顺序抽成 view model 并补单测，锁定列顺序、今日取数口径与加载态占位

* **settings:** 子智能体颜色标记扩到 12 色 ([fcb5bd6](https://github.com/MrHan-Yd/ZCode/commit/fcb5bd66cd4bbbde97b35f7db85e2b2add9af5e7))
  * 新增 teal/indigo/fuchsia/lime，并按色环顺序重排，单行色板不再只有 8 个可选
  * shared 联合类型、services 与 CLI 的 frontmatter 校验、UI 类名映射、双语标签四处同步，漏一处会让颜色存得下却显示不出或被静默丢弃
  * 色板列宽改为固定 1.5rem 的模板列，圆点与选中高亮不再随颜色数量错位
  * 补充色板一致性单测（映射表 key 反查色板、文案齐全）与规格文档

## [3.17.7](https://github.com/MrHan-Yd/ZCode/compare/v3.17.6...v3.17.7) (2026-10-14)

### Features

* **git:** 提交消息按勾选作废并禁止超长裁剪 ([a1acf4e](https://github.com/MrHan-Yd/ZCode/commit/a1acf4e0a4f8d43278c5da15496e5dcdc69d59a3))
  * 机器生成的提交消息仅在生成时那批勾选下有效，勾选变化且消息未被编辑时清空输入框
  * 提交入口自行判定消息过期，避免同帧竞态提交上一批勾选的消息
  * 提交消息长度上限写入提示词，超限直接判为不合规，不再静默裁剪模型输出
  * 补充勾选快照 key、消息过期判定与消息格式的单元测试及规格文档


### Chores

* **git:** 提交消息长度上限收紧到 500 字符 ([e6f9efa](https://github.com/MrHan-Yd/ZCode/commit/e6f9efa645a9fe74a0927c31c46be1af5e522c22))
  * 整条消息上限从 1000 调到 500：约定首行 ≤ 50、正文几行，500 字符足够写完影响与原因
  * 提示词与校验共用同一常量，模型看到的数字随之变为 500


### Documentation

* 补充 README 的 v3.17.6 更新说明 ([1dd4fff](https://github.com/MrHan-Yd/ZCode/commit/1dd4fff1108188c72dd9c801bd722ad93eaf91ff))

* 添加提交文件分组与暂存语义实现计划 ([db324ac](https://github.com/MrHan-Yd/ZCode/commit/db324ac27e1af846558fca733c1acc92a9dbf1c8))

## [3.17.6](https://github.com/MrHan-Yd/ZCode/compare/v3.17.5...v3.17.6) (2026-10-14)

### Features

* 提交弹窗按暂存状态分组，去掉「包含未暂存的更改」开关 ([f399fe9](https://github.com/MrHan-Yd/ZCode/commit/f399fe957994194fda26b99a236ade4e07327d05))
  * 清单按「已暂存的更改 / 更改 / 未进行版本管理的文件」分组，逐文件勾选本身就决定提交范围，原来那个二元开关与控制清单内容重复，直接删除
  * 有已暂存内容的文件只出现在「已暂存的更改」一组，工作区剩余改动用「另有未暂存改动」标注，不再重复占一行
  * 只勾「已暂存的更改」即只提交索引里已暂存的内容；部分暂存的文件（git add -p）只提交已暂存那半段，未暂存的留在工作区，与 git commit 的原生语义一致
  * 只对工作区模式的路径 git add，其余路径保持索引内容，两种模式在同一次提交中共存；无部分暂存时仍走原来的 git add + pathspec 快路径
  * 分组可折叠，展开/收起带 300ms 高度过渡，弹窗高度随之平滑伸缩，prefers-reduced-motion 下关闭
  * 生成提交消息时限定只提交索引内容的路径只取已暂存 diff，避免描述并未提交的改动


### Performance

* 优化流式渲染与工具结果截断 ([e8da222](https://github.com/MrHan-Yd/ZCode/commit/e8da2220e5e21f9a26bf2db466f9c8ce823c82c6))
  * 降低流式 mirror flush 间隔并增加积压阈值，提升打字流畅度
  * realtime 消息在 host 入口短路，减少重复 Zod 校验
  * 工具结果预览支持 head-tail 双向截断，默认策略改为 artifact
  * 行级 delta 增加快照增长字节上界计量
  * 侧栏组件用 useCallback 稳定回调，减少重渲染
  * 补充 lint 忽略目录


### Documentation

* 补充 README 的 v3.17.5 更新说明 ([2cb2e48](https://github.com/MrHan-Yd/ZCode/commit/2cb2e487b49c5d4042c88a843d31b1d24545e42c))

## [3.17.5](https://github.com/MrHan-Yd/ZCode/compare/v3.17.4...v3.17.5) (2026-10-12)

### Features

* **usage:** 会话统计面板并列展示平均与当前输出速度 ([221e794](https://github.com/MrHan-Yd/ZCode/commit/221e7948e2ae164947f2b22c51283ce4f6ddf9c3))
  * 面板新增「当前输出速度」行，原「输出速度（TPS）」改名为「平均输出速度（TPS）」
  * 新增 sessionStatsSpeeds 统一决定每个显示面读哪个口径，并把入口渲染门禁一并收拢、补测
  * 入口 aria-label 改为中性表述：它空闲时显示的是累计平均，不是当前值
  * spec 补齐两个口径不可换算的规则、数据流、验收场景与已知限制


### Documentation

* 补充 README 的 v3.17.4 更新说明 ([dbf0a22](https://github.com/MrHan-Yd/ZCode/commit/dbf0a223e2ab6444ffba741cf07ed201c18675d5))

## [3.17.4](https://github.com/MrHan-Yd/ZCode/compare/v3.17.3...v3.17.4) (2026-10-11)

### Bug Fixes

* 拉取入口改为 Git 工具里的独立一行 ([7168878](https://github.com/MrHan-Yd/ZCode/commit/7168878154a1e9805a3c621aacd4680491652655))
  * 不再藏在「提交或推送」的弹窗动作列表里，推送弹窗底部的次要按钮一并撤掉：那种位置要先点进弹窗才能发现拉取，而拉取恰恰常常是工作区干净时唯一要做的事
  * 主按钮回到只承载提交或推送（不再变身为「拉取」）；「拉取」行只在存在上游分支时渲染，行尾在落后远端时标出落后提交数
  * 弹窗拆到 GitPullDialog（结果面板、错误详情、关闭时才刷新等行为不变），GitPullAction 组件承载行与状态；无上游分支的分支判断与文案随之删除


### Documentation

* 补充 README 的 v3.17.3 更新说明 ([0f1764e](https://github.com/MrHan-Yd/ZCode/commit/0f1764e22f366ae307eb8db60b2d3fd44f9852cc))

## [3.17.3](https://github.com/MrHan-Yd/ZCode/compare/v3.17.2...v3.17.3) (2026-10-11)

### Bug Fixes

* 修复拉取入口与结果展示的若干问题 ([b5cd6f8](https://github.com/MrHan-Yd/ZCode/commit/b5cd6f8a3bb7a3fb9b046b4316c831c160e78132))
  * 拉取期间与结束后不再立即刷新仓库状态：那会把整块 Git 区（连同刚渲染出结果的面板）卸载掉，用户读不到拉取量；刷新改到弹窗关闭时补一次
  * 拉取成功的 toast 同时带上文件数与增删行数，作为不受卸载影响的冗余通道
  * 有上游分支的干净仓库不再隐藏 Git 入口：behind 只在 fetch/push/pull 之后才更新，旧判据让「落后远端但尚未 fetch」时无处拉取；窄屏胶囊补「已同步」摘要，「更改 +0 -0」不再渲染
  * 远端分支已被删除时新增 upstream-branch-missing 提示，不再落到 unknown
  * 任一侧读不到 HEAD 时按「有更新、数量未知」上报，不再误报「已是最新」；拉取量算不出来时置 null 而不是 0
  * 英文文案改用 commit(s)/file(s)，提交数在弹窗与 toast 中统一千分位


### Documentation

* 补充 README 的 v3.17.2 更新说明 ([5a0d73e](https://github.com/MrHan-Yd/ZCode/commit/5a0d73e1321e2a581e35b821535e1cada4d1f580))

## [3.17.2](https://github.com/MrHan-Yd/ZCode/compare/v3.17.1...v3.17.2) (2026-10-11)

### Features

* Git 工具新增一键拉取并展示拉取量 ([2241674](https://github.com/MrHan-Yd/ZCode/commit/2241674522e5b0b791a5d40dad20bd9087a6697e))
  * 三处入口：提交弹窗动作列表、主按钮（干净工作区落后远端时不再是禁用态）、推送弹窗
  * 结果按 HEAD 是否变化判定：有更新展示提交数/文件数/增删行数，无更新明确提示「已是最新」
  * 失败给稳定错误码并本地化：无远程、无上游、本地改动被覆盖、合并冲突、分叉、认证失败、网络不可达、超时、有未完成的合并
  * 错误详情保留原始 Git 输出；冲突等失败后仍刷新仓库状态，避免看到过期的干净工作区

* 内置模型规则补 Muse Spark 家族参数 ([20c1dda](https://github.com/MrHan-Yd/ZCode/commit/20c1dda8a1748d7e8fc59c9582e174b755267e07))
  * 新增家族规则 .*muse-spark-1[.\-]\d…，1M 上下文 / 131k 最大输出，输入模态补 image/video/audio
  * 此前 muse-spark 1.x 全系落到兜底规则（200k / 32k），与上游公开目录不符
  * revision 30 → 31；内置 release 用 revision 标识内容，必须随内容递增


### Documentation

* 补充 README 的 v3.17.1 更新说明 ([31a4aba](https://github.com/MrHan-Yd/ZCode/commit/31a4abaf0d1312aad06b4a3fa894f2a16c274860))

## [3.17.1](https://github.com/MrHan-Yd/ZCode/compare/v3.17.0...v3.17.1) (2026-10-11)

### Bug Fixes

* 归档管理页补齐「任务索引里出现过的所有工作区」来源 ([de43794](https://github.com/MrHan-Yd/ZCode/commit/de43794f5aac4ce4b302670412a3678c3f2163ec))
  * IZCodeTaskService 新增 listKnownWorkspaceScopes（只回工作区身份，不加载正文）
  * 归档页把该来源并入项目列表；枚举失败降级成原有来源，不阻塞页面


### Documentation

* 补充 README 的 v3.17.0 更新说明 ([3a212f0](https://github.com/MrHan-Yd/ZCode/commit/3a212f0871eb8a2f5e1f7344ffa3e70bac7a247c))

## [3.17.0](https://github.com/MrHan-Yd/ZCode/compare/v3.16.5...v3.17.0) (2026-10-11)

### Features

* **cli:** 新增 purgeSession 物理删除会话数据并回收磁盘空间 ([47e6c61](https://github.com/MrHan-Yd/ZCode/commit/47e6c6166176c79f778121e8534007a281869a70))
  * SessionStorePort.purgeSession + SqliteSessionStore 实现：事务内删 session 行（级联
  * 按「空闲页 >= 2000 且占比 >= 0.2」双阈值 VACUUM；失败静默（删除已提交，回收是 best-effort）
  * 产物目录清理：artifacts / 三种媒体缓存 / exec / workflow 脚本 / 子代理产物，根在进程启动
  * 命令入口对 purgeSession 豁免「必须常驻会话」准入，否则归档的历史任务永远删不掉
  * 加入 SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS

* 归档任务支持彻底删除并释放磁盘空间 ([bff3c32](https://github.com/MrHan-Yd/ZCode/commit/bff3c32842ec5880df6bafed58f9c8db2484b046))
  * Host 侧 isArchivedTask（归档态只在索引行上，必须在发删除命令前查）+ purgeTask
  * adapter purgeArchivedTasks：运行中守卫 -> CLI purgeSession -> 删 v2 快照 -> 物理删索引行
  * window-controller / desktop host 打通 purge-archived-batch（含 source 替换校验）
  * 归档管理页新增「彻底删除 / 本组 / 全部」与不可恢复确认文案
  * 补充 specs/task-purge.md 与两侧单测


### Documentation

* 补充 README 的 v3.16.5 更新说明 ([eeaa103](https://github.com/MrHan-Yd/ZCode/commit/eeaa10399a7e03975b7b8655e439f8d997950d54))

## [3.16.5](https://github.com/MrHan-Yd/ZCode/compare/v3.16.4...v3.16.5) (2026-10-11)

### Features

* 自动归档改为扫描全部已知项目并新增归档管理页 ([1894d2f](https://github.com/MrHan-Yd/ZCode/commit/1894d2f747b1e46c2d8069703baf2d53ad3d93d4))
  * 抽出共享扫描判定，常驻 scheduler 进程按启动+定时（1h 节流、单飞）扫描
  * listWorkspaceScopes 用轻量 DISTINCT 枚举工作区，不加载任务正文
  * 归档读取不再按 provider 过滤，修复「归档了却看不到」
  * 设置页新增按项目分组的归档管理：作用域下拉、搜索、取消归档、移除、按组/全部删除
  * 补充 specs/task-auto-archive.md


### Performance

* @ 文件搜索支持取消被取代的查询并去掉空查询全量排序 ([771a847](https://github.com/MrHan-Yd/ZCode/commit/771a847e012049469991ce6dde2eaa84132b9206))
  * searchWorkspaceFiles 按 workspace 维护递增 token，分批打分被取代即提前返回
  * 空 query 走默认预览快路径，省掉对全部候选的三趟 map+sort+map
  * 补充 specs/mention-file-scan-performance.md 与单测


### Documentation

* 补充 macOS 启动提示「已损坏」时的 xattr 说明 ([867d0ac](https://github.com/MrHan-Yd/ZCode/commit/867d0ac49084126ea6a504c9ffb4ec79d0023b18))

## [3.16.4](https://github.com/MrHan-Yd/ZCode/compare/v3.16.3...v3.16.4) (2026-10-10)

### Bug Fixes

* 补扫限频不再吞掉落空 query 的补扫机会 ([968f475](https://github.com/MrHan-Yd/ZCode/commit/968f4758170de9cd66540f2c15f3970ae5efbae6))


### Chores

* changelog 支持 perf 类型并补记 v3.16.3 提速条目 ([75547d7](https://github.com/MrHan-Yd/ZCode/commit/75547d7fe87bfd82d48bc65000f91adbf97f65a7))

## [3.16.3](https://github.com/MrHan-Yd/ZCode/compare/v3.16.2...v3.16.3) (2026-10-10)

### Features

* 会话引用统一走 #，@ 不再列出会话 ([ec86a07](https://github.com/MrHan-Yd/ZCode/commit/ec86a07ce10138dd69837cc0994fc82c67889aa1))

* 模型智能配置（本地数据源 + 手动远端同步） ([ce10bc5](https://github.com/MrHan-Yd/ZCode/commit/ce10bc55dea9110105cf9bdf96d10dacec34c08e))

* Git 提交信息支持按文件选择变更 ([2714daf](https://github.com/MrHan-Yd/ZCode/commit/2714dafb2f2c3c0f7c67d87a2f35099f1602d0ef))


### Bug Fixes

* 供应商重命名焦点交接避免菜单收尾抢焦 ([70b3e65](https://github.com/MrHan-Yd/ZCode/commit/70b3e65fb60ceb124d4a1b7f72c0b178b509ad88))


### Performance

* @ 文件检索防抖与补扫限频 ([d902679](https://github.com/MrHan-Yd/ZCode/commit/d90267988f57196dacfdf812b2c823404d833f8d))


### Documentation

* 补充 README 的 v3.16.2 更新说明 ([8aa022e](https://github.com/MrHan-Yd/ZCode/commit/8aa022eb5e08da6601a745254e28d3cb9c840e01))

## [3.16.2](https://github.com/MrHan-Yd/ZCode/compare/v3.16.1...v3.16.2) (2026-10-09)

### Features

* 统一记忆数据根并优化会话加载与增强取消 ([83feae2](https://github.com/MrHan-Yd/ZCode/commit/83feae2273b5a9607845c6cd64db2600fe014a8b))
  * 记忆读写与数据目录迁移跟随 ZCODE_DATA_BASE_DIR，避免设置页与运行时口径分叉
  * 提示词增强改用可序列化 requestId，跨越 RPC 边界后再创建 AbortSignal 并支持幂等取消
  * 会话冷恢复新增首帧加载骨架与上一轮回复预览，补充相关测试与规范


### Documentation

* 补充 README 的 v3.16.1 更新说明 ([0b14b15](https://github.com/MrHan-Yd/ZCode/commit/0b14b157040f0f1bb84402807e463ff0adbd2631))

## [3.16.1](https://github.com/MrHan-Yd/ZCode/compare/v3.16.0...v3.16.1) (2026-10-08)

### Bug Fixes

* **ui:** 修复提交后 Git 工具入口消失导致无法推送 ([3ba2972](https://github.com/MrHan-Yd/ZCode/commit/3ba29725000e9e1b9299c6209a7551348a7412ab))


### Chores

* 发版前拦截只存在于本地的 tag ([0278423](https://github.com/MrHan-Yd/ZCode/commit/02784232210fd61d054b7d0340a530a91a51a399))

## [3.16.0](https://github.com/MrHan-Yd/ZCode/compare/v3.15.3...v3.16.0) (2026-10-08)

### Features

* 支持提交文件勾选并改进记忆根管理 ([b08756b](https://github.com/MrHan-Yd/ZCode/commit/b08756b8b3a731d4abfee71bbcbaff466709b37e))
  * Git 提交弹窗增加可提交文件清单与全选，按勾选子集生成提交消息，并排除未提交路径。
  * 记忆服务支持描述生效/非生效数据根，删除记忆文件并清理 MEMORY.md 索引行。
  * 设置页展示非生效根提示并支持删除记忆文件，补充相关文案与测试。


### Documentation

* 补充 README 的 v3.16.0 更新说明 ([70ebc89](https://github.com/MrHan-Yd/ZCode/commit/70ebc8935f89354fee370bda1dee9be6111d2a11))

## [3.15.3](https://github.com/MrHan-Yd/ZCode/compare/v3.15.2...v3.15.3) (2026-10-07)

### Bug Fixes

* **desktop:** macOS 更新入口降级为「前往下载」 ([a227540](https://github.com/MrHan-Yd/ZCode/commit/a227540f33fc7b2d8ffd7e3caf7cdc4f17a363e8))


### Documentation

* 补充 README 的 v3.15.3 更新说明 ([e2f01b9](https://github.com/MrHan-Yd/ZCode/commit/e2f01b99225acef63b366f9d1c95dd5a03d62f20))

## [3.15.2](https://github.com/MrHan-Yd/ZCode/compare/v3.15.1...v3.15.2) (2026-10-02)

### Documentation

* 补充 README 的 v3.15.2 更新说明 ([2d32f65](https://github.com/MrHan-Yd/ZCode/commit/2d32f657eceba366c1a7e856acc97e8b00650f19))


### Refactorings

* **auth:** 下线旧版登录入口与账户状态 ([2dbc5bf](https://github.com/MrHan-Yd/ZCode/commit/2dbc5bf015d7949d44dafa1e5b3f8f77f57be46a))
  * 移除 onLogin 传参、快捷命令登录项及相关 i18n 文案
  * 删除登录入口可用性守卫与 JWT 失效重启标记等历史逻辑
  * 新增 legacyAccountRetirement 模块收敛旧账户状态清理
  * 补充登录入口退役与账户状态退役的测试及规格文档
  * 调整侧栏账户入口为统一设置菜单样式
