// What the launcher page and the runner say to each other. Messages are comments on a per-run GitHub issue; anything
// secret travels inside an `Encrypted` payload (see crypto.ts), the rest is plain.
import type { Encrypted } from "./crypto.ts";

export type RestoreResult = "restored" | "none" | "unreadable" | "identity-reset";

/** Payload of every message as it appears on the wire. */
interface Wire {
    "runner-key": { publicKey: string };
    "state-key": Encrypted;
    state: { restored: RestoreResult };
    "claude-login-request": Record<string, never>;
    "claude-login": Encrypted;
    "claude-code": Encrypted;
    "claude-token": Encrypted;
    "claude-token-rejected": Record<string, never>;
    morty: Encrypted;
    error: { message: string };
}

/** What the `Encrypted` payloads contain once decrypted. */
export interface Secrets {
    "state-key": { key: string };
    "claude-login": { url: string };
    "claude-code": { code: string };
    "claude-token": { token: string };
    morty: { url: string; accessExpiresAt?: string };
}

export type MessageType = keyof Wire;
export type Message = { [T in MessageType]: { type: T; payload: Wire[T] } }[MessageType];
export type Sender = "page" | "runner";
export type PayloadOf<T extends MessageType> = Wire[T];

const TYPES: Record<MessageType, true> = {
    "runner-key": true,
    "state-key": true,
    state: true,
    "claude-login-request": true,
    "claude-login": true,
    "claude-code": true,
    "claude-token": true,
    "claude-token-rejected": true,
    morty: true,
    error: true,
};

export interface Envelope {
    type: MessageType;
    request: string;
    from: Sender;
}

const MARKER = /^<!-- morty-poc (\{.*?\}) -->/u;
const BODY = /```json\n([\s\S]+?)\n```/u;

export function formatMessage<T extends MessageType>(envelope: Envelope & { type: T }, payload: Wire[T], note = ""): string {
    return `<!-- morty-poc ${JSON.stringify(envelope)} -->\n${note}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

/** Returns null for anything that is not a well-formed message of ours. */
export function parseMessage(body: string | null | undefined): { request: string; from: Sender; message: Message } | null {
    const metaText = body?.match(MARKER)?.[1];
    const payloadText = body?.match(BODY)?.[1];
    if (metaText === undefined || payloadText === undefined) return null;
    try {
        const meta = JSON.parse(metaText) as Partial<Envelope>;
        if (typeof meta.type !== "string" || !(meta.type in TYPES)) return null;
        if (typeof meta.request !== "string" || (meta.from !== "page" && meta.from !== "runner")) return null;
        return { request: meta.request, from: meta.from, message: { type: meta.type, payload: JSON.parse(payloadText) } as Message };
    } catch {
        return null;
    }
}
