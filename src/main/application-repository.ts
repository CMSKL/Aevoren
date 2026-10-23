import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { BrowserScope } from "@shared/browser-contracts";
import type { Application, ApplicationInstall, ApplicationLaunch } from "@shared/application-contracts";
import { AevorenBotError } from "./errors";

export class ApplicationRepository {
  constructor(private readonly db: DatabaseSync, private readonly assertScope: (scope: BrowserScope) => void) {}
  list(scope: BrowserScope): Application[] {
    this.assertScope(scope);
    return (this.db.prepare("SELECT payload_json FROM computer_applications WHERE session_id=? AND executor_bot_id=? ORDER BY rowid DESC").all(scope.sessionId, scope.executorBotId) as { payload_json: string }[]).map(row => JSON.parse(row.payload_json) as Application);
  }
  findByNonce(scope: BrowserScope, nonce: string): Application | null {
    this.assertScope(scope);
    const row = this.db.prepare("SELECT payload_json FROM computer_applications WHERE session_id=? AND executor_bot_id=? AND client_nonce=?").get(scope.sessionId, scope.executorBotId, nonce) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as Application : null;
  }
  create(input: ApplicationInstall, platform: string): { application: Application; reused: boolean } {
    this.assertScope(input);
    const prior = this.db.prepare("SELECT payload_json FROM computer_applications WHERE session_id=? AND executor_bot_id=? AND client_nonce=?").get(input.sessionId, input.executorBotId, input.clientNonce) as { payload_json: string } | undefined;
    if (prior) {
      const application = JSON.parse(prior.payload_json) as Application;
      if (application.name !== input.name || JSON.stringify(application.source) !== JSON.stringify(input.source)) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
      return { application, reused: true };
    }
    const at = new Date().toISOString();
    const application: Application = { id: randomUUID(), name: input.name, state: "building", source: input.source, executable: input.source.executable,
      imageDigest: null, baseImageDigest: null, platform, packageVersions: null, error: null, createdAt: at, updatedAt: at };
    this.db.prepare("INSERT INTO computer_applications VALUES(?,?,?,?,?)").run(application.id, input.sessionId, input.executorBotId, input.clientNonce, JSON.stringify(application));
    return { application, reused: false };
  }
  save(scope: BrowserScope, value: Application): Application {
    this.assertScope(scope);
    const changed = { ...value, updatedAt: new Date().toISOString() };
    const result = this.db.prepare("UPDATE computer_applications SET payload_json=? WHERE id=? AND session_id=? AND executor_bot_id=?").run(JSON.stringify(changed), value.id, scope.sessionId, scope.executorBotId);
    if (result.changes !== 1) throw new AevorenBotError("INVALID_REQUEST");
    return changed;
  }
  launchRecord(environmentId: string, id: string, input: ApplicationLaunch, ai = false, imageDigest?: string, taskId?: string): { reused: boolean; imageDigest?: string } {
    this.assertScope(input);
    const row = this.db.prepare("SELECT payload_json FROM computer_application_launches WHERE id=? AND environment_id=?").get(id, environmentId) as { payload_json: string } | undefined;
    if (row) {
      const saved = JSON.parse(row.payload_json) as { input: ApplicationLaunch; imageDigest?: string };
      if (JSON.stringify(saved.input) !== JSON.stringify(input)) throw new AevorenBotError("COMPUTER_TASK_CONFLICT");
      return { reused: true, imageDigest: saved.imageDigest };
    }
    this.db.prepare("INSERT INTO computer_application_launches VALUES(?,?,?)").run(id, environmentId, JSON.stringify({ input, ai, imageDigest, taskId, state: "starting" }));
    return { reused: false, imageDigest };
  }
  launches(environmentId: string): { id: string; input: ApplicationLaunch; state: string; ai?: boolean; taskId?: string }[] {
    return (this.db.prepare("SELECT id,payload_json FROM computer_application_launches WHERE environment_id=?").all(environmentId) as { id: string; payload_json: string }[]).map(row => ({ id: row.id, ...JSON.parse(row.payload_json) as { input: ApplicationLaunch; state: string; ai?: boolean; taskId?: string } }));
  }
  finishLaunch(environmentId: string, id: string, state: string): void {
    const row = this.db.prepare("SELECT payload_json FROM computer_application_launches WHERE id=? AND environment_id=?").get(id, environmentId) as { payload_json: string } | undefined;
    if (!row) throw new AevorenBotError("INVALID_REQUEST");
    this.db.prepare("UPDATE computer_application_launches SET payload_json=? WHERE id=? AND environment_id=?").run(JSON.stringify({ ...JSON.parse(row.payload_json), state }), id, environmentId);
  }
  recover(): void {
    for (const row of this.db.prepare("SELECT id,payload_json FROM computer_applications").all() as { id: string; payload_json: string }[]) {
      const value = JSON.parse(row.payload_json) as Application;
      if (value.state === "building") this.db.prepare("UPDATE computer_applications SET payload_json=? WHERE id=?").run(JSON.stringify({ ...value, state: "interrupted", error: "APPLICATION_RESTARTED", updatedAt: new Date().toISOString() }), row.id);
    }
  }
}
