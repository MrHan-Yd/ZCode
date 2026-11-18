import { OrchestrationStoreError, type OrchestrationArtifactReference } from "./contract.js";

const ARTIFACT_REFERENCE_KEYS = new Set([
  "artifactId",
  "attemptKey",
  "uri",
  "summary",
  "originalBytes",
  "savedBytes",
  "sha256",
  "truncated",
  "summaryTruncated",
]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export function parseOrchestrationArtifactReference(
  value: unknown,
): OrchestrationArtifactReference {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidArtifact();
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !ARTIFACT_REFERENCE_KEYS.has(key))) return invalidArtifact();
  if (
    typeof input.artifactId !== "string" ||
    !SHA256_PATTERN.test(input.artifactId) ||
    typeof input.attemptKey !== "string" ||
    !input.attemptKey.trim() ||
    typeof input.uri !== "string" ||
    !input.uri.trim() ||
    typeof input.summary !== "string" ||
    !input.summary.isWellFormed() ||
    typeof input.originalBytes !== "number" ||
    !Number.isSafeInteger(input.originalBytes) ||
    input.originalBytes < 0 ||
    typeof input.savedBytes !== "number" ||
    !Number.isSafeInteger(input.savedBytes) ||
    input.savedBytes < 0 ||
    input.savedBytes > input.originalBytes ||
    typeof input.sha256 !== "string" ||
    !SHA256_PATTERN.test(input.sha256) ||
    typeof input.truncated !== "boolean" ||
    typeof input.summaryTruncated !== "boolean"
  )
    return invalidArtifact();
  return {
    artifactId: input.artifactId,
    attemptKey: input.attemptKey,
    uri: input.uri,
    summary: input.summary,
    originalBytes: input.originalBytes,
    savedBytes: input.savedBytes,
    sha256: input.sha256,
    truncated: input.truncated,
    summaryTruncated: input.summaryTruncated,
  };
}

function invalidArtifact(): never {
  throw new OrchestrationStoreError(
    "artifact_conflict",
    "Orchestration artifact reference is invalid.",
  );
}
