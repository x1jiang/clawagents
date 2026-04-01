/**
 * Granular tool permission rules (learned from Claude Code: useCanUseTool).
 *
 * Provides a declarative permission system that wraps the existing beforeTool hook
 * with Allow/Deny/Ask rules based on tool name, argument patterns, and file paths.
 *
 * Usage:
 *   import { PermissionEngine } from "./tools/permissions.js";
 *
 *   const engine = new PermissionEngine();
 *   engine.addRule({ tool: "execute*", decision: "deny" });
 *   engine.addRule({ tool: "write_file", pathPattern: "*.py", decision: "allow" });
 *
 *   // Use as beforeTool hook:
 *   runAgentGraph({ ..., beforeTool: (name, args) => engine.check(name, args) })
 */

// Minimal glob matching (supports * and ? wildcards)
function globMatch(pattern: string, text: string): boolean {
    if (pattern === "*") return true;
    const regex = new RegExp(
        "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*")
            .replace(/\?/g, ".") + "$",
    );
    return regex.test(text);
}

export interface PermissionRule {
    tool: string;
    pathPattern?: string;
    argPattern?: string;
    decision: "allow" | "deny" | "ask";
    message?: string;
    priority?: number;
}

export class PermissionEngine {
    private rules: Array<Required<PermissionRule>> = [];
    private defaultDecision: "allow" | "deny" | "ask";
    private sorted = false;

    constructor(defaultDecision: "allow" | "deny" | "ask" = "allow") {
        this.defaultDecision = defaultDecision;
    }

    addRule(rule: PermissionRule): this {
        this.rules.push({
            tool: rule.tool,
            pathPattern: rule.pathPattern ?? "*",
            argPattern: rule.argPattern ?? "*",
            decision: rule.decision,
            message: rule.message ?? "",
            priority: rule.priority ?? 0,
        });
        this.sorted = false;
        return this;
    }

    addRules(rules: PermissionRule[]): this {
        for (const r of rules) this.addRule(r);
        return this;
    }

    private ensureSorted(): void {
        if (!this.sorted) {
            this.rules.sort((a, b) => b.priority - a.priority);
            this.sorted = true;
        }
    }

    private extractPath(args: Record<string, unknown>): string {
        return String(args.path || args.file_path || args.target_path || "");
    }

    evaluate(toolName: string, args: Record<string, unknown>): { decision: string; message: string } {
        this.ensureSorted();

        const filePath = this.extractPath(args);

        for (const rule of this.rules) {
            if (!globMatch(rule.tool, toolName)) continue;
            if (rule.pathPattern !== "*" && filePath && !globMatch(rule.pathPattern, filePath)) continue;
            if (rule.argPattern !== "*" && !globMatch(rule.argPattern, JSON.stringify(args))) continue;
            return { decision: rule.decision, message: rule.message };
        }

        return { decision: this.defaultDecision, message: "" };
    }

    /** Check if a tool call is allowed. Compatible with the beforeTool hook signature. */
    check(toolName: string, args: Record<string, unknown>): boolean {
        const { decision } = this.evaluate(toolName, args);
        return decision === "allow";
    }

    /** Create a PermissionEngine from a list of rule objects (e.g., from JSON config). */
    static fromConfig(rulesData: PermissionRule[]): PermissionEngine {
        const engine = new PermissionEngine();
        engine.addRules(rulesData);
        return engine;
    }
}
