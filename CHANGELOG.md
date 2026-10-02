# Changelog

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
