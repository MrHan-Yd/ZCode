# 启动性能：mermaid 懒加载与 entry chunk 收敛

## 背景

web/desktop renderer 的生产构建为单一巨型 entry chunk（基线实测
`index-*.js` ≈ 5.93MB / gzip 1.67MB）。source map 证实 mermaid 全库经
`@streamdown/mermaid`（薄封装，静态 `import mermaid`）进入 entry——消费点：

1. `message.tsx` 的 `streamdownPlugins`；
2. `mermaid-block.tsx` 的 `createMermaidPlugin()`（CodeBlock 的 mermaid 渲染路径）。

mermaid 只在出现 ```mermaid 代码块时才真正需要，却让首屏下载/解析背负全库体积。
shiki 语法包已由 Rollup 按 dynamic import 正确分块（cpp/emacs-lisp 等独立 chunk，
按需加载），无需处理；UI 内 svg 为逐个静态导入、无全量 barrel，同样无需处理。

## 行为

新增 `packages/ui/src/lib/lazyMermaidPlugin.ts`：

- 插件形状与 `@streamdown/mermaid` v1.0.2 的 `DiagramPlugin`/`MermaidInstance`
  结构兼容；默认 config 相同（startOnLoad:false / theme:"default" /
  securityLevel:"strict" / fontFamily:"monospace" / suppressErrorRendering:true）。
- `getMermaid(config)` 同步合入 config；`import("@streamdown/mermaid")` 推迟到
  **首次 render**，加载后经其 `getMermaid(config)` 取配置化实例（该调用同步执行
  initialize，与原插件一致），加载失败不缓存以允许重试。
- 与原插件的可观察差异仅一处：mermaid 库的加载与 initialize 从「getMermaid 时同步」
  推迟到「首次 render、动态加载完成后」——两个调用方（streamdown 图表组件、
  MermaidBlock）都是 getMermaid 后紧跟 render，配置生效时机等价；streamdown 侧
  render 本身 async 且带 Loading 态，MermaidBlock 侧渲染队列已序列化，加载延迟
  落在既有 loading 态内。
- 两个调用点改用共享单例 `lazyMermaidPlugin`。

## 语义边界

- `@streamdown/mermaid` 仍是 packages/ui 的直接依赖（动态 import 的目标 + 类型来源），
  只是从静态图移到异步 chunk。
- mermaid 渲染失败时 MermaidBlock 退回纯文本、streamdown 图表组件显示错误态的
  行为不变。

## 验收

- web 生产构建 entry chunk 体积较基线下降（mermaid 移出）。
- `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 通过。
