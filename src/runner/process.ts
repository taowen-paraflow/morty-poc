import { spawn } from "node:child_process";

export interface CommandResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/** Runs a command to completion; it is killed (SIGTERM) after `timeoutMs`. */
export function runCommand(
    command: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}
