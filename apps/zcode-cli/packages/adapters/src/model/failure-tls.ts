const MODEL_TLS_VALIDATION_ERROR_CODE = "MODEL_TLS_VALIDATION_FAILED";

class ModelTlsValidationError extends Error {
  readonly code = MODEL_TLS_VALIDATION_ERROR_CODE;

  constructor(cause: unknown) {
    super("TLS validation failed for the provider request.", { cause });
    this.name = "ModelTlsValidationError";
  }
}

export function normalizeModelTlsFailure(error: unknown): unknown {
  if (error instanceof ModelTlsValidationError || !hasTlsFailureCode(error)) {
    return error;
  }

  // AI SDK adapter 可能只转发外层错误，丢失 Node TLS cause.code；
  // 在 provider fetch 边界先提升为稳定错误码，后续分类不再依赖运行时英文文案。
  return new ModelTlsValidationError(error);
}

export function isTlsFailure(code?: string): boolean {
  const normalized = code?.toUpperCase();
  return Boolean(
    normalized?.includes("CERT") ||
    normalized?.includes("TLS") ||
    // Bugfix：Electron 41 / Node 24 把服务端 TLS alert 编码为 ERR_SSL_*（例如
    // ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE），错误码既不含 CERT 也不含 TLS，
    // 旧的 CERT/TLS 白名单会把握手拒绝误判成 unknown。ERR_SSL_* 同样属于 TLS 层失败。
    normalized?.includes("SSL") ||
    normalized === "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  );
}

function hasTlsFailureCode(error: unknown, seen = new WeakSet<object>()): boolean {
  if (error === null || typeof error !== "object" || seen.has(error)) {
    return false;
  }
  seen.add(error);

  const record = error as Record<string, unknown>;
  if (isTlsFailure(typeof record.code === "string" ? record.code : undefined)) {
    return true;
  }

  return hasTlsFailureCode(record.cause, seen);
}
