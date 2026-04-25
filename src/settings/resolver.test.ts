/**
 * Tests for the settings hierarchy resolver.
 * Mirrors `clawagents_py/tests/test_settings_resolver.py`.
 *
 * Run with: npx tsx --test src/settings/resolver.test.ts
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
    SettingsLayer,
    resolveSettings,
    getSetting,
    findRepoRoot,
    POLICY_SETTINGS_PATH_ENV,
} from "./index.js";

interface FakeEnv {
    home: string;
    repo: string;
    policy: string;
    userSettings: string;
    projectSettings: string;
    localSettings: string;
    cleanup: () => void;
}

function buildFakeEnv(): FakeEnv {
    const root = mkdtempSync(join(tmpdir(), "clawagents-settings-"));
    const home = join(root, "home");
    const repo = join(root, "repo");
    const policy = join(root, "policy.json");
    mkdirSync(join(home, ".clawagents"), { recursive: true });
    mkdirSync(join(repo, ".clawagents"), { recursive: true });
    // Make the repo look like one.
    writeFileSync(join(repo, "package.json"), '{"name":"x"}');

    const prevHome = process.env["HOME"];
    const prevUserprofile = process.env["USERPROFILE"];
    const prevPolicy = process.env[POLICY_SETTINGS_PATH_ENV];
    process.env["HOME"] = home;
    process.env["USERPROFILE"] = home;
    process.env[POLICY_SETTINGS_PATH_ENV] = policy;

    return {
        home,
        repo,
        policy,
        userSettings: join(home, ".clawagents", "settings.json"),
        projectSettings: join(repo, ".clawagents", "settings.json"),
        localSettings: join(repo, ".clawagents", "settings.local.json"),
        cleanup: () => {
            if (prevHome === undefined) delete process.env["HOME"];
            else process.env["HOME"] = prevHome;
            if (prevUserprofile === undefined) delete process.env["USERPROFILE"];
            else process.env["USERPROFILE"] = prevUserprofile;
            if (prevPolicy === undefined) delete process.env[POLICY_SETTINGS_PATH_ENV];
            else process.env[POLICY_SETTINGS_PATH_ENV] = prevPolicy;
            rmSync(root, { recursive: true, force: true });
        },
    };
}

function writeJson(path: string, data: unknown): void {
    writeFileSync(path, JSON.stringify(data));
}

// ─── SettingsLayer enum ─────────────────────────────────────────────

describe("SettingsLayer enum", () => {
    it("has the expected values", () => {
        assert.equal(SettingsLayer.USER, "user");
        assert.equal(SettingsLayer.PROJECT, "project");
        assert.equal(SettingsLayer.LOCAL, "local");
        assert.equal(SettingsLayer.FLAG, "flag");
        assert.equal(SettingsLayer.POLICY, "policy");
    });
});

// ─── findRepoRoot ───────────────────────────────────────────────────

describe("findRepoRoot", () => {
    it("walks up to a package.json marker", () => {
        const root = mkdtempSync(join(tmpdir(), "clawagents-find-"));
        try {
            const repo = join(root, "r");
            mkdirSync(repo);
            writeFileSync(join(repo, "package.json"), "{}");
            const nested = join(repo, "a", "b", "c");
            mkdirSync(nested, { recursive: true });
            assert.equal(findRepoRoot(nested), repo);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("falls back to the start path if no marker is found", () => {
        const root = mkdtempSync(join(tmpdir(), "clawagents-find-"));
        try {
            const nested = join(root, "no", "marker");
            mkdirSync(nested, { recursive: true });
            assert.equal(findRepoRoot(nested), nested);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("finds a .git directory", () => {
        const root = mkdtempSync(join(tmpdir(), "clawagents-find-"));
        try {
            const repo = join(root, "g");
            mkdirSync(join(repo, ".git"), { recursive: true });
            const nested = join(repo, "x");
            mkdirSync(nested);
            assert.equal(findRepoRoot(nested), repo);
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});

// ─── Layer-merge cases ──────────────────────────────────────────────

describe("resolveSettings layer merge", () => {
    let env: FakeEnv;
    beforeEach(() => {
        env = buildFakeEnv();
    });
    afterEach(() => env.cleanup());

    it("only-user layer", () => {
        writeJson(env.userSettings, { theme: "dark", maxTurns: 5 });
        const out = resolveSettings({ repoRoot: env.repo });
        assert.deepEqual(out, { theme: "dark", maxTurns: 5 });
    });

    it("user + project deep-merges", () => {
        writeJson(env.userSettings, {
            theme: "dark",
            hooks: { beforeTool: ["log"] },
        });
        writeJson(env.projectSettings, {
            hooks: { afterTool: ["audit"] },
            maxTurns: 7,
        });
        const out = resolveSettings({ repoRoot: env.repo });
        assert.deepEqual(out, {
            theme: "dark",
            maxTurns: 7,
            hooks: { beforeTool: ["log"], afterTool: ["audit"] },
        });
    });

    it("local overrides project and user", () => {
        writeJson(env.userSettings, { theme: "dark" });
        writeJson(env.projectSettings, { theme: "light", lang: "en" });
        writeJson(env.localSettings, { theme: "solarized" });
        const out = resolveSettings({ repoRoot: env.repo });
        assert.equal(out["theme"], "solarized");
        assert.equal(out["lang"], "en");
    });

    it("flag overrides lower layers", () => {
        writeJson(env.userSettings, { theme: "dark", maxTurns: 5 });
        writeJson(env.projectSettings, { maxTurns: 7 });
        writeJson(env.localSettings, { maxTurns: 10 });
        const out = resolveSettings({
            repoRoot: env.repo,
            flagOverrides: { maxTurns: 99, extra: true },
        });
        assert.equal(out["maxTurns"], 99);
        assert.equal(out["extra"], true);
        assert.equal(out["theme"], "dark");
    });

    it("policy ALWAYS wins, even over flags", () => {
        writeJson(env.userSettings, { theme: "dark", maxTurns: 5 });
        writeJson(env.projectSettings, { maxTurns: 7 });
        writeJson(env.localSettings, { maxTurns: 10 });
        writeJson(env.policy, { maxTurns: 1, policyLocked: true });
        const out = resolveSettings({
            repoRoot: env.repo,
            flagOverrides: { maxTurns: 99 },
        });
        assert.equal(out["maxTurns"], 1);
        assert.equal(out["policyLocked"], true);
        assert.equal(out["theme"], "dark");
    });

    it("policy deep-merges nested keys", () => {
        writeJson(env.userSettings, {
            hooks: { beforeTool: ["log"], afterTool: ["audit"] },
        });
        writeJson(env.policy, { hooks: { afterTool: ["forced-audit"] } });
        const out = resolveSettings({ repoRoot: env.repo });
        const hooks = out["hooks"] as Record<string, unknown>;
        assert.deepEqual(hooks["beforeTool"], ["log"]);
        assert.deepEqual(hooks["afterTool"], ["forced-audit"]);
    });
});

// ─── Graceful failures ──────────────────────────────────────────────

describe("resolveSettings graceful failures", () => {
    let env: FakeEnv;
    beforeEach(() => {
        env = buildFakeEnv();
    });
    afterEach(() => env.cleanup());

    it("missing files yield empty layers — no exceptions", () => {
        const out = resolveSettings({ repoRoot: env.repo });
        assert.deepEqual(out, {});
    });

    it("malformed JSON is skipped", () => {
        writeFileSync(env.projectSettings, "{not valid json");
        writeJson(env.userSettings, { theme: "dark" });
        // Silence the warn during the test.
        const origWarn = console.warn;
        console.warn = () => {};
        try {
            const out = resolveSettings({ repoRoot: env.repo });
            assert.deepEqual(out, { theme: "dark" });
        } finally {
            console.warn = origWarn;
        }
    });

    it("non-object JSON is skipped", () => {
        writeFileSync(env.projectSettings, "[1,2,3]");
        writeJson(env.userSettings, { theme: "dark" });
        const origWarn = console.warn;
        console.warn = () => {};
        try {
            const out = resolveSettings({ repoRoot: env.repo });
            assert.deepEqual(out, { theme: "dark" });
        } finally {
            console.warn = origWarn;
        }
    });
});

// ─── getSetting ─────────────────────────────────────────────────────

describe("getSetting", () => {
    let env: FakeEnv;
    beforeEach(() => {
        env = buildFakeEnv();
    });
    afterEach(() => env.cleanup());

    it("reads top-level keys", () => {
        writeJson(env.userSettings, { theme: "dark" });
        assert.equal(getSetting("theme", undefined, { repoRoot: env.repo }), "dark");
    });

    it("reads nested dotted paths", () => {
        writeJson(env.userSettings, { hooks: { beforeTool: ["a", "b"] } });
        assert.deepEqual(
            getSetting("hooks.beforeTool", undefined, { repoRoot: env.repo }),
            ["a", "b"],
        );
    });

    it("returns the default when a segment is missing", () => {
        writeJson(env.userSettings, { a: { b: 1 } });
        assert.equal(getSetting("a.c", undefined, { repoRoot: env.repo }), undefined);
        assert.equal(getSetting("a.c", "fallback", { repoRoot: env.repo }), "fallback");
        assert.equal(
            getSetting("missing.path", undefined, { repoRoot: env.repo }),
            undefined,
        );
    });

    it("returns the default when descending into a non-object", () => {
        writeJson(env.userSettings, { a: "scalar" });
        assert.equal(getSetting("a.b", 42, { repoRoot: env.repo }), 42);
    });

    it("supports a pre-resolved settings object (no fs reads)", () => {
        const settings = { x: { y: { z: 99 } } };
        assert.equal(getSetting("x.y.z", undefined, { settings }), 99);
        assert.equal(getSetting("x.y.missing", 7, { settings }), 7);
    });

    it("honours flagOverrides", () => {
        writeJson(env.userSettings, { theme: "dark" });
        const v = getSetting("theme", undefined, {
            repoRoot: env.repo,
            flagOverrides: { theme: "light" },
        });
        assert.equal(v, "light");
    });
});
