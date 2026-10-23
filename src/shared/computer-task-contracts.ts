import type { ApiResult, ModelSelection } from "./contracts";
import type { BrowserScope } from "./browser-contracts";

export type ComputerModelConfiguration = { version: number; selection: ModelSelection };
export type ComputerTaskState = "queued" | "running" | "waiting_user" | "paused" | "completed" | "failed" | "cancelled" | "interrupted";
export type ComputerTask = BrowserScope & {
  id: string; parentRunId: string | null; goal: string; state: ComputerTaskState; version: number;
  target?: import("./host-computer-contracts").ComputerTarget;
  hostTarget?: import("./host-computer-targets").HostComputerTarget;
  modelSelection: ModelSelection; providerVersion: number; segment: number; actionCount: number;
  result: string | null; errorCode: string | null; createdAt: string; updatedAt: string;
};
export type ComputerTaskStep = { id: string; taskId: string; segment: number; operation: string;
  input: unknown; state: "started" | "completed" | "failed" | "unknown"; result: unknown; createdAt: string };
export type ComputerTaskDetail = { task: ComputerTask; steps: ComputerTaskStep[] };
export type ComputerTaskStart = BrowserScope & { goal: string; clientNonce: string; target?: import("./host-computer-contracts").ComputerTarget };
export type ComputerTaskId = BrowserScope & { id: string };
export type ComputerTaskMutation = ComputerTaskId & { expectedVersion: number };
export const COMPUTER_TASK_CHANNELS = { start: "computerTasks:start", get: "computerTasks:get", list: "computerTasks:list", cancel: "computerTasks:cancel", resume: "computerTasks:resume" } as const;
export const COMPUTER_MODEL_CHANNELS = { get: "computerModel:get", save: "computerModel:save", test: "computerModel:test" } as const;
export const COMPUTER_TASK_CHANGED = "computerTasks:changed";
export type ComputerTasksApi = {
  start(input: ComputerTaskStart): Promise<ApiResult<ComputerTask>>;
  get(input: ComputerTaskId): Promise<ApiResult<ComputerTaskDetail>>;
  list(input: BrowserScope): Promise<ApiResult<ComputerTask[]>>;
  cancel(input: ComputerTaskMutation): Promise<ApiResult<ComputerTask>>;
  resume(input: ComputerTaskMutation): Promise<ApiResult<ComputerTask>>;
  onChanged(listener: (task: ComputerTask) => void): () => void;
};
export type ComputerModelApi = {
  get(): Promise<ApiResult<ComputerModelConfiguration>>;
  save(input: { expectedVersion: number; selection: ModelSelection }): Promise<ApiResult<ComputerModelConfiguration>>;
  test(): Promise<ApiResult<{ status: "verified"; providerVersion: number; selection: ModelSelection }>>;
};
