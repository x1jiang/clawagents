/**
 * Tests for ``scrubEnvForStdio`` — the MCP child-process env sanitiser.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { scrubEnvForStdio } from "./server.js";

const parentEnv: Record<string, string> = {
    // Safe / required for the child
    PATH: "/usr/bin:/bin",
    HOME: "/Users/alice",
    USER: "alice",
    LOGNAME: "alice",
    SHELL: "/bin/bash",
    TERM: "xterm-256color",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TZ: "America/Chicago",
    TMPDIR: "/var/folders/xy",
    PWD: "/Users/alice/work",
    // Definitely-secret names
    OPENAI_API_KEY: "sk-proj-xxx",
    ANTHROPIC_API_KEY: "sk-ant-xxx",
    GOOGLE_API_KEY: "AIza...",
    AWS_ACCESS_KEY_ID: "AKIAxxxx",
    AWS_SECRET_ACCESS_KEY: "wJalrxxx",
    GITHUB_TOKEN: "ghp_xxx",
    DB_PASSWORD: "hunter2",
    // Random non-secret operational vars
    EDITOR: "vim",
    PAGER: "less",
};

describe("scrubEnvForStdio", () => {
    it("drops secret-shaped keys by default", () => {
        const out = scrubEnvForStdio(undefined, { parentEnv });
        assert.ok(!("OPENAI_API_KEY" in out));
        assert.ok(!("ANTHROPIC_API_KEY" in out));
        assert.ok(!("GITHUB_TOKEN" in out));
        assert.ok(!("DB_PASSWORD" in out));
        assert.ok(!("AWS_ACCESS_KEY_ID" in out));
    });

    it("keeps safe passthrough keys (PATH/HOME/USER/...)", () => {
        const out = scrubEnvForStdio(undefined, { parentEnv });
        for (const k of [
            "PATH",
            "HOME",
            "USER",
            "LOGNAME",
            "SHELL",
            "TERM",
            "LANG",
            "LC_ALL",
            "TZ",
            "TMPDIR",
            "PWD",
        ]) {
            assert.equal(out[k], parentEnv[k]);
        }
    });

    it("drops unknown non-secret operational vars", () => {
        const out = scrubEnvForStdio(undefined, { parentEnv });
        assert.ok(!("EDITOR" in out));
        assert.ok(!("PAGER" in out));
    });

    it("user env overrides safe passthrough", () => {
        const out = scrubEnvForStdio(
            { PATH: "/sandbox/bin", MY_VAR: "value" },
            { parentEnv },
        );
        assert.equal(out["PATH"], "/sandbox/bin");
        assert.equal(out["MY_VAR"], "value");
    });

    it("allowlist inherits specific keys", () => {
        const out = scrubEnvForStdio(undefined, {
            allowlist: ["GITHUB_TOKEN"],
            parentEnv,
        });
        assert.equal(out["GITHUB_TOKEN"], "ghp_xxx");
        assert.ok(!("OPENAI_API_KEY" in out));
    });

    it("allowlist silently skips missing keys", () => {
        const out = scrubEnvForStdio(undefined, {
            allowlist: ["DOES_NOT_EXIST"],
            parentEnv,
        });
        assert.ok(!("DOES_NOT_EXIST" in out));
    });

    it("inheritSafe:false drops everything not user-supplied", () => {
        const out = scrubEnvForStdio(
            { FOO: "bar" },
            { inheritSafe: false, parentEnv },
        );
        assert.deepEqual(out, { FOO: "bar" });
    });

    it("user can reintroduce a secret deliberately", () => {
        const out = scrubEnvForStdio(
            { OPENAI_API_KEY: "sk-deliberate" },
            { parentEnv },
        );
        assert.equal(out["OPENAI_API_KEY"], "sk-deliberate");
    });

    it("LC_* prefix keys pass through", () => {
        const env = { ...parentEnv, LC_TIME: "en_US.UTF-8", LC_NUMERIC: "en_US.UTF-8" };
        const out = scrubEnvForStdio(undefined, { parentEnv: env });
        assert.equal(out["LC_TIME"], "en_US.UTF-8");
        assert.equal(out["LC_NUMERIC"], "en_US.UTF-8");
    });

    it("uses process.env when parentEnv is omitted", () => {
        const before = process.env["CLAW_TEST_OK"];
        try {
            process.env["CLAW_TEST_OK"] = "x";
            process.env["PATH"] = process.env["PATH"] ?? "/usr/bin";
            const out = scrubEnvForStdio(undefined);
            // PATH always present; secret-named keys never present.
            assert.ok("PATH" in out);
        } finally {
            if (before === undefined) delete process.env["CLAW_TEST_OK"];
            else process.env["CLAW_TEST_OK"] = before;
        }
    });
});
