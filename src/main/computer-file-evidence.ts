import { createHash } from "node:crypto";
import type { ComputerFileEvidence, ComputerTaskId, EnvironmentFileEvidence } from "@shared/computer-task-contracts";
import type { ToolInvocation } from "@shared/contracts";
import { environmentFilePathSchema } from "@shared/environment-schemas";
import type { AppRepository } from "./database";

export type HostFileEvidence = EnvironmentFileEvidence & { delivered: boolean; taskId?: string; stepId?: string };

/** Only current, host-recorded direct file operations can be combined with child steps. */
export function directFileEvidence(repository: AppRepository, runId: string, tools?: ToolInvocation[]): EnvironmentFileEvidence[] {
  const run = repository.getRuntimeRun(runId);
  if (repository.browsers.view(run)?.owner === "user") return [];
  const environment = repository.environments.getInternal(run);
  if (!environment?.bootId) return [];
  const invocations = tools ?? repository.listToolInvocations(run.sessionId);
  return invocations.flatMap((tool) => {
    const meta = tool.resultMetadata, request = tool.arguments;
    if (tool.runtimeRunId !== runId || tool.state !== "succeeded" || request.kind !== "product-call" || request.action !== "execute" ||
      !["execution.readFile", "execution.writeFile"].includes(request.operation) || meta?.operation !== request.operation || meta.status !== "completed" ||
      meta.fileEnvironmentId !== environment.id || meta.fileBootId !== environment.bootId || meta.fileImageDigest !== environment.imageDigest ||
      !Number.isSafeInteger(meta.fileEvidenceOrdinal) || Number(meta.fileEvidenceOrdinal) <= 0) return [];
    const path = environmentFilePathSchema.safeParse((request.input as { path?: unknown } | undefined)?.path);
    if (!path.success || meta.measurementResource !== path.data || typeof meta.measurementDigest !== "string" || !/^[a-f0-9]{64}$/u.test(meta.measurementDigest) ||
      typeof meta.measurementBytes !== "number" || !Number.isSafeInteger(meta.measurementBytes) || meta.measurementBytes < 0 ||
      request.operation === "execution.readFile" && meta.truncated !== false) return [];
    return [{ environmentId: environment.id, bootId: environment.bootId!, imageDigest: environment.imageDigest,
      operation: request.operation as EnvironmentFileEvidence["operation"], path: path.data, sha256: meta.measurementDigest,
      bytes: meta.measurementBytes, ordinal: Number(meta.fileEvidenceOrdinal) }];
  }).sort((a, b) => a.ordinal - b.ordinal);
}

/** A read stays current only while no later write of the same path changed the file. */
export function currentFileRead(read: EnvironmentFileEvidence, files: EnvironmentFileEvidence[]): boolean {
  return read.operation === "execution.readFile" && !files.some(file => file.operation === "execution.writeFile" && file.path === read.path &&
    file.environmentId === read.environmentId && file.bootId === read.bootId && file.imageDigest === read.imageDigest && file.ordinal > read.ordinal);
}

/** A task-level projection also supports UI tasks that have no parent runtime. */
export function computerTaskFileEvidence(repository: AppRepository, input: ComputerTaskId): ComputerFileEvidence[] {
  const task = repository.computerTasks.get(input);
  if ((task.target ?? "builtin") !== "builtin" || repository.browsers.view(task)?.owner === "user") return [];
  const environment = repository.environments.getInternal(task);
  if (!environment?.bootId) return [];
  const files = repository.computerTasks.steps(task).flatMap((step): ComputerFileEvidence[] => {
    const identity = step.fileEvidence;
    if (step.state !== "completed" || step.taskId !== task.id || step.segment !== task.segment ||
      !identity || identity.parentRunId !== task.parentRunId || identity.environmentId !== environment.id ||
      identity.bootId !== environment.bootId || identity.imageDigest !== environment.imageDigest ||
      !Number.isSafeInteger(step.fileEvidenceOrdinal) || Number(step.fileEvidenceOrdinal) <= 0 ||
      !["execution.readFile", "execution.writeFile"].includes(step.operation)) return [];
    const input = step.input as { path?: unknown; content?: unknown; encoding?: unknown } | null;
    const parsedPath = environmentFilePathSchema.safeParse(input?.path);
    if (!parsedPath.success) return [];
    const wrapped = step.result as { action?: unknown } | null;
    const result = (step.operation === "execution.writeFile" ? wrapped?.action : step.result) as { path?: unknown; size?: unknown; sha256?: unknown; encoding?: unknown; content?: unknown } | null;
    if (!result || result.path !== parsedPath.data || typeof result.size !== "number" || !Number.isSafeInteger(result.size) || result.size < 0 ||
      typeof result.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(result.sha256)) return [];
    const source = step.operation === "execution.readFile" ? result : input;
    if (typeof source?.content !== "string" || source.encoding !== undefined && source.encoding !== "utf8" && source.encoding !== "base64") return [];
    const bytes = Buffer.from(source.content, source.encoding === "base64" ? "base64" : "utf8");
    if (bytes.length !== result.size || createHash("sha256").update(bytes).digest("hex") !== result.sha256) return [];
    return [{ taskId: task.id, stepId: step.id, segment: step.segment, taskVersion: task.version,
      environmentId: environment.id, bootId: environment.bootId!, imageDigest: environment.imageDigest,
      operation: step.operation as ComputerFileEvidence["operation"], path: parsedPath.data, sha256: result.sha256, bytes: result.size,
      ordinal: step.fileEvidenceOrdinal!, delivered: step.operation === "execution.readFile" && task.outputFiles?.some(file => file.stepId === step.id && file.path === parsedPath.data) === true }];
  }).sort((a, b) => a.ordinal - b.ordinal);
  return files.map(file => ({ ...file, delivered: file.delivered && currentFileRead(file, files) }));
}

/** Project only host-recorded file results; a task's summary or terminal state proves no file action. */
export function computerFileEvidence(repository: AppRepository, runId: string): ComputerFileEvidence[] {
  const run = repository.getRuntimeRun(runId);
  repository.assertSessionExecutor(run.sessionId, run.executorBotId);
  const files = repository.computerTasks.forParent(runId).filter(task => task.sessionId === run.sessionId && task.executorBotId === run.executorBotId)
    .flatMap(task => computerTaskFileEvidence(repository, task)).sort((a, b) => a.ordinal - b.ordinal);
  const allFiles = [...files, ...directFileEvidence(repository, runId)];
  return files.map(file => ({ ...file, delivered: file.delivered && currentFileRead(file, allFiles) }));
}

/** Direct and child file actions of one run share the host's durable operation order. */
export function runFileEvidence(repository: AppRepository, runId: string, tools?: ToolInvocation[]): HostFileEvidence[] {
  const child = computerFileEvidence(repository, runId);
  return [...directFileEvidence(repository, runId, tools).map(file => ({ ...file, delivered: false })), ...child].sort((a, b) => a.ordinal - b.ordinal);
}

export type FilePathEvidence = {
  latest?: HostFileEvidence; write?: HostFileEvidence; read?: HostFileEvidence; deliveredRead?: HostFileEvidence;
};

/** The newest action on a path decides its current content; earlier receipts stay historical. */
export function filePathEvidence(files: HostFileEvidence[], path: string): FilePathEvidence {
  const matching = files.filter(file => file.path === path);
  const latest = matching.at(-1);
  const write = matching.filter(file => file.operation === "execution.writeFile").at(-1);
  const read = matching.filter(file => file.operation === "execution.readFile").at(-1);
  const deliveredRead = matching.filter(file => file.delivered).at(-1);
  return { ...(latest ? { latest } : {}), ...(write ? { write } : {}), ...(read ? { read } : {}), ...(deliveredRead ? { deliveredRead } : {}) };
}

/** A readback proves the bytes of the final write, not an earlier version of the same path. */
export function readBackProves(files: HostFileEvidence[], path: string): boolean {
  const { write, read, deliveredRead } = filePathEvidence(files, path);
  if (write) return Boolean(read && read.ordinal >= write.ordinal && read.sha256 === write.sha256 &&
    read.environmentId === write.environmentId && read.bootId === write.bootId && read.imageDigest === write.imageDigest);
  if (!deliveredRead) return false;
  return !files.some(file => file.operation === "execution.writeFile" && file.path === path && file.ordinal > deliveredRead.ordinal);
}

/** A source read counts only while it still describes the current content of that path. */
export function currentPathRead(files: HostFileEvidence[], path: string): HostFileEvidence | undefined {
  const { read } = filePathEvidence(files, path);
  if (!read) return undefined;
  return files.some(file => file.operation === "execution.writeFile" && file.path === path && file.ordinal > read.ordinal) ? undefined : read;
}
