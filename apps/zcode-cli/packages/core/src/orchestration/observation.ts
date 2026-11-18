export function awaitOrchestrationObservation<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    // 只取消父等待，不假装 child 已停止；driver 仍须走显式 stop 并报告停止失败。
    if (signal.aborted) {
      operation.catch(() => undefined);
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
