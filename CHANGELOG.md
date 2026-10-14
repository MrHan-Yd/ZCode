# Changelog

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
