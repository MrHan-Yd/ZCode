export function createSettingsQuiescence() {
  let stopping = false;
  let quiescence: Promise<void> | undefined;
  const activeOperations = new Set<Promise<unknown>>();
  let operationFailure: unknown;

  const assertWritable = () => {
    if (stopping) throw new Error("settingService is quiescing for clear-all-data");
  };
  const track = <T>(operation: Promise<T>): Promise<T> => {
    activeOperations.add(operation);
    void operation.then(
      () => activeOperations.delete(operation),
      (error: unknown) => {
        activeOperations.delete(operation);
        if (stopping) operationFailure ??= error;
      },
    );
    return operation;
  };

  return {
    assertWritable,
    track,
    run<T>(operation: () => Promise<T>): Promise<T> {
      assertWritable();
      return track(operation());
    },
    quiesce(drainQueuedWrites: () => Promise<void>): Promise<void> {
      if (quiescence) return quiescence;
      // 清数据先同步关闭 admission；普通超时 race 不能冒充真实 IO 已收尾。
      stopping = true;
      quiescence = (async () => {
        await drainQueuedWrites();
        while (activeOperations.size > 0) await Promise.allSettled(activeOperations);
        if (operationFailure !== undefined) {
          throw new Error("settings quiescence failed", { cause: operationFailure });
        }
      })();
      return quiescence;
    },
  };
}
