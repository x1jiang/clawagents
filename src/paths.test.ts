/**
 * Tests for clawagents/paths.ts.
 *
 * Mirrors `clawagents_py/tests/test_paths.py`.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
    DEFAULT_PROFILE,
    HOME_DIRNAME,
    WORKSPACE_DIRNAME,
    displayClawagentsHome,
    displayClawagentsWorkspaceDir,
    getClawagentsHome,
    getClawagentsWorkspaceDir,
    getLessonsDir,
    getSessionsDir,
    getTrajectoriesDir,
    listProfiles,
} from "./paths.js";

const ENV_KEYS = ["CLAWAGENTS_HOME", "CLAWAGENTS_PROFILE", "CLAWAGENTS_WORKSPACE"] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
let savedCwd: string;
let tmpRoot: string;

beforeEach(() => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    savedCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "clawpaths-"));
});

afterEach(() => {
    process.chdir(savedCwd);
    for (const k of ENV_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("getClawagentsHome", () => {
    it("defaults to ~/.clawagents/default", () => {
        const home = getClawagentsHome();
        assert.equal(home, path.join(os.homedir(), HOME_DIRNAME, DEFAULT_PROFILE));
    });

    it("respects an explicit profile", () => {
        const home = getClawagentsHome({ profile: "work" });
        assert.equal(path.basename(home), "work");
        assert.equal(path.dirname(home), path.join(os.homedir(), HOME_DIRNAME));
    });

    it("respects CLAWAGENTS_PROFILE", () => {
        process.env.CLAWAGENTS_PROFILE = "personal";
        const home = getClawagentsHome();
        assert.equal(path.basename(home), "personal");
    });

    it("respects CLAWAGENTS_HOME (not yet ending in profile)", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "sandbox");
        const home = getClawagentsHome({ profile: "work" });
        assert.equal(home, path.join(tmpRoot, "sandbox", "work"));
    });

    it("does not double-suffix CLAWAGENTS_HOME if it already ends with the profile", () => {
        const sandbox = path.join(tmpRoot, "sandbox", "work");
        process.env.CLAWAGENTS_HOME = sandbox;
        const home = getClawagentsHome({ profile: "work" });
        assert.equal(home, sandbox);
    });

    it("create=true mkdirs the path", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "h");
        const home = getClawagentsHome({ profile: "p", create: true });
        assert.ok(fs.existsSync(home));
        assert.ok(fs.statSync(home).isDirectory());
    });
});

describe("getClawagentsWorkspaceDir", () => {
    it("defaults to <cwd>/.clawagents", () => {
        process.chdir(tmpRoot);
        const ws = getClawagentsWorkspaceDir();
        // Resolve symlinks (macOS /var → /private/var) before comparing.
        assert.equal(fs.realpathSync(path.dirname(ws)), fs.realpathSync(tmpRoot));
        assert.equal(path.basename(ws), WORKSPACE_DIRNAME);
    });

    it("respects CLAWAGENTS_WORKSPACE", () => {
        const proj = path.join(tmpRoot, "proj");
        fs.mkdirSync(proj);
        process.env.CLAWAGENTS_WORKSPACE = proj;
        const ws = getClawagentsWorkspaceDir();
        assert.equal(ws, path.join(proj, WORKSPACE_DIRNAME));
    });

    it("create=true mkdirs the path", () => {
        process.env.CLAWAGENTS_WORKSPACE = tmpRoot;
        const ws = getClawagentsWorkspaceDir({ create: true });
        assert.ok(fs.existsSync(ws));
    });
});

describe("scoped helpers", () => {
    it("getTrajectoriesDir(scope='workspace') uses workspace", () => {
        process.env.CLAWAGENTS_WORKSPACE = tmpRoot;
        const out = getTrajectoriesDir({ scope: "workspace" });
        assert.equal(out, path.join(tmpRoot, WORKSPACE_DIRNAME, "trajectories"));
    });

    it("getTrajectoriesDir(scope='home') uses home + profile", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "h");
        const out = getTrajectoriesDir({ scope: "home", profile: "dev" });
        assert.equal(out, path.join(tmpRoot, "h", "dev", "trajectories"));
    });

    it("getSessionsDir(scope='home') uses home + profile", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "h");
        const out = getSessionsDir({ scope: "home", profile: "dev" });
        assert.equal(out, path.join(tmpRoot, "h", "dev", "sessions"));
    });

    it("getLessonsDir defaults to home scope", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "h");
        process.chdir(tmpRoot);
        const out = getLessonsDir();
        assert.ok(out.startsWith(path.join(tmpRoot, "h")));
        assert.equal(path.basename(out), "lessons");
    });

    it("rejects unknown scope", () => {
        // @ts-expect-error -- intentional bad scope
        assert.throws(() => getTrajectoriesDir({ scope: "bogus" }));
        // @ts-expect-error -- intentional bad scope
        assert.throws(() => getSessionsDir({ scope: "bogus" }));
        // @ts-expect-error -- intentional bad scope
        assert.throws(() => getLessonsDir({ scope: "bogus" }));
    });

    it("create=true cascades to scoped dirs", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "h");
        const t = getTrajectoriesDir({ scope: "home", profile: "dev", create: true });
        assert.ok(fs.existsSync(t));
        const s = getSessionsDir({ scope: "home", profile: "dev", create: true });
        assert.ok(fs.existsSync(s));
    });
});

describe("displayClawagentsHome / displayClawagentsWorkspaceDir", () => {
    it("renders default home as ~/.clawagents/default", () => {
        const out = displayClawagentsHome();
        assert.equal(out, `~/${HOME_DIRNAME}/${DEFAULT_PROFILE}`);
    });

    it("renders an explicit profile under ~", () => {
        const out = displayClawagentsHome("work");
        assert.equal(out, `~/${HOME_DIRNAME}/work`);
    });

    it("falls back to absolute path when CLAWAGENTS_HOME is outside $HOME", () => {
        const sandbox = path.join(tmpRoot, "external");
        process.env.CLAWAGENTS_HOME = sandbox;
        const out = displayClawagentsHome("work");
        assert.equal(out, path.join(sandbox, "work"));
        assert.ok(!out.startsWith("~"));
    });

    it("renders CLAWAGENTS_HOME inside $HOME with ~ prefix", () => {
        const inner = path.join(os.homedir(), "alt-claw");
        process.env.CLAWAGENTS_HOME = inner;
        const out = displayClawagentsHome("p");
        assert.equal(out, "~/alt-claw/p");
    });

    it("renders workspace inside $HOME with ~ prefix", () => {
        const proj = path.join(os.homedir(), `claw-proj-${process.pid}`);
        fs.mkdirSync(proj, { recursive: true });
        try {
            process.env.CLAWAGENTS_WORKSPACE = proj;
            const out = displayClawagentsWorkspaceDir();
            assert.equal(out, `~/claw-proj-${process.pid}/${WORKSPACE_DIRNAME}`);
        } finally {
            fs.rmSync(proj, { recursive: true, force: true });
        }
    });

    it("falls back to absolute path for workspace outside $HOME", () => {
        const proj = path.join(tmpRoot, "proj");
        fs.mkdirSync(proj);
        process.env.CLAWAGENTS_WORKSPACE = proj;
        const out = displayClawagentsWorkspaceDir();
        assert.equal(out, path.join(proj, WORKSPACE_DIRNAME));
        assert.ok(!out.startsWith("~"));
    });
});

describe("listProfiles", () => {
    it("returns [] when home parent does not exist", () => {
        process.env.CLAWAGENTS_HOME = path.join(tmpRoot, "missing");
        assert.deepEqual(listProfiles(), []);
    });

    it("returns sorted profile names, filtering hidden + non-dirs", () => {
        const home = path.join(tmpRoot, "h");
        process.env.CLAWAGENTS_HOME = home;
        for (const n of ["work", "default", "personal"]) {
            fs.mkdirSync(path.join(home, n), { recursive: true });
        }
        fs.mkdirSync(path.join(home, ".hidden"));
        fs.writeFileSync(path.join(home, "junk.txt"), "nope");
        assert.deepEqual(listProfiles(), ["default", "personal", "work"]);
    });
});
