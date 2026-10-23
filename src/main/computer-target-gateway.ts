import { z } from "zod";
import { computerKeySchema, computerActionSchema, browserEpochSchema, browserUrlSchema, computerClickSchema, computerDragSchema, computerScrollSchema, computerTypeSchema } from "@shared/browser-schemas";
import type { ComputerToolGateway } from "./computer-tool-gateway";
import type { HostComputerService } from "./host-computer-service";
import { AevorenBotError } from "./errors";

/** Host tasks can address only their pinned background window or explicitly shared tab. */
export function withHostComputer(builtin: ComputerToolGateway, host: HostComputerService): ComputerToolGateway {
  const names = new Set(["computer.view", "computer.screenshot", "computer.click", "computer.type", "computer.key", "computer.scroll", "computer.move", "computer.drag"]);
  const appNames = new Set(["computer.view", "computer.screenshot", "computer.click", "computer.type", "computer.key"]);
  const definitions = builtin.definitions.filter(definition => names.has(definition.name)).map(definition => ({ ...definition, description: definition.description.replaceAll("隔离电脑", "当前已授权电脑").replaceAll("隔离桌面", "当前已授权桌面") }));
  const browserDefinitions = builtin.definitions.filter(definition => ["browser.read", "browser.navigate"].includes(definition.name)).map(definition => ({ ...definition, description: definition.name === "browser.read" ? "读取任务固定的共享标签页当前文本，不访问其他页面" : "将任务固定的共享标签页导航到 HTTP(S) 地址；操作后返回新画面，不操作地址栏" }));
  const scope = { sessionId: true, executorBotId: true } as const;
  const position = { x: z.number().int().min(0), y: z.number().int().min(0) }, button = z.enum(["left", "right"]).default("left");
  const click = computerClickSchema.extend({ ...position, button }).omit({ clientNonce: true }).partial(scope);
  const schemas: Record<string, z.ZodType> = { ...builtin.schemas, "computer.click": click, "computer.move": click,
    "computer.scroll": computerScrollSchema.extend(position).omit({ clientNonce: true }).partial(scope),
    "computer.type": computerTypeSchema.extend({ replace: z.boolean().default(false) }).omit({ clientNonce: true }).partial(scope),
    "browser.read": browserEpochSchema.partial(scope),
    "browser.navigate": computerActionSchema.extend({ url: browserUrlSchema }).omit({ clientNonce: true }).partial(scope),
    "computer.drag": computerDragSchema.extend({ path: z.array(z.object(position).strict()).min(2).max(128), button }).omit({ clientNonce: true }).partial(scope) };
  const appSchemas: Record<string, z.ZodType> = { ...schemas, "computer.click": click.extend({ button: z.literal("left").default("left") }), "computer.type": computerTypeSchema.extend({ x: position.x.optional(), y: position.y.optional(), replace: z.boolean().default(false) }).omit({ clientNonce: true }).partial(scope), "computer.key": computerKeySchema.extend({ x: position.x.optional(), y: position.y.optional(), key: z.string().regex(/^(Meta|Cmd|Command|cmd)\+[aA]$/u) }).omit({ clientNonce: true }).partial(scope) };
  const browserSchemas: Record<string, z.ZodType> = { ...schemas, "computer.type": computerTypeSchema.extend({ replace: z.literal(false).default(false) }).omit({ clientNonce: true }).partial(scope) };
  return {
    definitions: builtin.definitions, schemas: builtin.schemas, target: () => host.target(), hostTarget: () => host.hostTarget(),
    definitionsFor: task => task.target === "mac" ? task.hostTarget?.kind === "browser" ? [...definitions, ...browserDefinitions] : definitions.filter(item => appNames.has(item.name)).map(item => ({ ...item, description: item.description + (item.name === "computer.type" || item.name === "computer.key" ? "；请给出当前截图中文本字段x/y；字段须为目标应用内部聚焦字段，key只支持全选" : "；仅支持目标应用公开的辅助功能控件，不支持时停止，不转到前台") })) : builtin.definitions,
    schemasFor: task => task.target === "mac" ? task.hostTarget?.kind === "browser" ? browserSchemas : appSchemas : builtin.schemas,
    assertAI: task => task.target === "mac" ? host.assertAI(task) : builtin.assertAI(task),
    prepare: (task, signal) => task.target === "mac" ? host.prepare(task, signal) : builtin.prepare(task, signal),
    async execute(task, operation, input, stepId, signal) {
      if (task.target !== "mac") return builtin.execute(task, operation, input, stepId, signal);
      const allowed = task.hostTarget?.kind === "browser" ? names.has(operation) || ["browser.read", "browser.navigate"].includes(operation) : appNames.has(operation);
      if (!allowed) throw new AevorenBotError("HOST_COMPUTER_ACTION_UNSUPPORTED");
      const parsed = ((task.hostTarget?.kind === "browser" ? browserSchemas : appSchemas)[operation]!.parse(input) ?? {}) as Record<string, unknown>;
      if (parsed.sessionId !== undefined && parsed.sessionId !== task.sessionId || parsed.executorBotId !== undefined && parsed.executorBotId !== task.executorBotId) throw new AevorenBotError("BROWSER_SCOPE_INVALID");
      return host.execute(task, operation, parsed, signal);
    },
    cancel: task => task.target === "mac" ? host.release(task) : builtin.cancel(task),
    releaseInput: task => task.target === "mac" ? host.release(task) : builtin.releaseInput?.(task) ?? Promise.resolve(),
  };
}
