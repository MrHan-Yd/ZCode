/**
 * Model option map 的配置域执行入口。
 *
 * `optionSpecs` 的唯一编译器仍是 `@zcode/model-option-map`；这里只把同一实现暴露给
 * 消费 Provider 配置的调用方，避免为了读取 `ModelConfig.optionSpecs` 再实现一份 JSON 合并。
 */
export {
  compileModelOptionMap,
  compileModelOptionMaps,
  type CompiledModelOptionMaps,
  type ModelOptionMapProgram,
  type ModelOptionMapSpecs,
  type ModelOptionValues,
} from "@zcode/model-option-map";
