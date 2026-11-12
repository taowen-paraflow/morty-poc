// Launcher logic shared by the page and tests. Runs in browsers and Node 24+ (WebCrypto + fetch).
//
// Messages between this page and the runner travel as comments on a per-run issue. Secrets in them (the Claude
// sign-in link and code, the Claude token, the Morty continue link) are encrypted to the receiver's RSA key: the page
// sends its public key when it dispatches the run, and the runner posts its own public key first thing.

export const WORKFLOW_FILE = "runner.yml";
const API = "https://api.github.com";

// ---------------------------------------------------------------------------------------------------------------
// Encoding and encryption

function base64(bytes) {
    let text = "";
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text);
}

function unbase64(text) {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function randomId(prefix) {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function createKeyPair() {
    const pair = await crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        false,
        ["encrypt", "decrypt"],
    );
    return { publicKey: base64(await crypto.subtle.exportKey("spki", pair.publicKey)), privateKey: pair.privateKey };
}

/** `{k, iv, c}`: an RSA-OAEP-SHA256-wrapped AES-256-GCM key, its IV, and the ciphertext with the tag appended. */
export async function encryptTo(publicKeyBase64, value) {
    const publicKey = await crypto.subtle.importKey(
        "spki",
        unbase64(publicKeyBase64),
        { name: "RSA-OAEP", hash: "SHA-256" },
        false,
        ["encrypt"],
    );
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt"]);
    const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    const k = await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, raw);
    return { k: base64(k), iv: base64(iv), c: base64(c) };
}

export async function decryptWith(privateKey, payload) {
    const raw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, unbase64(payload.k));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unbase64(payload.iv) }, key, unbase64(payload.c));
    return JSON.parse(new TextDecoder().decode(plain));
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub REST

export class GitHub {
    constructor(token, repository) {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Repository must be owner/name.");
        this.token = token;
        this.repository = repository;
    }

    async request(method, path, body, { absolute = false } = {}) {
        const response = await fetch(absolute ? `${API}${path}` : `${API}/repos/${this.repository}${path}`, {
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
            const error = new Error(`GitHub ${method} ${path} answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
            error.status = response.status;
            throw error;
        }
        return response.status === 204 || response.status === 202 ? null : await response.json();
    }

    async viewer() {
        return await this.request("GET", "/user", undefined, { absolute: true });
    }

    async dispatch(inputs) {
        const { default_branch: ref } = await this.request("GET", "");
        await this.request("POST", `/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref, inputs });
    }

    async runs() {
        const page = await this.request("GET", `/actions/workflows/${WORKFLOW_FILE}/runs?per_page=20`);
        return page.workflow_runs.map((run) => ({
            id: run.id,
            name: run.name ?? run.display_title ?? "",
            status: run.status,
            conclusion: run.conclusion,
            startedAt: run.run_started_at,
            url: run.html_url,
        }));
    }

    async cancel(runId, force = false) {
        await this.request("POST", `/actions/runs/${runId}/${force ? "force-cancel" : "cancel"}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The per-run message channel

const MARKER = /^<!-- morty-poc (\{.*?\}) -->/u;

export function formatMessage(meta, payload, note = "") {
    return `<!-- morty-poc ${JSON.stringify(meta)} -->\n${note}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

export function parseMessage(body) {
    const meta = body?.match(MARKER)?.[1];
    const payload = body?.match(/```json\n([\s\S]+?)\n```/u)?.[1];
    if (meta === undefined || payload === undefined) return null;
    try {
        return { meta: JSON.parse(meta), payload: JSON.parse(payload) };
    } catch {
        return null;
    }
}

export class RunChannel {
    constructor(github, requestId) {
        this.github = github;
        this.requestId = requestId;
        this.issue = null;
        this.seen = new Set();
    }

    async findIssue() {
        if (this.issue !== null) return this.issue;
        const issues = await this.github.request("GET", "/issues?state=all&sort=created&direction=desc&per_page=30");
        this.issue = issues.find((item) => item.title === `morty-run ${this.requestId}` && item.pull_request === undefined) ?? null;
        return this.issue;
    }

    /** New messages from the runner (comments by the Actions bot), oldest first. */
    async receive() {
        const issue = await this.findIssue();
        if (issue === null) return [];
        const comments = await this.github.request("GET", `/issues/${issue.number}/comments?per_page=100`);
        const messages = [];
        for (const comment of comments) {
            if (this.seen.has(comment.id) || comment.user?.login !== "github-actions[bot]") continue;
            this.seen.add(comment.id);
            const message = parseMessage(comment.body);
            if (message?.meta.request === this.requestId) messages.push(message);
        }
        return messages;
    }

    async send(type, payload, note) {
        const issue = await this.findIssue();
        await this.github.request("POST", `/issues/${issue.number}/comments`, {
            body: formatMessage({ type, request: this.requestId, from: "page" }, payload, note),
        });
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Browser vault: values encrypted with a non-extractable AES key that never leaves this browser's IndexedDB.

function openVault() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("morty-poc", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("vault");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function vaultOperation(mode, run) {
    const database = await openVault();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction("vault", mode);
            const result = run(transaction.objectStore("vault"));
            transaction.oncomplete = () => resolve(result.result);
            transaction.onerror = () => reject(transaction.error);
        });
    } finally {
        database.close();
    }
}

async function vaultKey() {
    const existing = await vaultOperation("readonly", (store) => store.get("key"));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await vaultOperation("readwrite", (store) => store.put(key, "key"));
    return key;
}

export const vault = {
    async get(name) {
        try {
            const entry = await vaultOperation("readonly", (store) => store.get(name));
            if (!entry) return null;
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: entry.iv }, await vaultKey(), entry.data);
            return JSON.parse(new TextDecoder().decode(plain));
        } catch {
            return null;
        }
    },
    async set(name, value) {
        if (value === null) {
            await vaultOperation("readwrite", (store) => store.delete(name));
            return;
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await vaultKey(), new TextEncoder().encode(JSON.stringify(value)));
        await vaultOperation("readwrite", (store) => store.put({ iv, data }, name));
    },
};

// ---------------------------------------------------------------------------------------------------------------
// GitHub token

/** GitHub's template link for a fine-grained token with exactly the permissions the launcher needs. */
export function tokenTemplateUrl(repository) {
    const [owner, name] = repository.split("/");
    const url = new URL("https://github.com/settings/personal-access-tokens/new");
    url.searchParams.set("name", `${name} launcher`);
    url.searchParams.set("description", `Starts and stops ${repository} runners. Select only the ${name} repository.`);
    url.searchParams.set("target_name", owner);
    url.searchParams.set("expires_in", "90");
    url.searchParams.set("actions", "write");
    url.searchParams.set("issues", "write");
    return url.toString();
}

/**
 * Confirms the token is valid and can read the repository's runs before it is saved. Public repositories answer
 * anonymous reads, so the token itself is checked through /user, which rejects an invalid token.
 */
export async function checkToken(token, repository) {
    if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/u.test(token)) throw new Error("This does not look like a GitHub token.");
    const github = new GitHub(token, repository);
    github.login = (await github.viewer()).login;
    await github.runs();
    return github;
}

export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
