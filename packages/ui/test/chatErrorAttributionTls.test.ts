import assert from "node:assert/strict";
import test from "node:test";
import { resolveTelemetryAttribution } from "../src/lib/chatErrorAttribution.js";
import { resolveControlledUnknownMessageAttribution } from "../src/lib/chatErrorAttributionEvidence.js";
import type { ZCodeUiError } from "../src/lib/zcodeUiError.js";

const BORINGSSL_ALERT =
  "Cannot connect to API: 1236951304832:error:10000410:SSL routines:OPENSSL_internal:SSLV3_ALERT_HANDSHAKE_FAILURE:../../third_party/boringssl/src/ssl/tls_record.cc:486:SSL alert number 40";
const LIBRESSL_ALERT =
  "Cannot connect to API: LibreSSL/3.3.6: error:1404B410:SSL routines:ST_CONNECT:sslv3 alert handshake failure";

function uiError(message: string): ZCodeUiError {
  return {
    code: "model_request_failed",
    message,
    attribution: { source: "runtime", reason: "unknown", retryable: false },
  };
}

test("BoringSSL handshake alert 兜底为 tls_error", () => {
  assert.deepEqual(resolveControlledUnknownMessageAttribution(BORINGSSL_ALERT), {
    errorSource: "network",
    failureReason: "tls_error",
  });
});

test("LibreSSL handshake failure 文案同样命中", () => {
  assert.deepEqual(resolveControlledUnknownMessageAttribution(LIBRESSL_ALERT), {
    errorSource: "network",
    failureReason: "tls_error",
  });
});

test("结构化归因为 runtime/unknown 时 telemetry 纠正为 network/tls_error", () => {
  assert.deepEqual(
    resolveTelemetryAttribution({
      error: uiError(BORINGSSL_ALERT),
      displayMessage: BORINGSSL_ALERT,
    }),
    { errorSource: "network", failureReason: "tls_error" },
  );
});

test("普通连接拒绝仍按 network_error 处理，不被 TLS 规则吞掉", () => {
  const message = "Cannot connect to API: connect ECONNREFUSED 127.0.0.1:443";
  assert.equal(resolveControlledUnknownMessageAttribution(message), undefined);
  assert.equal(
    resolveTelemetryAttribution({ error: uiError(message), displayMessage: message }).failureReason,
    "network_error",
  );
});
