# Changelog

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
