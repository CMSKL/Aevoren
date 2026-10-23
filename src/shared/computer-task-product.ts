import { z } from "zod";
import { modelSelectionSchema } from "./schemas";
import { browserScopeSchema } from "./browser-schemas";
import { COMPUTER_MODEL_CHANNELS, COMPUTER_TASK_CHANNELS } from "./computer-task-contracts";
import type { ProductOperationDefinition } from "./product-operations";

const scope = { sessionId: true, executorBotId: true } as const;
export const computerTaskStartSchema = browserScopeSchema.extend({ goal: z.string().trim().min(1).max(16_000), clientNonce: z.string().uuid(), target: z.enum(["builtin", "mac"]).optional() });
export const computerTaskIdSchema = browserScopeSchema.extend({ id: z.string().uuid() });
export const computerTaskMutationSchema = computerTaskIdSchema.extend({ expectedVersion: z.number().int().positive() });
export const computerModelSaveSchema = z.object({ expectedVersion: z.number().int().positive(), selection: modelSelectionSchema }).strict();
export const COMPUTER_TASK_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "computer.tasks.start": computerTaskStartSchema.omit({ clientNonce: true }).partial(scope),
  "computer.tasks.get": computerTaskIdSchema.partial(scope), "computer.tasks.list": browserScopeSchema.partial(scope).optional(),
  "computer.tasks.cancel": computerTaskMutationSchema.partial(scope), "computer.tasks.resume": computerTaskMutationSchema.partial(scope),
  "computer.model.get": z.undefined(), "computer.model.save": computerModelSaveSchema, "computer.model.test": z.undefined(),
};
export const COMPUTER_TASK_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = [
  ...Object.entries(COMPUTER_TASK_CHANNELS).map(([method, channel]) => ({ name: `computer.tasks.${method}`, channel })),
  ...Object.entries(COMPUTER_MODEL_CHANNELS).map(([method, channel]) => ({ name: `computer.model.${method}`, channel })),
].map(({ name, channel }) => ({ name, channel, description: ({
  "computer.tasks.start": "委派完整电脑任务给设置中的电脑执行模型；自动准备、观察、操作和验证，返回持久任务 ID；target=builtin 为隔离 Linux，target=mac 为经用户启用的宿主 Mac（含已有浏览器窗口），省略时用设置中的默认电脑。本机浏览器通过屏幕操作，不提供 DOM 或宿主 Shell",
  "computer.tasks.get": "查询当前范围电脑任务的实际结果与步骤，不能将 running 当作完成",
  "computer.tasks.list": "列出当前电脑任务", "computer.tasks.cancel": "取消当前范围内指定电脑任务，保留实际结果并释放输入",
  "computer.tasks.resume": "继续已暂停或中断的电脑任务；重新观察，不重放未知副作用",
  "computer.model.get": "读取独立电脑模型选择", "computer.model.save": "保存独立电脑模型选择，不改变已有 Bot 的模型或正在运行的任务",
  "computer.model.test": "用当前范围电脑的受控图像和工具往返验证电脑模型，真实请求可能使用当前连接额度",
} as Record<string, string>)[name]!, effectClass: name.endsWith(".get") || name.endsWith(".list") ? "read-local" : "write-reversible", interaction: "none" }));
