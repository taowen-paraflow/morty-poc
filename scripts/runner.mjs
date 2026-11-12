// Runs inside the GitHub Actions job: starts a Pi session, connects this runner to Morty, hands the encrypted
// continue link to the launcher page, and keeps the job alive until the conversation goes idle.
// The continue link is a credential. It is never printed; only its encrypted form leaves this process.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const env = process.env;
const requestId = env.REQUEST_ID ?? "";
const publicKeyText = env.PUBLIC_KEY ?? "";
const idleMinutes = Number(env.IDLE_MINUTES ?? "30");
const maxMinutes = Number(env.MAX_MINUTES ?? "340");
const workspace = env.GITHUB_WORKSPACE ?? process.cwd();
const started = Date.now();

function fail(message) {
    console.error(`::error::${message}`);
    process.exit(1);
}

if (!/^r-[0-9a-f]{24}$/u.test(requestId)) fail("request_id is invalid.");
if (!Number.isFinite(idleMinutes) || idleMinutes < 5 || idleMinutes > 300) fail("idle_minutes must be 5-300.");
let publicKey;
try {
    publicKey = crypto.createPublicKey({ key: Buffer.from(publicKeyText, "base64"), format: "der", type: "spki" });
} catch {
    fail("public_key is not an SPKI RSA key.");
}
if (publicKey.asymmetricKeyType !== "rsa" || publicKey.asymmetricKeyDetails.modulusLength < 2048) {
    fail("public_key must be RSA with at least 2048 bits.");
}

function writePiConfig() {
    const directory = path.join(os.homedir(), ".pi", "agent");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const [name, value] of [
        ["models.json", env.PI_MODELS_JSON],
        ["auth.json", env.PI_AUTH_JSON],
        ["settings.json", env.PI_SETTINGS_JSON],
    ]) {
        if (value === undefined || value.trim() === "") continue;
        JSON.parse(value);
        fs.writeFileSync(path.join(directory, name), value, { mode: 0o600 });
    }
}

function sessionFiles() {
    const root = path.join(os.homedir(), ".pi", "agent", "sessions");
    const files = [];
    const walk = (directory) => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(file);
            else if (entry.name.endsWith(".jsonl")) files.push({ file, mtime: fs.statSync(file).mtimeMs });
        }
    };
    walk(root);
    return files.sort((left, right) => right.mtime - left.mtime);
}

function startPiSession() {
    const result = spawnSync("pi", ["-p", "Reply with exactly: MORTY_POC_READY"], {
        cwd: workspace,
        encoding: "utf8",
        timeout: 180_000,
    });
    if (result.status !== 0 || !result.stdout.includes("MORTY_POC_READY")) {
        fail(`Pi could not answer with the configured model: ${(result.stderr || result.stdout).slice(-500)}`);
    }
    const newest = sessionFiles()[0];
    const sessionId = newest?.file.match(/_([0-9a-f-]{36})\.jsonl$/u)?.[1];
    if (sessionId === undefined) fail("Pi did not record a session.");
    console.log(`Pi session ${sessionId} is ready.`);
    return sessionId;
}

/** Runs `morty setup` and returns its ready result. Output lines carry the link, so they are parsed, not echoed. */
function mortySetup(sessionId) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            "npx",
            [
                "--yes",
                "@morty-build/cli@latest",
                "setup",
                "--base-url",
                "https://morty.build",
                "--cwd",
                workspace,
                "--harness",
                "pi",
                "--session-id",
                sessionId,
                "--device-access",
                "1d",
            ],
            { cwd: workspace, env: { ...env, NO_BROWSER: "1" }, stdio: ["ignore", "pipe", "pipe"] },
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
                    console.log(`morty setup: ${event.status}${event.message ? ` - ${event.message}` : ""}`);
                    if (event.error?.code) console.log(`morty setup error: ${event.error.code}`);
                } catch {
                    // Not a setup event.
                }
            }
        });
        child.stderr.on("data", (chunk) => process.stderr.write(String(chunk).replace(/#code=\S+/gu, "#code=<redacted>")));
        child.on("close", (code) => {
            clearTimeout(timer);
            if (ready !== null) resolve(ready);
            else reject(new Error(`morty setup exited with ${code} before ready`));
        });
    });
}

function encrypt(handoff) {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(handoff), "utf8"), cipher.final(), cipher.getAuthTag()]);
    const wrapped = crypto.publicEncrypt(
        { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        key,
    );
    return { k: wrapped.toString("base64"), iv: iv.toString("base64"), c: body.toString("base64") };
}

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

async function postHandoff(payload) {
    const issues = await github("GET", "/issues?state=open&per_page=100");
    let issue = issues.find((item) => item.title === "morty-poc handoffs" && item.pull_request === undefined);
    if (issue === undefined) {
        issue = await github("POST", "/issues", {
            title: "morty-poc handoffs",
            body: "The launcher runner posts encrypted continue links here. Only the page that started a run can decrypt its link.",
        });
    }
    const runUrl = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    await github("POST", `/issues/${issue.number}/comments`, {
        body: `<!-- morty-poc-handoff ${requestId} -->\nEncrypted handoff for [run ${env.GITHUB_RUN_ID}](${runUrl}).\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``,
    });
}

writePiConfig();
const sessionId = startPiSession();
const ready = await mortySetup(sessionId);
await postHandoff(encrypt({ url: ready.url, accessExpiresAt: ready.accessExpiresAt, computerId: ready.computerId }));
console.log(`Handoff posted. Idle limit ${idleMinutes} min, hard limit ${maxMinutes} min.`);

// Pi appends to its session files whenever the conversation moves, so their newest change marks the last activity.
let lastActivity = Date.now();
for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    const newest = sessionFiles()[0]?.mtime ?? 0;
    lastActivity = Math.max(lastActivity, newest);
    const idle = (Date.now() - lastActivity) / 60_000;
    const elapsed = (Date.now() - started) / 60_000;
    if (idle >= idleMinutes) {
        console.log(`Idle for ${idle.toFixed(1)} min; stopping.`);
        break;
    }
    if (elapsed >= maxMinutes) {
        console.log(`Reached the ${maxMinutes} min limit; stopping.`);
        break;
    }
}
