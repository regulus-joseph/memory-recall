/**
 * Stub type declarations for openclaw/plugin-sdk
 * Runtime types are provided by the openclaw host at plugin load time.
 * This file only exists to satisfy TypeScript compilation - it is NOT published
 * and does not affect runtime behavior.
 */
declare module "openclaw/plugin-sdk" {
  interface OpenClawPluginApi {
    on(name: string, handler: (event: unknown, ctx?: unknown) => Promise<void>): void;
    logger: { info(msg: string, ...args: unknown[]): void; warn(msg: string, ...args: unknown[]): void; error(msg: string, ...args: unknown[]): void };
    registerService(name: string, handler: () => void, intervalMs?: number): void;
    registerTool(name: string, schema: unknown, handler: (params: unknown) => Promise<unknown>): void;
    registerHook(name: string, priority: number, handler: (ctx: unknown) => Promise<void>): void;
    registerCli(registrar: unknown, opts?: unknown): void;
  }
  export { OpenClawPluginApi };
}

export type { OpenClawPluginApi };
