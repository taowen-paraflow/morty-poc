// Shared logic for the launcher page and the end-to-end script. Runs in browsers and in Node 24+ (WebCrypto + fetch).

export const WORKFLOW_FILE = "runner.yml";
export const HANDOFF_ISSUE_TITLE = "morty-poc handoffs";
const API = "https://api.github.com";

/** A request id names one launch; the workflow run and its handoff comment carry it. */
export function newRequestId() {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `r-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function base64(bytes) {
    let text = "";
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text);
}

function unbase64(text) {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

/**
 * A key pair for one launch. The runner encrypts the continue link to the public key, so the link never appears in
 * public logs or comments; only this page, which keeps the private key in memory, can read it.
 */
export async function createLaunchKeys() {
    const pair = await crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        false,
        ["decrypt"],
    );
    const spki = await crypto.subtle.exportKey("spki", pair.publicKey);
    return { publicKey: base64(spki), privateKey: pair.privateKey };
}

/** Decrypts `{k, iv, c}`: an RSA-OAEP-wrapped AES-256-GCM key, its IV, and ciphertext with the tag appended. */
export async function decryptHandoff(privateKey, payload) {
    const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, unbase64(payload.k));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(payload.iv) }, key, unbase64(payload.c));
    const handoff = JSON.parse(new TextDecoder().decode(plain));
    const url = new URL(handoff.url);
    if (url.protocol !== "https:" || url.pathname !== "/continue" || !url.hash.startsWith("#code=")) {
        throw new Error("The runner returned an unexpected link.");
    }
    return handoff;
}

export class GitHub {
    constructor(token, repository) {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Repository must be owner/name.");
        this.token = token;
        this.repository = repository;
    }

    async request(method, path, body) {
        const response = await fetch(`${API}/repos/${this.repository}${path}`, {
            method,
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${this.token}`,
                "x-github-api-version": "2022-11-28",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`GitHub ${method} ${path} answered ${response.status}: ${text.slice(0, 200)}`);
        }
        return response.status === 204 || response.status === 202 ? null : await response.json();
    }

    async defaultBranch() {
        return (await this.request("GET", "")).default_branch;
    }

    async dispatch({ requestId, publicKey, idleMinutes }) {
        const ref = await this.defaultBranch();
        await this.request("POST", `/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
            ref,
            inputs: { request_id: requestId, public_key: publicKey, idle_minutes: String(idleMinutes) },
        });
    }

    /** Runs of the launcher workflow, newest first. The run name carries the request id. */
    async runs() {
        const page = await this.request("GET", `/actions/workflows/${WORKFLOW_FILE}/runs?per_page=30`);
        return page.workflow_runs.map((run) => ({
            id: run.id,
            name: run.name ?? run.display_title,
            status: run.status,
            conclusion: run.conclusion,
            startedAt: run.run_started_at,
            url: run.html_url,
        }));
    }

    async findRun(requestId) {
        return (await this.runs()).find((run) => run.name?.includes(requestId)) ?? null;
    }

    async findHandoff(requestId) {
        const issues = await this.request("GET", "/issues?state=open&per_page=100");
        const issue = issues.find((item) => item.title === HANDOFF_ISSUE_TITLE && item.pull_request === undefined);
        if (issue === undefined) return null;
        const marker = `<!-- morty-poc-handoff ${requestId} -->`;
        for (let page = 1; page <= 10; page += 1) {
            const comments = await this.request("GET", `/issues/${issue.number}/comments?per_page=100&page=${page}`);
            const comment = comments.find(
                (item) => item.body?.startsWith(marker) && item.user?.login === "github-actions[bot]",
            );
            if (comment !== undefined) {
                const json = comment.body.match(/```json\n([\s\S]+?)\n```/u)?.[1];
                return json === undefined ? null : JSON.parse(json);
            }
            if (comments.length < 100) break;
        }
        return null;
    }

    /** Graceful cancel lets the cleanup step revoke access; force skips it and is for a run that ignores cancel. */
    async cancel(runId, force = false) {
        await this.request("POST", `/actions/runs/${runId}/${force ? "force-cancel" : "cancel"}`);
    }
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Dispatches a runner and waits for its encrypted handoff. `report` receives progress text. */
export async function launch(github, { idleMinutes = 30, report = () => {}, signal } = {}) {
    const keys = await createLaunchKeys();
    const requestId = newRequestId();
    await github.dispatch({ requestId, publicKey: keys.publicKey, idleMinutes });
    report(`Dispatched ${requestId}; waiting for the runner…`);
    const deadline = Date.now() + 15 * 60_000;
    let run = null;
    while (Date.now() < deadline) {
        signal?.throwIfAborted();
        run = run ?? (await github.findRun(requestId));
        if (run !== null) {
            const current = (await github.runs()).find((item) => item.id === run.id) ?? run;
            if (current.status === "completed") {
                throw new Error(`The runner ended (${current.conclusion}) before handing off. See ${current.url}`);
            }
            report(`Runner ${current.status}…`);
            const payload = await github.findHandoff(requestId);
            if (payload !== null) {
                const handoff = await decryptHandoff(keys.privateKey, payload);
                return { requestId, run: current, handoff };
            }
        }
        await sleep(5_000);
    }
    throw new Error("No handoff within 15 minutes.");
}
