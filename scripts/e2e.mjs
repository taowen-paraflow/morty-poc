// End-to-end check of the launcher flow without a browser: launch a runner the way the page does, follow the
// handoff through the Morty agent API (https://morty.build/agent-api.md), run one turn in the runner's Pi session,
// then stop the runner from GitHub and confirm its cleanup ran.
//
//   GITHUB_TOKEN=... node scripts/e2e.mjs owner/name
//
// Links, tokens and credentials are never printed.
import crypto from "node:crypto";
import { GitHub, launch, sleep } from "../app.js";

const repository = process.argv[2];
const token = process.env.GITHUB_TOKEN;
if (!repository || !token) {
    console.error("usage: GITHUB_TOKEN=... node scripts/e2e.mjs owner/name");
    process.exit(2);
}
const github = new GitHub(token, repository);
const morty = "https://morty.build";

async function api(method, path, body, bearer) {
    const response = await fetch(`${morty}${path}`, {
        method,
        headers: { "content-type": "application/json", ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 200)}`);
    return JSON.parse(text);
}

function transport(computerId) {
    const socket = new WebSocket(`wss://morty.build/morty/api/v1/computers/${computerId}/transport`);
    const pending = new Map();
    socket.addEventListener("message", (event) => {
        const frame = JSON.parse(event.data);
        pending.get(frame.requestId)?.(frame);
    });
    const opened = new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", () => reject(new Error("transport failed")), { once: true });
    });
    return {
        opened,
        close: () => socket.close(),
        request(method, path, credential, body) {
            const requestId = crypto.randomUUID();
            socket.send(
                JSON.stringify({
                    kind: "http.request",
                    requestId,
                    method,
                    path,
                    headers: [
                        ["authorization", `Bearer ${credential}`],
                        ["content-type", "application/json"],
                    ],
                    body: body === undefined ? "" : JSON.stringify(body),
                }),
            );
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`${method} ${path} timed out`)), 60_000);
                pending.set(requestId, (frame) => {
                    clearTimeout(timer);
                    pending.delete(requestId);
                    if (frame.kind === "http.response" && frame.status < 400) resolve(JSON.parse(frame.body || "null"));
                    else reject(new Error(`${method} ${path} -> ${frame.status} ${frame.code ?? frame.body}`));
                });
            });
        },
    };
}

const startedAt = Date.now();
const { requestId, run, handoff } = await launch(github, {
    idleMinutes: 10,
    report: (text) => console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${text}`),
});
console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] handoff decrypted for ${requestId} (run ${run.id})`);

const link = new URL(handoff.url);
const code = new URLSearchParams(link.hash.slice(1)).get("code");
const target = { harness: link.searchParams.get("harness"), sessionId: link.searchParams.get("sessionId") };
const identity = await api("POST", "/morty/api/v1/identity/transfers/redeem", {
    code,
    redemptionKey: crypto.randomBytes(32).toString("base64url"),
    device: "morty-poc e2e",
});
const workspace = await api("POST", `/morty/api/v1/computers/${identity.computerId}/workspace`, {}, identity.computerToken);
console.log(`computer online=${workspace.computer.online} agents=${workspace.computer.agents.map((a) => a.harness).join(",")}`);
const access = await api(
    "POST",
    `/morty/api/v1/computers/${identity.computerId}/managed-sessions/open`,
    target,
    identity.computerToken,
);

const socket = transport(identity.computerId);
await socket.opened;
const session = `/morty/api/v1/computers/${identity.computerId}/harnesses/${target.harness}/sessions/${target.sessionId}`;
const idempotencyKey = crypto.randomUUID();
await socket.request("POST", `${session}/turns`, access.credential, {
    content: "Reply with exactly: MORTY_POC_OK",
    attachments: [],
    sessionConfigurations: [],
    idempotencyKey,
});
for (let attempt = 0; attempt < 60; attempt += 1) {
    const active = await socket.request("GET", `${session}/active-turn`, access.credential);
    if (active.turn === null && active.lastTurn?.commandId === idempotencyKey) {
        console.log(`turn ${active.lastTurn.state} (${active.lastTurn.stopReason ?? "-"})`);
        break;
    }
    await sleep(3_000);
}
const page = await socket.request("GET", `${session}/events?limit=50`, access.credential);
const reply = page.events
    .filter((event) => event.payload?.sessionUpdate === "agent_message_chunk")
    .map((event) => event.payload.content?.text ?? "")
    .join("");
console.log(`agent reply: ${reply.trim().slice(-200)}`);
socket.close();

console.log("stopping the runner from GitHub (graceful cancel)…");
await github.cancel(run.id);
for (let attempt = 0; attempt < 60; attempt += 1) {
    const current = (await github.runs()).find((item) => item.id === run.id);
    if (current?.status === "completed") {
        console.log(`run ${current.conclusion} after ${Math.round((Date.now() - startedAt) / 1000)}s`);
        break;
    }
    await sleep(5_000);
}
try {
    await api("POST", `/morty/api/v1/computers/${identity.computerId}/workspace`, {}, identity.computerToken);
    console.log("access still valid after stop (cleanup did not revoke)");
} catch (error) {
    console.log(`access after stop: ${error.message.split(" ")[3]} (revoked by cleanup)`);
}
console.log(reply.includes("MORTY_POC_OK") ? "E2E PASS" : "E2E FAIL");
