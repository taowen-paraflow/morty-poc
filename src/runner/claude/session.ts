import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../redact.ts";
import { runCommand } from "../process.ts";

const projectsDirectory = (): string => path.join(os.homedir(), ".claude", "projects");

/** Whether Claude Code still has the transcript of this session, i.e. it can be continued. */
export function sessionExists(sessionId: string): boolean {
    const projects = projectsDirectory();
    if (!/^[0-9a-f-]{36}$/u.test(sessionId) || !fs.existsSync(projects)) return false;
    return fs.readdirSync(projects).some((directory) => fs.existsSync(path.join(projects, directory, `${sessionId}.jsonl`)));
}

/** A first prompt proves Claude Code runs and creates the session Morty continues. */
export async function startClaudeSession(workspace: string, token: string): Promise<string> {
    const result = await runCommand("claude", ["-p", "Reply with exactly: MORTY_POC_READY", "--output-format", "json"], {
        cwd: workspace,
        env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: token },
        timeoutMs: 240_000,
    });
    let parsed: { session_id?: unknown; is_error?: boolean; result?: string } | null = null;
    try {
        parsed = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "");
    } catch {
        // Reported below.
    }
    if (result.code === 0 && typeof parsed?.session_id === "string" && !parsed.is_error) return parsed.session_id;
    const said = parsed?.result ?? (result.stderr.trim() || result.stdout.trim()).slice(-300);
    throw new Error(`Claude Code exited with ${result.code ?? "a timeout"}: ${redact(said || "no output")}`);
}

/** Modification time (ms) of the newest conversation transcript; 0 when there is none. */
export function latestTranscriptActivity(): number {
    let newest = 0;
    const walk = (directory: string): void => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith(".jsonl")) newest = Math.max(newest, fs.statSync(file).mtimeMs);
        }
    };
    walk(projectsDirectory());
    return newest;
}
