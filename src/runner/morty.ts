import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface MortyReady {
    url: string;
    accessExpiresAt?: string;
}

export class MortySetupError extends Error {
    /** Morty's machine-readable error code, e.g. PROJECT_REPLACEMENT_REQUIRED. */
    readonly code: string | null;
    constructor(message: string, code: string | null) {
        super(message);
        this.code = code;
    }
}

interface SetupEvent {
    status?: string;
    url?: string;
    accessExpiresAt?: string;
    error?: { code?: string };
}

const REDACTED = /#code=\S+|sk-ant-\S+/gu;

/** Runs `morty setup`, which connects this machine to Morty, and resolves with the continue link once it is ready. */
export function setupMorty(options: { cli: string; workspace: string; sessionId: string; claudeToken: string }): Promise<MortyReady> {
    return new Promise((resolve, reject) => {
        const args = [
            "--yes", options.cli, "setup", "--base-url", "https://morty.build", "--cwd", options.workspace,
            "--harness", "claude", "--session-id", options.sessionId, "--device-access", "1d",
        ];
        const child = spawn("npx", args, {
            cwd: options.workspace,
            env: { ...process.env, CLAUDE_CODE_OAUTH_TOKEN: options.claudeToken, NO_BROWSER: "1" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let ready: SetupEvent | null = null;
        let errorCode: string | null = null;
        const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
        createInterface({ input: child.stdout }).on("line", (line) => {
            if (!line.trim().startsWith("{")) return;
            try {
                const event = JSON.parse(line) as SetupEvent;
                if (event.status === "ready") ready = event;
                if (typeof event.error?.code === "string") errorCode = event.error.code;
                console.log(`morty setup: ${event.status}${event.error?.code ? ` (${event.error.code})` : ""}`);
            } catch {
                // Not a setup event.
            }
        });
        child.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(REDACTED, "<redacted>")));
        child.on("close", (code) => {
            clearTimeout(timer);
            const event = ready as SetupEvent | null;
            if (event?.url !== undefined) resolve({ url: event.url, accessExpiresAt: event.accessExpiresAt });
            else reject(new MortySetupError(`morty setup exited with ${code} before ready${errorCode ? ` (${errorCode})` : ""}`, errorCode));
        });
    });
}
