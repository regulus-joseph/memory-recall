/**
 * Stub type declarations for openclaw/plugin-sdk
 * Runtime types are provided by the openclaw host at plugin load time.
 * This file only exists to satisfy TypeScript compilation - it is NOT published
 * and does not affect runtime behavior.
 */
interface OpenClawPluginApi {
  on(name: string, handler: (event: unknown, ctx?: unknown) => Promise<void>, opts?: unknown): void;
  logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void; error(msg: string, ...args: unknown[]): void };
  registerService(name: string, handler: () => void, intervalMs?: number): void;
  registerTool(toolDef: unknown, executeFn?: unknown): void;
  registerHook(name: string, priority: number, handler: (ctx: unknown) => Promise<void>): void;
  registerCli(registrar: unknown, opts?: unknown): void;
  pluginConfig?: unknown;
}

export type { OpenClawPluginApi };