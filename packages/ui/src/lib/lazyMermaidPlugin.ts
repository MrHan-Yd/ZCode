import type { MermaidConfig } from "@streamdown/mermaid";

/**
 * 懒加载版 mermaid 图表插件（specs/startup-lazy-mermaid.md）。
 *
 * 背景：`@streamdown/mermaid` 的运行时入口静态 `import mermaid`，而 message.tsx 与
 * mermaid-block.tsx 都在首屏 import 链上，导致 mermaid 全库（数百 KB 级）进入
 * entry chunk。mermaid 只在出现 ```mermaid 代码块时才会真正用到。
 *
 * 语义与 @streamdown/mermaid v1.0.2 的预配置插件保持一致：
 * - 默认 config 相同（startOnLoad:false / theme:"default" / securityLevel:"strict" /
 *   fontFamily:"monospace" / suppressErrorRendering:true）；
 * - `getMermaid(config)` 合入 config（同步），config 变化时在 render 前重新 initialize；
 * - 唯一差异是 mermaid.initialize 从「getMermaid 时同步执行」推迟到「首次 render、
 *   动态加载完成后」——对调用方可观察的行为（render 前配置生效）不变。
 */

/** 与 @streamdown/mermaid 的 DiagramPlugin/MermaidInstance 结构兼容的本地类型。 */
export interface LazyMermaidInstance {
  initialize: (config?: MermaidConfig) => void;
  render: (id: string, source: string) => Promise<{ svg: string }>;
}

export interface LazyMermaidDiagramPlugin {
  name: "mermaid";
  type: "diagram";
  language: string;
  getMermaid: (config?: MermaidConfig) => LazyMermaidInstance;
}

const DEFAULT_MERMAID_CONFIG: MermaidConfig = {
  startOnLoad: false,
  theme: "default",
  securityLevel: "strict",
  fontFamily: "monospace",
  suppressErrorRendering: true,
};

type MermaidModule = typeof import("@streamdown/mermaid");

let modulePromise: Promise<MermaidModule> | undefined;

/** 动态加载 @streamdown/mermaid（连带 mermaid 本体），失败不缓存以便重试。 */
function loadMermaidModule(): Promise<MermaidModule> {
  modulePromise ??= import("@streamdown/mermaid").catch((error: unknown) => {
    modulePromise = undefined;
    throw error;
  });
  return modulePromise;
}

export function createLazyMermaidPlugin(): LazyMermaidDiagramPlugin {
  return {
    name: "mermaid",
    type: "diagram",
    language: "mermaid",
    getMermaid(config) {
      // 与原插件一致：ctor 无 options（两个调用点都用默认实例），config 只来自
      // getMermaid 入参；每次 getMermaid 生成闭包持有当时的合并结果。
      let mergedConfig: MermaidConfig = config
        ? { ...DEFAULT_MERMAID_CONFIG, ...config }
        : DEFAULT_MERMAID_CONFIG;
      return {
        initialize(next) {
          mergedConfig = next ? { ...mergedConfig, ...next } : mergedConfig;
        },
        async render(id, source) {
          // @streamdown/mermaid 导出的 `mermaid` 是插件对象；经 getMermaid(config)
          // 取配置化实例——该调用在原插件里会同步 initialize(config)，与既有语义一致。
          const { mermaid } = await loadMermaidModule();
          const instance = mermaid.getMermaid(mergedConfig);
          return instance.render(id, source);
        },
      };
    },
  };
}

/** 共享单例：两个调用点（streamdownPlugins / MermaidBlock）用同一份插件。 */
export const lazyMermaidPlugin = createLazyMermaidPlugin();
