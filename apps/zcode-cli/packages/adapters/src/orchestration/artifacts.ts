import { pathToFileURL } from "node:url";
import {
  assertOrchestrationOwner,
  normalizeOrchestrationOwner,
  OrchestrationStoreError,
  parseOrchestrationArtifactReference,
  type OrchestrationArtifactReference,
  type OrchestrationArtifactStoragePort,
  type OrchestrationArtifactWrite,
  type OrchestrationRunOwner,
} from "@zcode/contracts";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { orchestrationDigest, OrchestrationStoragePaths, readOrchestrationJson } from "./paths.js";

interface OrchestrationArtifactEnvelope {
  version: 1;
  owner: OrchestrationRunOwner;
  sourceSha256: string;
  reference: OrchestrationArtifactReference;
  content: string;
}

export class NodeOrchestrationArtifactStorage implements OrchestrationArtifactStoragePort {
  private readonly paths: OrchestrationStoragePaths;

  constructor(options: { rootDirectory: string; owner: OrchestrationRunOwner }) {
    this.paths = new OrchestrationStoragePaths(options);
  }

  filePath(attemptKey: string): string {
    return this.paths.file("artifacts", attemptKey);
  }

  async write(input: OrchestrationArtifactWrite): Promise<OrchestrationArtifactReference> {
    const filePath = this.filePath(input.attemptKey);
    const reference = parseOrchestrationArtifactReference({
      artifactId: orchestrationDigest(input.attemptKey),
      attemptKey: input.attemptKey,
      uri: pathToFileURL(filePath).href,
      summary: input.summary,
      originalBytes: input.originalBytes,
      savedBytes: input.savedBytes,
      sha256: input.sha256,
      truncated: input.truncated,
      summaryTruncated: input.summaryTruncated,
    });
    if (
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256) ||
      !input.content.isWellFormed() ||
      input.savedBytes !== Buffer.byteLength(input.content, "utf8") ||
      input.sha256 !== orchestrationDigest(input.content)
    ) {
      throw new OrchestrationStoreError(
        "artifact_conflict",
        "Orchestration artifact content does not match its metadata.",
      );
    }
    await this.paths.prepare(filePath);
    return withFileLock(filePath, async () => {
      await this.paths.prepare(filePath);
      const previous = await readOrchestrationJson(filePath);
      if (previous !== undefined) {
        const existing = this.validate(previous, input.attemptKey, filePath);
        if (existing.sourceSha256 !== input.sourceSha256) {
          throw new OrchestrationStoreError(
            "artifact_conflict",
            "Orchestration attempt already has different output; it cannot be overwritten.",
          );
        }
        return { ...existing.reference };
      }
      const envelope: OrchestrationArtifactEnvelope = {
        version: 1,
        owner: this.paths.owner,
        sourceSha256: input.sourceSha256,
        reference,
        content: input.content,
      };
      await atomicWritePrivateTextFile(filePath, JSON.stringify(envelope));
      return { ...reference };
    });
  }

  async read(reference: OrchestrationArtifactReference): Promise<string> {
    const parsed = parseOrchestrationArtifactReference(reference);
    const filePath = this.filePath(parsed.attemptKey);
    if (
      parsed.artifactId !== orchestrationDigest(parsed.attemptKey) ||
      parsed.uri !== pathToFileURL(filePath).href
    ) {
      throw new OrchestrationStoreError(
        "artifact_conflict",
        "Orchestration artifact reference is outside the parent session scope.",
      );
    }
    await this.paths.prepare(filePath);
    return withFileLock(filePath, async () => {
      const raw = await readOrchestrationJson(filePath);
      if (raw === undefined) {
        throw new OrchestrationStoreError(
          "artifact_conflict",
          "Orchestration artifact is missing.",
        );
      }
      const envelope = this.validate(raw, parsed.attemptKey, filePath);
      if (JSON.stringify(envelope.reference) !== JSON.stringify(parsed)) {
        throw new OrchestrationStoreError(
          "artifact_conflict",
          "Orchestration artifact reference has changed.",
        );
      }
      return envelope.content;
    });
  }

  private validate(
    value: unknown,
    attemptKey: string,
    filePath: string,
  ): OrchestrationArtifactEnvelope {
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return corruptArtifact();
    const input = value as Record<string, unknown>;
    if (input.version !== 1) {
      throw new OrchestrationStoreError(
        "unsupported_version",
        "Unsupported orchestration artifact version.",
      );
    }
    if (
      typeof input.content !== "string" ||
      !input.content.isWellFormed() ||
      typeof input.sourceSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(input.sourceSha256)
    )
      return corruptArtifact();
    if (typeof input.owner !== "object" || input.owner === null || Array.isArray(input.owner))
      return corruptArtifact();
    const rawOwner = input.owner as Record<string, unknown>;
    if (
      typeof rawOwner.workspacePath !== "string" ||
      typeof rawOwner.sessionId !== "string" ||
      (rawOwner.workspaceIdentity !== undefined &&
        typeof rawOwner.workspaceIdentity !== "string") ||
      (rawOwner.remoteSessionId !== undefined && typeof rawOwner.remoteSessionId !== "string")
    )
      return corruptArtifact();
    const owner = normalizeOrchestrationOwner({
      workspacePath: rawOwner.workspacePath,
      sessionId: rawOwner.sessionId,
      ...(typeof rawOwner.workspaceIdentity === "string"
        ? { workspaceIdentity: rawOwner.workspaceIdentity }
        : {}),
      ...(typeof rawOwner.remoteSessionId === "string"
        ? { remoteSessionId: rawOwner.remoteSessionId }
        : {}),
    });
    assertOrchestrationOwner(owner, this.paths.owner);
    const reference = parseOrchestrationArtifactReference(input.reference);
    if (
      reference.attemptKey !== attemptKey ||
      reference.artifactId !== orchestrationDigest(attemptKey) ||
      reference.uri !== pathToFileURL(filePath).href ||
      reference.savedBytes !== Buffer.byteLength(input.content, "utf8") ||
      reference.sha256 !== orchestrationDigest(input.content)
    )
      return corruptArtifact();
    return {
      version: 1,
      owner,
      sourceSha256: input.sourceSha256,
      reference,
      content: input.content,
    };
  }
}

function corruptArtifact(): never {
  throw new OrchestrationStoreError(
    "artifact_conflict",
    "Orchestration artifact content or metadata is invalid.",
  );
}
