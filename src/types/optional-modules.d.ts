/**
 * Ambient declarations for optional channel adapter dependencies.
 *
 * These packages are not declared as direct dependencies — the adapters
 * import them dynamically and surface a friendly install hint if missing.
 * The minimal `any`-typed shims here keep `tsc --noEmit` green without
 * forcing every consumer to install `grammy` / `baileys`.
 */

declare module "grammy" {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const Bot: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const grammy: any;
    export default grammy;
}

declare module "baileys" {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const baileys: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export default baileys;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const makeWASocket: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const useMultiFileAuthState: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const DisconnectReason: any;
}

declare module "playwright" {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const chromium: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const firefox: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export const webkit: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const playwright: any;
    export default playwright;
}

declare module "cron-parser" {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    export function parseExpression(expr: string, opts?: { currentDate?: Date }): any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cronParser: any;
    export default cronParser;
}

declare module "agent-client-protocol" {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const acp: any;
    export default acp;
}
