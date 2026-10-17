import type { ConfigSyncSecretWarning } from "./types.js";

/**
 * 上传前的疑似密钥扫描。
 *
 * 只报告位置与规则名，**绝不回传命中值**：命中值一旦进了返回值或日志，就等于把密钥复制到了
 * 另一处；这里只回答「哪一行像什么」。
 */

const SECRET_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/u },
  { name: "openai_api_key", pattern: /\bsk-[A-Za-z0-9_-]{20,}/u },
  { name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/u },
  { name: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/u },
  { name: "aws_access_key_id", pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/u },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { name: "private_key_block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
];

/** 每个文件最多报 20 条，避免一整篇示例把提示刷爆。 */
const MAX_WARNINGS_PER_FILE = 20;

export function scanSecrets(fileName: string, content: string): readonly ConfigSyncSecretWarning[] {
  const warnings: ConfigSyncSecretWarning[] = [];
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const { name, pattern } of SECRET_PATTERNS) {
      if (!pattern.test(line)) continue;
      warnings.push({ fileName, line: index + 1, pattern: name });
      if (warnings.length >= MAX_WARNINGS_PER_FILE) return warnings;
      break;
    }
  }
  return warnings;
}
