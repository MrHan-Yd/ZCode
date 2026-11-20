export class OrchestrationProgress {
  private generation = 0;
  private resolve!: () => void;
  private next = this.createPromise();

  get version(): number {
    return this.generation;
  }

  wake(): void {
    this.generation += 1;
    this.resolve();
    this.next = this.createPromise();
  }

  wait(version: number): Promise<void> {
    return version === this.generation ? this.next : Promise.resolve();
  }

  private createPromise(): Promise<void> {
    return new Promise((resolve) => {
      this.resolve = resolve;
    });
  }
}

/** 只串行化领取 / 修订 / 终态检查，不能在这里等待子代理停止或执行完成。 */
export class OrchestrationControl {
  private readonly pending = new Map<string, Promise<unknown>>();

  run<T>(runId: string, action: () => Promise<T> | T): Promise<T> {
    const previous = this.pending.get(runId) ?? Promise.resolve();
    const result = previous.then(action, action);
    this.pending.set(runId, result);
    void result
      .finally(() => {
        if (this.pending.get(runId) === result) this.pending.delete(runId);
      })
      .catch(() => undefined);
    return result;
  }
}
