import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ModelSelection } from "@shared/contracts";
import type { BrowserScope } from "@shared/browser-contracts";
import type { ComputerModelConfiguration, ComputerTask, ComputerTaskId, ComputerTaskStart, ComputerTaskStep } from "@shared/computer-task-contracts";
import { AevorenBotError } from "./errors";

type LayoutMigration = import("@shared/browser-contracts").InternalBrowserRecord & {
  execution?: Pick<import("@shared/environment-contracts").Environment, "workerVersion" | "imageRef" | "imageDigest" | "platform">;
};

export const COMPUTER_TASK_MIGRATION = { version: 43, sql: `
  ALTER TABLE browser_sessions ADD COLUMN desktop_observation_id TEXT;
  ALTER TABLE browser_screenshots ADD COLUMN desktop_json TEXT CHECK(desktop_json IS NULL OR json_valid(desktop_json));
  CREATE TABLE computer_layout_migrations (environment_id TEXT PRIMARY KEY REFERENCES environments(id) ON DELETE CASCADE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
  CREATE TABLE computer_applications (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE, client_nonce TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), UNIQUE(session_id,executor_bot_id,client_nonce));
  CREATE TABLE computer_application_launches (id TEXT PRIMARY KEY, environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
  CREATE TABLE computer_model_settings (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, selection_json TEXT NOT NULL CHECK(json_valid(selection_json)));
  CREATE TABLE computer_tasks (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    executor_bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
    parent_run_id TEXT REFERENCES runtime_runs(id) ON DELETE SET NULL, client_nonce TEXT NOT NULL,
    state TEXT NOT NULL, version INTEGER NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
    UNIQUE(session_id,executor_bot_id,client_nonce));
  CREATE TABLE computer_task_steps (
    id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES computer_tasks(id) ON DELETE CASCADE,
    payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
  CREATE INDEX computer_tasks_scope ON computer_tasks(session_id,executor_bot_id);
  CREATE INDEX computer_steps_task ON computer_task_steps(task_id);
` } as const;

// Preview builds used versions 43–47 for other features. Keep the published
// migration, then reconcile only missing computer objects at a fresh version.
export const COMPUTER_TASK_COMPATIBILITY_MIGRATION = {
  version: 48,
  sql: COMPUTER_TASK_MIGRATION.sql
    .replace("ALTER TABLE browser_sessions ADD COLUMN desktop_observation_id TEXT;", "")
    .replace("ALTER TABLE browser_screenshots ADD COLUMN desktop_json TEXT CHECK(desktop_json IS NULL OR json_valid(desktop_json));", "")
    .replaceAll("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ")
    .replaceAll("CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "),
} as const;

export function restoreComputerObservationColumns(database: DatabaseSync): void {
  for (const [table, column, definition] of [
    ["browser_sessions", "desktop_observation_id", "TEXT"],
    ["browser_screenshots", "desktop_json", "TEXT CHECK(desktop_json IS NULL OR json_valid(desktop_json))"],
  ]) {
    const columns = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some(value => value.name === column)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export class ComputerTaskRepository {
  constructor(private readonly db: DatabaseSync, private readonly assertScope: (scope: BrowserScope) => void,
    private readonly nextFileEvidenceOrdinal: () => number) {}

  layoutMigration(environmentId: string): LayoutMigration | null {
    const row = this.db.prepare("SELECT payload_json FROM computer_layout_migrations WHERE environment_id=?").get(environmentId) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as LayoutMigration : null;
  }
  saveLayoutMigration(record: LayoutMigration | null, environmentId: string): void {
    if (record) this.db.prepare("INSERT OR REPLACE INTO computer_layout_migrations VALUES(?,?)").run(environmentId, JSON.stringify(record));
    else this.db.prepare("DELETE FROM computer_layout_migrations WHERE environment_id=?").run(environmentId);
  }
  configuration(initial: ModelSelection): ComputerModelConfiguration {
    this.db.prepare("INSERT OR IGNORE INTO computer_model_settings VALUES(1,1,?)").run(JSON.stringify(initial));
    const row = this.db.prepare("SELECT version,selection_json FROM computer_model_settings WHERE id=1").get() as { version: number; selection_json: string };
    return { version: row.version, selection: JSON.parse(row.selection_json) as ModelSelection };
  }
  saveConfiguration(expectedVersion: number, selection: ModelSelection): ComputerModelConfiguration {
    const result = this.db.prepare("UPDATE computer_model_settings SET version=version+1,selection_json=? WHERE id=1 AND version=?").run(JSON.stringify(selection), expectedVersion);
    if (result.changes !== 1) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
    return { version: expectedVersion + 1, selection };
  }
  get(input: ComputerTaskId): ComputerTask {
    this.assertScope(input);
    const row = this.db.prepare("SELECT payload_json FROM computer_tasks WHERE id=? AND session_id=? AND executor_bot_id=?").get(input.id, input.sessionId, input.executorBotId) as { payload_json: string } | undefined;
    if (!row) throw new AevorenBotError("COMPUTER_TASK_NOT_FOUND");
    return JSON.parse(row.payload_json) as ComputerTask;
  }
  list(scope: BrowserScope): ComputerTask[] {
    this.assertScope(scope);
    return (this.db.prepare("SELECT payload_json FROM computer_tasks WHERE session_id=? AND executor_bot_id=? ORDER BY rowid DESC LIMIT 100").all(scope.sessionId, scope.executorBotId) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as ComputerTask);
  }
  forTarget(target: "builtin" | "mac"): ComputerTask[] {
    return (this.db.prepare("SELECT payload_json FROM computer_tasks WHERE state IN ('queued','running','waiting_user') ORDER BY rowid DESC").all() as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as ComputerTask).filter(task => (task.target ?? "builtin") === target);
  }
  forParent(runId: string): ComputerTask[] {
    return (this.db.prepare("SELECT payload_json FROM computer_tasks WHERE parent_run_id=?").all(runId) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as ComputerTask);
  }
  findByNonce(scope: BrowserScope, nonce: string): ComputerTask | null {
    this.assertScope(scope);
    const prior = this.db.prepare("SELECT id FROM computer_tasks WHERE session_id=? AND executor_bot_id=? AND client_nonce=?").get(scope.sessionId, scope.executorBotId, nonce) as { id: string } | undefined;
    return prior ? this.get({ ...scope, id: prior.id }) : null;
  }
  create(input: ComputerTaskStart & Pick<ComputerTask, "hostTarget">, parentRunId: string | null, selection: ModelSelection, providerVersion: number): { task: ComputerTask; reused: boolean } {
    this.assertScope(input);
    const prior = this.db.prepare("SELECT id FROM computer_tasks WHERE session_id=? AND executor_bot_id=? AND client_nonce=?").get(input.sessionId, input.executorBotId, input.clientNonce) as { id: string } | undefined;
    if (prior) {
      const task = this.get({ ...input, id: prior.id });
      if (task.goal !== input.goal || task.parentRunId !== parentRunId || (task.target ?? "builtin") !== (input.target ?? "builtin")) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
      return { task, reused: true };
    }
    const at = new Date().toISOString();
    const task: ComputerTask = { id: randomUUID(), sessionId: input.sessionId, executorBotId: input.executorBotId, parentRunId, goal: input.goal, target: input.target ?? "builtin",
      ...(input.target === "mac" ? { hostTarget: input.hostTarget } : {}), state: "queued", version: 1, modelSelection: selection, providerVersion, segment: 1, actionCount: 0, result: null, errorCode: null, createdAt: at, updatedAt: at };
    this.db.prepare("INSERT INTO computer_tasks VALUES(?,?,?,?,?,?,?,?)").run(task.id, task.sessionId, task.executorBotId, parentRunId, input.clientNonce, task.state, task.version, JSON.stringify(task));
    return { task, reused: false };
  }
  update(input: ComputerTaskId, expectedVersion: number, patch: Partial<Pick<ComputerTask, "state" | "segment" | "actionCount" | "result" | "errorCode" | "parentRunId" | "outputFiles">>): ComputerTask {
    const current = this.get(input);
    const task = { ...current, ...patch, version: expectedVersion + 1, updatedAt: new Date().toISOString() };
    const result = this.db.prepare("UPDATE computer_tasks SET state=?,version=?,payload_json=?,parent_run_id=? WHERE id=? AND version=?").run(task.state, task.version, JSON.stringify(task), task.parentRunId, task.id, expectedVersion);
    if (result.changes !== 1) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
    return task;
  }
  beginStep(input: ComputerTaskId, operation: string, value: unknown): ComputerTaskStep {
    const task = this.get(input);
    const step: ComputerTaskStep = { id: randomUUID(), taskId: task.id, segment: task.segment, operation, input: value,
      state: "started", result: null, createdAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO computer_task_steps VALUES(?,?,?)").run(step.id, task.id, JSON.stringify(step));
    return step;
  }
  finishStep(input: ComputerTaskId, step: ComputerTaskStep, state: ComputerTaskStep["state"], result: unknown): void {
    this.get(input);
    const ordinal = state === "completed" && step.fileEvidence && ["execution.readFile", "execution.writeFile"].includes(step.operation)
      ? this.nextFileEvidenceOrdinal() : undefined;
    this.db.prepare("UPDATE computer_task_steps SET payload_json=? WHERE id=? AND task_id=?").run(JSON.stringify({ ...step, state, result, fileEvidenceOrdinal: ordinal }), step.id, input.id);
  }
  steps(input: ComputerTaskId): ComputerTaskStep[] {
    this.get(input);
    return (this.db.prepare("SELECT payload_json FROM computer_task_steps WHERE task_id=? ORDER BY rowid").all(input.id) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as ComputerTaskStep);
  }
  recover(): void {
    const rows = this.db.prepare("SELECT payload_json FROM computer_tasks WHERE state IN ('queued','running')").all() as { payload_json: string }[];
    for (const row of rows) {
      const task = JSON.parse(row.payload_json) as ComputerTask;
      this.update(task, task.version, { state: "interrupted", errorCode: "APPLICATION_RESTARTED" });
      for (const step of this.steps(task).filter(step => step.state === "started")) this.finishStep(task, step, "unknown", { code: "APPLICATION_RESTARTED", replayAllowed: false });
    }
  }
}
