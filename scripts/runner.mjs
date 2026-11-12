// Runs inside the GitHub Actions job. It talks to the launcher page through comments on a per-run issue:
//   1. posts its public key,
//   2. receives a saved Claude token, or drives `claude setup-token` with the page (sign-in link out, code in),
//   3. starts a Claude Code session, connects this runner to Morty, and returns the encrypted continue link,
//   4. stays up until the conversation is idle, the time limit passes, or the run is cancelled.
// Secrets are never printed. Only messages from the user who dispatched the run are accepted.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { decryptWith, encryptFor, formatMessage, importPublicKey, parseMessage } from "./runner-crypto.mjs";

const env = process.env;
const requestId = env.REQUEST_ID ?? "";
const idleMinutes = Number(env.IDLE_MINUTES ?? "30");
const maxMinutes = Number(env.MAX_MINUTES ?? "340");
const actor = env.GITHUB_ACTOR ?? "";
const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
const started = Date.now();
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

if (!/^r-[0-9a-f]{24}$/u.test(requestId)) throw new Error("request_id is invalid.");
if (!Number.isFinite(idleMinutes) || idleMinutes < 5 || idleMinutes > 300) throw new Error("idle_minutes must be 5-300.");
const pagePublicKey = importPublicKey(env.PUBLIC_KEY ?? "");
const own = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const encrypt = (value) => encryptFor(pagePublicKey, value);
const decrypt = (payload) => decryptWith(own.privateKey, payload);

// --- GitHub channel ---------------------------------------------------------------------------------------------

async function github(method, route, body) {
    const response = await fetch(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}${route}`, {
        method,
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${env.GITHUB_TOKEN}`,
            "x-github-api-version": "2022-11-28",
            ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${route}: ${response.status} ${await response.text()}`);
    return await response.json();
}

const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
const issue = await github("POST", "/issues", {
    title: `morty-run ${requestId}`,
    body: `Message channel for [run ${env.GITHUB_RUN_ID}](${runUrl}). Secrets in it are encrypted; the run closes this issue when it ends.`,
});
fs.writeFileSync("/tmp/morty-poc-issue", String(issue.number));

async function send(type, payload, note) {
    await github("POST", `/issues/${issue.number}/comments`, {
        body: formatMessage({ type, request: requestId, from: "runner" }, payload, note),
    });
}

const seen = new Set();
/** Waits for the next message of one of `types` from the dispatching user. */
async function receive(types, minutes) {
    const deadline = Date.now() + minutes * 60_000;
    while (Date.now() < deadline) {
        const comments = await github("GET", `/issues/${issue.number}/comments?per_page=100`);
        for (const comment of comments) {
            if (seen.has(comment.id)) continue;
            seen.add(comment.id);
            if (comment.user?.login !== actor) continue;
            const message = parseMessage(comment.body);
            if (message?.meta.request === requestId && message.meta.from === "page" && types.includes(message.meta.type)) {
                return { type: message.meta.type, payload: message.payload };
            }
        }
        await sleep(3_000);
    }
    throw new Error(`Timed out waiting for ${types.join(" or ")}.`);
}

async function fail(message) {
    console.error(`::error::${message}`);
    await send("error", { message }, "The runner stopped.").catch(() => {});
    process.exit(1);
}

// --- Claude Code sign-in ----------------------------------------------------------------------------------------

function run(command, args, options = {}) {
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd: workspace, env: options.env ?? env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        const timer = setTimeout(() => child.kill("SIGTERM"), options.timeout ?? 180_000);
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

async function signInToClaude() {
    const child = spawn("python3", [path.join(workspace, "scripts", "claude_login.py")], { env, stdio: ["pipe", "pipe", "inherit"] });
    const lines = createInterface({ input: child.stdout });
    const next = () =>
        new Promise((resolve) => {
            lines.once("line", (line) => resolve(JSON.parse(line)));
            child.once("close", () => resolve({ error: "claude setup-token exited" }));
        });
    const first = await next();
    if (first.error) throw new Error(first.error);
    await send("claude-login", encrypt({ url: first.url }), "Open the Claude sign-in link from the launcher page.");
    console.log("Waiting for the Claude sign-in code…");
    const { payload } = await receive(["claude-code"], 15);
    child.stdin.write(`${JSON.stringify({ code: decrypt(payload).code })}\n`);
    const second = await next();
    if (second.error) throw new Error(second.error);
    return second.token;
}

const redact = (text) => String(text).replace(/sk-ant-[A-Za-z0-9_-]+/gu, "<token>").replace(/#code=\S+/gu, "<code>");

/**
 * Asks the API directly whether the token is accepted, so a bad token fails in seconds with Anthropic's reason
 * instead of Claude Code retrying until a timeout. Only authentication and permission errors reject the token.
 */
async function checkClaudeToken(token) {
    const shape = `${token.slice(0, 13)}… (${token.length} chars)`;
    try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                max_tokens: 1,
                system: "You are Claude Code, Anthropic's official CLI for Claude.",
                messages: [{ role: "user", content: "hi" }],
            }),
            signal: AbortSignal.timeout(30_000),
        });
        const body = await response.json().catch(() => ({}));
        const type = body?.error?.type;
        if (type === "authentication_error" || type === "permission_error") {
            return `Anthropic rejected the token ${shape}: ${redact(body.error.message)}`;
        }
        console.log(`Claude token ${shape} accepted (HTTP ${response.status}${type ? `, ${type}` : ""}).`);
        return null;
    } catch (error) {
        console.log(`Could not pre-check the Claude token: ${redact(error.message ?? error)}`);
        return null;
    }
}

/** A first prompt proves Claude Code runs and creates the session Morty continues. */
async function startClaudeSession(token) {
    const result = await run("claude", ["-p", "Reply with exactly: MORTY_POC_READY", "--output-format", "json"], {
        env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token },
        timeout: 240_000,
    });
    let parsed = null;
    try {
        parsed = JSON.parse(result.stdout.trim().split("\n").at(-1));
    } catch {
        // Reported below.
    }
    if (result.code === 0 && typeof parsed?.session_id === "string" && !parsed.is_error) {
        return { sessionId: parsed.session_id };
    }
    const said = parsed?.result ?? (result.stderr.trim() || result.stdout.trim()).slice(-300);
    return { error: `Claude Code exited with ${result.code ?? "a timeout"}: ${redact(said || "no output")}` };
}

// --- Morty ------------------------------------------------------------------------------------------------------

function mortySetup(sessionId, token) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "npx",
            ["--yes", "@morty-build/cli@latest", "setup", "--base-url", "https://morty.build", "--cwd", workspace,
                "--harness", "claude", "--session-id", sessionId, "--device-access", "1d"],
            { cwd: workspace, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token, NO_BROWSER: "1" }, stdio: ["ignore", "pipe", "pipe"] },
        );
        let buffer = "";
        let ready = null;
        const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
        child.stdout.on("data", (chunk) => {
            buffer += chunk;
            for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
                const line = buffer.slice(0, index).trim();
                buffer = buffer.slice(index + 1);
                if (!line.startsWith("{")) continue;
                try {
                    const event = JSON.parse(line);
                    if (event.status === "ready") ready = event;
                    console.log(`morty setup: ${event.status}${event.error?.code ? ` (${event.error.code})` : ""}`);
                } catch {
                    // Not a setup event.
                }
            }
        });
        child.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/#code=\S+|sk-ant-\S+/gu, "<redacted>")));
        child.on("close", (code) => {
            clearTimeout(timer);
            if (ready !== null) resolve(ready);
            else reject(new Error(`morty setup exited with ${code} before ready`));
        });
    });
}

function latestActivity() {
    let newest = 0;
    const walk = (directory) => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith(".jsonl")) newest = Math.max(newest, fs.statSync(file).mtimeMs);
        }
    };
    walk(path.join(os.homedir(), ".claude", "projects"));
    return newest;
}

// --- main -------------------------------------------------------------------------------------------------------

try {
    await send("runner-key", { publicKey: own.publicKey.export({ type: "spki", format: "der" }).toString("base64") }, "Runner is up.");
    console.log(`Channel issue #${issue.number}; waiting for the page.`);
    const first = await receive(["claude-token", "claude-login-request"], 10);
    let token = first.type === "claude-token" ? decrypt(first.payload).token : null;
    if (token !== null) {
        const rejected = await checkClaudeToken(token);
        if (rejected !== null) {
            console.log(rejected);
            await send("claude-token-rejected", {}, "The saved Claude token no longer works; sign in again.");
            await receive(["claude-login-request"], 10);
            token = null;
        }
    }
    if (token === null) {
        token = await signInToClaude();
        const rejected = await checkClaudeToken(token);
        if (rejected !== null) await fail(rejected);
        // Saved as soon as Anthropic accepts it, so a later failure does not cost another sign-in.
        await send("claude-token", encrypt({ token }), "Save this Claude token in the launcher to skip sign-in next time.");
    }
    const session = await startClaudeSession(token);
    if (session.error) await fail(session.error);
    const sessionId = session.sessionId;
    console.log("Claude Code session ready; connecting to Morty.");
    const ready = await mortySetup(sessionId, token);
    await send("morty", encrypt({ url: ready.url, accessExpiresAt: ready.accessExpiresAt }), "Morty is ready.");
    console.log(`Morty is ready. Idle limit ${idleMinutes} min, hard limit ${maxMinutes} min.`);
} catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
}

let lastActivity = Date.now();
for (;;) {
    await sleep(30_000);
    lastActivity = Math.max(lastActivity, latestActivity());
    const idle = (Date.now() - lastActivity) / 60_000;
    if (idle >= idleMinutes) {
        console.log(`Idle for ${idle.toFixed(1)} min; stopping.`);
        break;
    }
    if ((Date.now() - started) / 60_000 >= maxMinutes) {
        console.log(`Reached the ${maxMinutes} min limit; stopping.`);
        break;
    }
}
