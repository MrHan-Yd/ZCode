import assert from "node:assert/strict";
import test from "node:test";
import { classifyModelFailure } from "../src/model/failure-classifier.js";
import { isTlsFailure, normalizeModelTlsFailure } from "../src/model/failure-tls.js";

const HANDSHAKE_ALERT_MESSAGE =
  "1236951304832:error:10000410:SSL routines:OPENSSL_internal:SSLV3_ALERT_HANDSHAKE_FAILURE:../../third_party/boringssl/src/ssl/tls_record.cc:486:SSL alert number 40";

function fetchFailureWithCause(code: string, message: string): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error(message), { code }),
  });
}

test("Node 24 的服务端 TLS alert 归为 tls_error 且不重试", () => {
  const error = normalizeModelTlsFailure(
    fetchFailureWithCause("ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", HANDSHAKE_ALERT_MESSAGE),
  );
  const failure = classifyModelFailure(error);
  assert.equal(failure.reason, "tls_error");
  assert.equal(failure.retryable, false);
});

test("证书校验失败保持 tls_error", () => {
  const error = normalizeModelTlsFailure(
    fetchFailureWithCause(
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "unable to verify the first certificate",
    ),
  );
  assert.equal(classifyModelFailure(error).reason, "tls_error");
});

test("普通传输错误不误判为 TLS", () => {
  assert.equal(isTlsFailure("ECONNRESET"), false);
  assert.equal(isTlsFailure("UND_ERR_SOCKET"), false);
  assert.equal(isTlsFailure(undefined), false);
});

test("SSL / TLS 错误码识别覆盖 alert 与证书两类", () => {
  assert.equal(isTlsFailure("ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"), true);
  assert.equal(isTlsFailure("ERR_TLS_CERT_ALTNAME_INVALID"), true);
  assert.equal(isTlsFailure("UNABLE_TO_VERIFY_LEAF_SIGNATURE"), true);
});

test("未经 normalize 的原始 fetch 错误也能识别", () => {
  const failure = classifyModelFailure(
    fetchFailureWithCause("ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE", HANDSHAKE_ALERT_MESSAGE),
  );
  assert.equal(failure.reason, "tls_error");
});
