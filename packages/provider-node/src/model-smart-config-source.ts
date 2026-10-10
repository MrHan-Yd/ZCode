import { watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import type { ModelConfigRules, ModelSmartConfigRulesSource } from "@zcode/provider";
import { readModelSmartConfigFileState } from "./model-smart-config-file.js";

export interface NodeModelSmartConfigRulesSourceOptions {
  readonly filePath: string;
  readonly watch?: boolean;
}

/**
 * 用户可同步的模型智能配置规则源。`read()` 每次读盘，缺失/损坏只返回空规则；
 * 文件被同步服务或手工覆盖后由 watcher 兜底广播变更。
 */
export class NodeModelSmartConfigRulesSource implements ModelSmartConfigRulesSource {
  readonly #filePath: string;
  readonly #watchEnabled: boolean;
  readonly #listeners = new Set<(reason: string) => void>();
  #watcher: FSWatcher | null = null;
  #observedRevision: string | null = null;
  #disposed = false;

  constructor(options: NodeModelSmartConfigRulesSourceOptions) {
    const filePath = options.filePath.trim();
    if (!filePath) throw new Error("Model Smart Config filePath 不能为空");
    this.#filePath = filePath;
    this.#watchEnabled = options.watch !== false;
  }

  get filePath(): string {
    return this.#filePath;
  }

  async read(): Promise<ModelConfigRules> {
    return (await this.readWithRevision()).rules;
  }

  async readWithRevision(): Promise<{ revision: string; rules: ModelConfigRules }> {
    this.#assertNotDisposed();
    await this.#ensureWatcher();
    const state = await readModelSmartConfigFileState(this.#filePath);
    this.#observedRevision ??= state.revision;
    return { revision: state.revision, rules: state.rules };
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#assertNotDisposed();
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#watcher?.close();
    this.#watcher = null;
    this.#listeners.clear();
  }

  async #ensureWatcher(): Promise<void> {
    if (!this.#watchEnabled || this.#watcher || this.#disposed) return;
    const directory = dirname(this.#filePath);
    const target = basename(this.#filePath);
    try {
      this.#watcher = watch(directory, (_eventType, fileName) => {
        if (fileName !== null && fileName.toString() !== target) return;
        void this.#refreshFromDisk();
      });
      this.#watcher.on("error", () => this.#emit("watch-error"));
    } catch {
      // 目录尚不存在（还没有同步过）时不起 watcher，下一次 read 会重新尝试。
      this.#watcher = null;
    }
  }

  async #refreshFromDisk(): Promise<void> {
    if (this.#disposed) return;
    try {
      const state = await readModelSmartConfigFileState(this.#filePath);
      if (this.#disposed || state.revision === this.#observedRevision) return;
      this.#observedRevision = state.revision;
      this.#emit("file-changed");
    } catch {
      this.#emit("watch-error");
    }
  }

  #emit(reason: string): void {
    if (this.#disposed) return;
    for (const listener of this.#listeners) listener(reason);
  }

  #assertNotDisposed(): void {
    if (this.#disposed) throw new Error("NodeModelSmartConfigRulesSource 已 dispose");
  }
}
