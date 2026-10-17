/**
 * 把 `fetch` / undici 抛出的异常转成可读文案。
 *
 * undici 的 fetch 只报 "fetch failed"，真正的原因挂在 cause 链上（UND_ERR_CONNECT_TIMEOUT /
 * ENOTFOUND / 证书校验失败等）。不带上 cause，界面上就只有「网络异常：fetch failed」，
 * 无法区分「没配代理」「DNS 失败」还是「证书问题」——首次接 GitHub 时就踩过这个坑。
 * cause 链只含网络层信息，不含请求体与 token。
 */
export function describeRequestError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.name === "TimeoutError") {
    return "请求超时";
  }
  const parts = [error.message];
  let cause: unknown = (error as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 4; depth += 1) {
    const code = (cause as { code?: unknown }).code;
    const message = cause instanceof Error ? cause.message : String(cause);
    parts.push(typeof code === "string" && code.length > 0 ? `${code}: ${message}` : message);
    cause = (cause as { cause?: unknown }).cause;
  }
  return parts.join(" ← ");
}
