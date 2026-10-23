import { APPLICATION_CHANNELS } from "./application-channels";
export { APPLICATION_CHANNELS } from "./application-channels";
import { z } from "zod";
import type { ApiResult } from "./contracts";
import { browserScopeSchema } from "./browser-schemas";
import type { ProductOperationDefinition } from "./product-operations";

const executable = z.string().min(1).max(512).regex(/^[A-Za-z0-9_./+-]+$/);
const binary = z.object({ url: z.string().url().max(2_048).refine(value => new URL(value).protocol === "https:"), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const applicationSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apt"), packages: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9+.:~_-]+)?$/).max(200)).min(1).max(20), executable }).strict(),
  binary.extend({ kind: z.literal("deb"), executable }).strict(),
  binary.extend({ kind: z.literal("appimage"), executable: z.literal("AppRun").default("AppRun") }).strict(),
  binary.extend({ kind: z.literal("portable"), executable: z.literal("/opt/aevoren-application/program").default("/opt/aevoren-application/program") }).strict(),
]);
export type ApplicationSource = z.infer<typeof applicationSourceSchema>;
export const applicationInstallSchema = browserScopeSchema.extend({ clientNonce: z.string().uuid(), name: z.string().trim().min(1).max(120), source: applicationSourceSchema });
export const applicationLaunchSchema = browserScopeSchema.extend({ clientNonce: z.string().uuid(), id: z.string().min(1).max(80), args: z.array(z.string().max(4_096).refine(value => !value.includes("\0"))).max(40).default([]) });
export type ApplicationInstall = z.infer<typeof applicationInstallSchema>;
export type ApplicationLaunch = z.infer<typeof applicationLaunchSchema>;
export type Application = { id: string; name: string; state: "building" | "pending" | "installed" | "failed" | "interrupted"; source: ApplicationSource | null;
  imageDigest: string | null; baseImageDigest: string | null; platform: string; executable: string; packageVersions: string | null; error: string | null; createdAt: string; updatedAt: string };
export type ApplicationProcess = { id: string; applicationId: string; state: string; exitCode: number | null };
export type ApplicationsApi = {
  install(input: ApplicationInstall): Promise<ApiResult<Application>>;
  list(input: z.infer<typeof browserScopeSchema>): Promise<ApiResult<Application[]>>;
  launch(input: ApplicationLaunch): Promise<ApiResult<ApplicationProcess>>;
};
const scope = { sessionId: true, executorBotId: true } as const;
export const APPLICATION_OPERATION_SCHEMAS: Record<string, z.ZodType> = {
  "applications.install": applicationInstallSchema.omit({ clientNonce: true }).partial(scope),
  "applications.list": browserScopeSchema.partial(scope).optional(),
  "applications.launch": applicationLaunchSchema.omit({ clientNonce: true }).partial(scope),
};
export const APPLICATION_PRODUCT_OPERATIONS: readonly ProductOperationDefinition[] = Object.entries(APPLICATION_CHANNELS).map(([method, channel]) => ({
  name: `applications.${method}`, channel, description: ({ install: "在无用户资料和凭据的构建环境安装兼容 Linux 应用；失败保留原电脑，忙碌时待应用", list: "列出当前隔离电脑的真实应用安装状态及版本", launch: "在当前隔离桌面启动已安装应用，共用自己的文件、下载与浏览器资料" } as Record<string, string>)[method]!,
  effectClass: method === "list" ? "read-local" : "irreversible", interaction: "none",
}));
