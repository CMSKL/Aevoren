import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProductToolRequest, ToolEvent, ToolRequest } from "@shared/contracts";
import type { ProductDependencies } from "./product-handlers";
import { AppRepository } from "./database";
import { ProductOperationService } from "./product-operation-service";
import { WorkspaceService } from "./workspace-service";
import { WorkspaceToolCoordinator } from "./workspace-tool-coordinator";
import { WorkspaceToolExecutor } from "./workspace-tool-executor";

vi.mock("electron", () => ({ clipboard: { writeText: vi.fn() } }));

const fixtures: Array<{ repository: AppRepository; root: string }> = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aevoren-direct-creation-"));
  const repository = new AppRepository(join(root, "app.sqlite"));
  fixtures.push({ repository, root });
  const workspaceService = new WorkspaceService(repository);
  const register = async (name: string) => {
    const path = join(root, name);
    mkdirSync(path);
    return workspaceService.registerRoot(path);
  };
  const current = await register("current-project"), foreign = await register("foreign-project");
  const actor = repository.createBot(current.project.id), sibling = repository.createBot(current.project.id);
  const outsider = repository.createBot(foreign.project.id);
  const clientNonce = randomUUID();
  repository.prepareMessage({ sessionId: actor.session.id, clientNonce, text: "在当前项目创建 Bot、群聊或内容团队。不要扩大文件授权。" });
  const runtime = repository.createRuntimeRun(clientNonce, "fake", { schemaVersion: 1, botId: actor.bot.id, profileVersion: actor.bot.version,
    sessionId: actor.session.id, generation: actor.session.generation, inputSeq: repository.getUserMessage(clientNonce).seq,
    blocks: [], digest: "direct-creation-scope" });
  repository.transitionRuntimeRun(runtime.id, "dispatching");
  repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "direct-creation-scope" });
  const executor = new WorkspaceToolExecutor(repository, workspaceService), events: ToolEvent[] = [];
  const coordinator = new WorkspaceToolCoordinator(repository, executor, event => events.push(event));
  const service = new ProductOperationService({ repository, workspaceService, workspaceToolCoordinator: coordinator,
    providers: { list: async () => [], getCapabilities: () => ({ handoff: false }), isSupported: () => true },
  } as unknown as ProductDependencies);
  executor.setProductOperations(service);
  const request = async (tool: ToolRequest, selectedRuntime = runtime) => {
    const controller = new AbortController(), toolCallId = randomUUID();
    let pending: ReturnType<WorkspaceToolCoordinator["requestAndWait"]> | undefined;
    try {
      pending = coordinator.requestAndWait(selectedRuntime.id, toolCallId, tool, controller.signal);
      void pending.catch(() => undefined);
      const invocation = repository.listToolInvocations(selectedRuntime.sessionId).find(value => value.toolCallId === toolCallId);
      if (invocation) expect(repository.getApprovalRequest(invocation.approvalRequestId).state).not.toBe("pending");
      return JSON.parse((await pending).content) as { ok: boolean; error?: { code: string } };
    } finally {
      controller.abort();
      await pending?.catch(() => undefined);
    }
  };
  return { repository, current, foreign, actor, sibling, outsider, service, events, request };
}

afterEach(() => {
  for (const { repository, root } of fixtures.splice(0)) {
    repository.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const call = (operation: string, input: object): ProductToolRequest => ({ kind: "product-call", action: "execute", operation, input });
const operations = ["bots.create", "rooms.create", "teams.createContentTeam"] as const;
const creationCases = operations.flatMap(operation => [false, true].map(explicitProject => ({ operation, explicitProject })));

describe("direct AI creation scope", () => {
  it.each(creationCases)("creates $operation directly without directory grants (explicit project: $explicitProject)", async ({ operation, explicitProject }) => {
    const f = await fixture(), beforeBots = new Set(f.repository.listBots().map(value => value.id));
    const beforeRooms = new Set(f.repository.listRooms().map(value => value.id));
    const input = { ...(explicitProject ? { projectId: f.current.project.id } : {}),
      ...(operation === "rooms.create" ? { memberBotIds: [f.actor.bot.id, f.sibling.bot.id], leadBotId: null } : {}) };
    expect(f.repository.listSessionWorkspaces(f.actor.session.id, f.actor.bot.id).map(value => value.id)).toEqual([f.current.workspace.id]);
    expect(await f.request(call(operation, input))).toMatchObject({ ok: true });
    const bots = f.repository.listBots().filter(value => !beforeBots.has(value.id));
    const rooms = f.repository.listRooms().filter(value => !beforeRooms.has(value.id));
    expect(bots.length + rooms.length).toBeGreaterThan(0);
    for (const bot of bots) {
      const session = f.repository.getMainSession(bot.id);
      expect(f.repository.getSessionProjectId(session.id)).toBe(f.current.project.id);
      expect(f.repository.listSessionWorkspaces(session.id, bot.id)).toEqual([]);
    }
    for (const room of rooms) {
      const session = f.repository.getRoomDetail(room.id).session;
      expect(f.repository.getSessionProjectId(session.id)).toBe(f.current.project.id);
      for (const member of f.repository.listRoomMembers(room.id)) {
        expect(f.repository.listSessionWorkspaces(session.id, member.bot.id)).toEqual([]);
      }
    }
    expect(f.repository.listPendingApprovalRequests(f.actor.session.id)).toEqual([]);
    expect(f.events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
  });

  it.each(operations)("rejects a foreign project for %s without creating resources or requesting approval", async operation => {
    const f = await fixture(), botIds = f.repository.listBots().map(value => value.id), roomIds = f.repository.listRooms().map(value => value.id);
    const input = { projectId: f.foreign.project.id,
      ...(operation === "rooms.create" ? { memberBotIds: [f.actor.bot.id, f.sibling.bot.id], leadBotId: null } : {}) };
    let failure: unknown;
    try { const result = await f.request(call(operation, input)); if (!result.ok) failure = result.error; }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: expect.any(String) });
    expect(f.repository.listBots().map(value => value.id)).toEqual(botIds);
    expect(f.repository.listRooms().map(value => value.id)).toEqual(roomIds);
    expect(f.repository.listPendingApprovalRequests(f.actor.session.id)).toEqual([]);
    expect(f.events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
  });

  it("creates a legacy Room directly without inheriting the project directory", async () => {
    const f = await fixture();
    expect(await f.request({ kind: "room-create", name: "Scoped room", description: "",
      memberBotIds: [f.actor.bot.id, f.sibling.bot.id] })).toMatchObject({ ok: true });
    const room = f.repository.listRooms().find(value => value.name === "Scoped room")!, session = f.repository.getRoomDetail(room.id).session;
    expect(f.repository.getSessionProjectId(session.id)).toBe(f.current.project.id);
    for (const member of f.repository.listRoomMembers(room.id)) {
      expect(f.repository.listSessionWorkspaces(session.id, member.bot.id)).toEqual([]);
    }
    expect(f.repository.listPendingApprovalRequests(f.actor.session.id)).toEqual([]);
    expect(f.events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
  });

  it.each(["product", "legacy"] as const)("allows global contacts through the %s Room gateway without copying directory grants or private history", async transport => {
    const f = await fixture(), roomIds = f.repository.listRooms().map(value => value.id);
    const privateText = "PRIVATE_FOREIGN_CONTACT_HISTORY";
    f.repository.prepareMessage({ sessionId: f.outsider.session.id, clientNonce: randomUUID(), text: privateText });
    expect(JSON.stringify(f.repository.listTranscript(f.outsider.session.id))).toContain(privateText);
    const memberBotIds = [f.actor.bot.id, f.outsider.bot.id];
    const tool: ToolRequest = transport === "product" ? call("rooms.create", { projectId: f.current.project.id, memberBotIds, leadBotId: null })
      : { kind: "room-create", name: "Foreign members", description: "", memberBotIds };
    const result = await f.request(tool);
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(result)).not.toContain(privateText);
    const created = f.repository.listRooms().filter(value => !roomIds.includes(value.id));
    expect(created).toHaveLength(1);
    const room = f.repository.getRoomDetail(created[0]!.id);
    expect(room.members.map(member => member.bot.id).sort()).toEqual([...memberBotIds].sort());
    expect(f.repository.getSessionProjectId(room.session.id)).toBe(f.current.project.id);
    for (const botId of memberBotIds) expect(f.repository.listSessionWorkspaces(room.session.id, botId)).toEqual([]);
    expect(JSON.stringify(f.repository.listTranscript(room.session.id))).not.toContain(privateText);
    expect(f.repository.listPendingApprovalRequests(f.actor.session.id)).toEqual([]);
    expect(f.events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
  });

  it.each(operations)("uses the current group conversation project for %s rather than the executing contact's home project", async operation => {
    const f = await fixture(), source = f.repository.createRoom({ projectId: f.current.project.id,
      memberBotIds: [f.actor.bot.id, f.outsider.bot.id], leadBotId: null });
    const batch = f.repository.createRoomRunWithInitialTurns({ roomId: source.room.id, sessionId: source.session.id, clientNonce: randomUUID(),
      text: "在本群当前项目创建资源，不扩大目录授权。", membershipVersion: source.room.membershipVersion, maxTurns: 8, maxHops: 6,
      maxTargetsPerTurn: 2, deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      initialTurns: [{ agentId: f.outsider.bot.id, nonce: randomUUID() }], routingMode: "explicit", orchestrationEnabled: false });
    f.repository.transitionRoomBatch(batch.run.id, "running");
    const initial = batch.turns[0]!, turn = f.repository.transitionRoomTurn(initial.id, "running", { promptCutoffSeq: initial.inputSeq });
    const runtime = f.repository.createRuntimeRun(batch.run.clientNonce, "fake", { schemaVersion: 2, botId: f.outsider.bot.id,
      profileVersion: f.outsider.bot.version, sessionId: source.session.id, generation: turn.inputGeneration, inputSeq: turn.inputSeq,
      promptCutoffSeq: turn.inputSeq, roomId: source.room.id, roomMembershipVersion: batch.run.membershipVersion,
      executorBotId: f.outsider.bot.id, sourceTurnId: turn.id, blocks: [], digest: "group-creation-project" },
    { executorBotId: f.outsider.bot.id, executionKey: `${batch.run.id}:${turn.logicalTurnId}`, inputSeq: turn.inputSeq, promptCutoffSeq: turn.inputSeq });
    f.repository.attachRoomTurnRuntime(turn.id, runtime.id);
    f.repository.transitionRuntimeRun(runtime.id, "dispatching");
    f.repository.transitionRuntimeRun(runtime.id, "running", { providerRequestId: "group-creation-project" });
    const botIds = new Set(f.repository.listBots().map(value => value.id)), roomIds = new Set(f.repository.listRooms().map(value => value.id));
    expect(f.outsider.bot.projectId).toBe(f.foreign.project.id);
    const input = operation === "rooms.create" ? { memberBotIds: [f.actor.bot.id, f.sibling.bot.id], leadBotId: null } : {};
    expect(await f.request(call(operation, input), runtime)).toMatchObject({ ok: true });
    for (const bot of f.repository.listBots().filter(value => !botIds.has(value.id))) {
      const session = f.repository.getMainSession(bot.id);
      expect(f.repository.getSessionProjectId(session.id)).toBe(f.current.project.id);
      expect(f.repository.listSessionWorkspaces(session.id, bot.id)).toEqual([]);
    }
    for (const room of f.repository.listRooms().filter(value => !roomIds.has(value.id))) {
      const session = f.repository.getRoomDetail(room.id).session;
      expect(f.repository.getSessionProjectId(session.id)).toBe(f.current.project.id);
      for (const member of f.repository.listRoomMembers(room.id)) expect(f.repository.listSessionWorkspaces(session.id, member.bot.id)).toEqual([]);
    }
    expect(f.repository.listPendingApprovalRequests(source.session.id)).toEqual([]);
    expect(f.events.some(event => event.invocation.state === "awaiting-approval")).toBe(false);
  });

  it.each([false, true])("requires approval to add a member only when the target group has directory grants (granted: %s)", async grantWorkspace => {
    const f = await fixture(), room = f.repository.createRoom({ projectId: f.current.project.id,
      memberBotIds: [f.actor.bot.id, f.sibling.bot.id], leadBotId: null }, grantWorkspace);
    expect(f.repository.listSessionWorkspaces(room.session.id, f.actor.bot.id).map(value => value.id))
      .toEqual(grantWorkspace ? [f.current.workspace.id] : []);
    expect(f.service.requiresApproval(call("rooms.addMember", { roomId: room.room.id, botId: f.outsider.bot.id,
      expectedMembershipVersion: room.room.membershipVersion }))).toBe(grantWorkspace);
  });

  it.each([false, true])("always requires approval to remove a member (directory granted: %s)", async grantWorkspace => {
    const f = await fixture(), room = f.repository.createRoom({ projectId: f.current.project.id,
      memberBotIds: [f.actor.bot.id, f.sibling.bot.id, f.outsider.bot.id], leadBotId: null }, grantWorkspace);
    expect(f.service.requiresApproval(call("rooms.removeMember", { roomId: room.room.id, botId: f.outsider.bot.id,
      expectedMembershipVersion: room.room.membershipVersion }))).toBe(true);
  });

  it("preserves directory grants for explicit UI creation", async () => {
    const f = await fixture(), bot = f.repository.createBot(f.current.project.id);
    const room = f.repository.createRoom({ projectId: f.current.project.id, memberBotIds: [f.actor.bot.id, f.sibling.bot.id] });
    const team = f.repository.createContentTeamTemplate(f.current.project.id);
    expect(f.repository.listSessionWorkspaces(bot.session.id, bot.bot.id).map(value => value.id)).toEqual([f.current.workspace.id]);
    expect(f.repository.listSessionWorkspaces(room.session.id, f.actor.bot.id).map(value => value.id)).toEqual([f.current.workspace.id]);
    for (const member of team.bots) {
      expect(f.repository.listSessionWorkspaces(f.repository.getMainSession(member.id).id, member.id).map(value => value.id)).toEqual([f.current.workspace.id]);
      expect(f.repository.listSessionWorkspaces(team.room.session.id, member.id).map(value => value.id)).toEqual([f.current.workspace.id]);
    }
  });
});
