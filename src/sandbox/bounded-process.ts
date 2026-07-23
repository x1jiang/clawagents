import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { BoundedTextAccumulator } from "../utils/bounded-output.js";
import type { ExecOptions, ExecResult } from "./backend.js";

const DEFAULT_MAX_OUTPUT_CHARS = 40_000;

export function runBoundedProcess(
    executable: string,
    args: string[],
    options: ExecOptions & {
        shell?: boolean;
        defaultCwd: string;
        baseEnv?: Record<string, string>;
    },
): Promise<ExecResult> {
    const maxOutputChars = options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS;
    const stdout = new BoundedTextAccumulator(maxOutputChars);
    const stderr = new BoundedTextAccumulator(maxOutputChars);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");

    return new Promise((resolve) => {
        const child = spawn(executable, args, {
            cwd: options.cwd ?? options.defaultCwd,
            env: { ...options.baseEnv, ...options.env },
            shell: options.shell ?? false,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let spawnError: Error | undefined;
        let settled = false;

        const append = (stream: "stdout" | "stderr", chunk: string): void => {
            if (!chunk) return;
            (stream === "stdout" ? stdout : stderr).append(chunk);
            try { options.onOutput?.(stream, chunk); } catch { /* observer isolation */ }
        };

        child.stdout?.on("data", (chunk: Buffer) => append("stdout", stdoutDecoder.write(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => append("stderr", stderrDecoder.write(chunk)));
        child.on("error", (error) => { spawnError = error; });

        const timeoutMs = options.timeout ?? 30_000;
        const timeout = timeoutMs > 0
            ? setTimeout(() => {
                  timedOut = true;
                  child.kill("SIGTERM");
                  const forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
                  forceKill.unref();
              }, timeoutMs)
            : undefined;
        timeout?.unref();

        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            append("stdout", stdoutDecoder.end());
            append("stderr", stderrDecoder.end());
            if (spawnError && stderr.totalChars === 0) stderr.append(spawnError.message);
            resolve({
                stdout: stdout.toString(),
                stderr: stderr.toString(),
                exitCode: typeof code === "number" ? code : 1,
                ...(timedOut ? { killed: true } : {}),
            });
        });
    });
}
