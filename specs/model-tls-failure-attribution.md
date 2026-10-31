# 模型 TLS 失败识别与归因

## 背景

Electron 41 / Node 24 把服务端返回的 TLS alert 编码为 `ERR_SSL_*`，例如
`ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE`。旧的 TLS 判定只覆盖错误码包含 `CERT`、`TLS`
或等于 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 的情况，因此这类既不含 `CERT` 也不含 `TLS`
的握手拒绝会被分类成 `unknown`，遥测 `error_source` 随之落到 `runtime`。

2026-10-31 在 `anyrouter.top` 上复现：该域名的一条 DNS 解析指向的 Cloudflare 边缘对
`anyrouter.top` 返回 `SSL alert number 40`，连接测试全部失败，但日志只记录
`reason: "unknown"`，无法给出「TLS / 网络」方向。

## 产品规则

1. TLS 层失败（证书校验、握手、服务端 alert）统一归类为
   `ModelFailureReason.TlsError`，`error_source=network`、`failure_reason=tls_error`。
2. 不重试：`retryable=false`，重试无法改变握手结果。
3. 不把 TLS 失败当作 provider 业务错误，不触发 provider recovery action。
4. 保留原始 `cause`；日志与 `statusMessage` 仍能看到上游 alert 原文。

## 状态所有者

- 失败分类：`apps/zcode-cli/packages/adapters/src/model/failure-tls.ts`
- UI 历史错误兜底归因：`packages/ui/src/lib/chatErrorAttributionEvidence.ts`

## 识别规则

- Node / Electron 错误码：包含 `CERT`、`TLS` 或 `SSL`，或等于
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE`。
- 旧 transcript 文案兜底：`Cannot connect to API:` 之后出现 `sslv3 alert`、
  `tlsv1 alert`、`handshake failure` 或 `SSL alert number <n>`。

## 验收场景

1. `ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE` + `SSL alert number 40` 归为
   `tls_error`，`retryable=false`。
2. 证书类 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`ERR_TLS_CERT_ALTNAME_INVALID` 仍为
   `tls_error`。
3. `ECONNRESET` 等传输错误不被误判为 TLS。
4. 没有结构化归因的历史错误文案命中 TLS 兜底，telemetry 记
   `network / tls_error`。

## 边界

- 只说明失败发生在 TLS 层，不区分服务端配置、DNS、代理或本地网络，排障仍由用户或
  provider 侧确认。
- 不改变请求路径、重试次数上限或 provider 业务错误映射。
