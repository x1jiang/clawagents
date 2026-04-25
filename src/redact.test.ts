/**
 * Tests for the display-layer redaction module.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    addPattern,
    isSecretName,
    redact,
    redactEnv,
    redactObj,
    resetPatterns,
} from "./redact.js";

describe("redact", () => {
    let originalEnv: string | undefined;

    beforeEach(() => {
        originalEnv = process.env["CLAW_REDACT"];
        delete process.env["CLAW_REDACT"];
    });

    afterEach(() => {
        if (originalEnv === undefined) delete process.env["CLAW_REDACT"];
        else process.env["CLAW_REDACT"] = originalEnv;
        resetPatterns();
    });

    it("redacts an OpenAI key", () => {
        const raw = "Bearer sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
        const out = redact(raw);
        assert.ok(!out.includes("sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"));
        assert.ok(out.includes("[REDACTED:OPENAI_KEY]") || out.includes("[REDACTED:BEARER]"));
    });

    it("redacts an Anthropic key", () => {
        const raw = "key=sk-ant-api03-thisis_a_long_key_value_1234567890";
        const out = redact(raw);
        assert.ok(!out.includes("sk-ant-api03"));
    });

    it("redacts a Google AI key", () => {
        const key = "AIzaSyAa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6"; // AIza + 35 chars
        const raw = `config: ${key}`;
        const out = redact(raw);
        assert.ok(!out.includes(key));
        assert.ok(out.includes("[REDACTED:GOOGLE_KEY]"));
    });

    it("redacts a GitHub PAT", () => {
        const raw = "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD";
        assert.ok(!redact(raw).includes("ghp_"));
    });

    it("redacts AWS access keys but keeps surrounding text", () => {
        const raw = "Hello AKIAIOSFODNN7EXAMPLE world";
        const out = redact(raw);
        assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"));
        assert.ok(out.startsWith("Hello "));
        assert.ok(out.endsWith(" world"));
    });

    it("redacts a 3-segment JWT", () => {
        const raw =
            "Cookie: jwt=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0." +
            "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
        assert.ok(!redact(raw).includes("eyJhbGciOiJIUzI1NiJ9"));
    });

    it("redacts generic api_key= assignments", () => {
        const raw = 'api_key="abcd1234efgh5678"';
        const out = redact(raw);
        assert.ok(!out.includes("abcd1234efgh5678"));
    });

    it("passes safe text through unchanged", () => {
        const raw = "Just a regular string with no secrets.";
        assert.equal(redact(raw), raw);
    });

    it("does not match short identifiers", () => {
        const raw = "user=alice id=42";
        assert.equal(redact(raw), raw);
    });

    it("recurses through dicts and lists", () => {
        const obj = {
            ok: "hello",
            leaked: "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
            nested: [
                { inner: "AIzaSyAa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6" },
                "plain text",
            ],
        };
        const out = redactObj(obj) as typeof obj;
        assert.equal(out.ok, "hello");
        assert.ok(out.leaked.includes("[REDACTED"));
        assert.ok((out.nested[0] as { inner: string }).inner.includes("[REDACTED"));
        assert.equal(out.nested[1], "plain text");
    });

    it("masks secret-named env keys regardless of value shape", () => {
        const env: Record<string, string | undefined> = {
            OPENAI_API_KEY: "sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxx",
            USER: "alice",
            DB_PASSWORD: "super_secret_pw",
            PATH: "/usr/bin",
        };
        const out = redactEnv(env);
        assert.equal(out["OPENAI_API_KEY"], "[REDACTED]");
        assert.equal(out["DB_PASSWORD"], "[REDACTED]");
        assert.equal(out["USER"], "alice");
        assert.equal(out["PATH"], "/usr/bin");
    });

    it("picks up user-registered patterns", () => {
        addPattern("INTERNAL", "INTERNAL-[A-Z0-9]{12}");
        const out = redact("token=INTERNAL-AB12CD34EF56 trailing");
        assert.ok(!out.includes("INTERNAL-AB12CD34EF56"));
        assert.ok(out.includes("[REDACTED:INTERNAL]"));
    });

    it("can be disabled via env", () => {
        process.env["CLAW_REDACT"] = "0";
        const raw = "key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
        assert.equal(redact(raw), raw);
    });

    it("warn mode leaves text untouched", () => {
        process.env["CLAW_REDACT"] = "warn";
        const raw = "key=sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
        assert.equal(redact(raw), raw);
    });

    it("label:false uses a fixed marker", () => {
        const raw = "AIzaSyAa1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6";
        const out = redact(raw, { label: false });
        assert.ok(out.includes("[REDACTED]"));
        assert.ok(!out.includes("[REDACTED:"));
    });

    it("isSecretName classifies key-shaped names", () => {
        assert.ok(isSecretName("OPENAI_API_KEY"));
        assert.ok(isSecretName("db_password"));
        assert.ok(isSecretName("sessionToken"));
        assert.ok(!isSecretName("USER"));
        assert.ok(!isSecretName("PATH"));
        assert.ok(!isSecretName(""));
    });
});
