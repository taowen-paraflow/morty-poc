import type { GitHubApi } from "./github.ts";
import { formatMessage, parseMessage } from "./protocol.ts";
import type { Message, MessageType, PayloadOf, Sender } from "./protocol.ts";
import { sleep } from "./time.ts";

interface IssueComment {
    id: number;
    body: string | null;
    user: { login: string } | null;
}

export interface ChannelOptions {
    /** Which side this is; it only reads messages sent by the other side. */
    self: Sender;
    /** Locates the run's issue: the page searches for it, the runner has just created it. Null until it exists. */
    findIssue: () => Promise<number | null>;
    /** Whether a comment author is trusted to speak for the other side. */
    isPeer: (login: string) => boolean;
}

/** One side of the conversation on a run's issue. */
export class Channel {
    private readonly github: GitHubApi;
    private readonly requestId: string;
    private readonly options: ChannelOptions;
    private readonly seen = new Set<number>();
    private pending: Message[] = [];
    private issue: number | null = null;

    constructor(github: GitHubApi, requestId: string, options: ChannelOptions) {
        this.github = github;
        this.requestId = requestId;
        this.options = options;
    }

    private async locate(): Promise<number | null> {
        this.issue ??= await this.options.findIssue();
        return this.issue;
    }

    /** Messages that arrived since the last call, oldest first. */
    async poll(): Promise<Message[]> {
        const issue = await this.locate();
        if (issue === null) return [];
        const comments = await this.github.request<IssueComment[]>("GET", `/issues/${issue}/comments?per_page=100`);
        const messages: Message[] = [];
        for (const comment of comments) {
            if (this.seen.has(comment.id)) continue;
            this.seen.add(comment.id);
            if (comment.user === null || !this.options.isPeer(comment.user.login)) continue;
            const parsed = parseMessage(comment.body);
            if (parsed !== null && parsed.request === this.requestId && parsed.from !== this.options.self) {
                messages.push(parsed.message);
            }
        }
        return messages;
    }

    /** Waits for the next message of one of `types`; messages of other types stay queued for a later wait. */
    async waitFor<T extends MessageType>(types: readonly T[], timeoutMs: number, intervalMs = 3_000): Promise<Extract<Message, { type: T }>> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            this.pending.push(...(await this.poll()));
            const index = this.pending.findIndex((message) => (types as readonly string[]).includes(message.type));
            if (index >= 0) return this.pending.splice(index, 1)[0] as Extract<Message, { type: T }>;
            if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${types.join(" or ")}.`);
            await sleep(intervalMs);
        }
    }

    async send<T extends MessageType>(type: T, payload: PayloadOf<T>, note?: string): Promise<void> {
        const issue = await this.locate();
        if (issue === null) throw new Error("The run's message channel does not exist yet.");
        await this.github.request("POST", `/issues/${issue}/comments`, {
            body: formatMessage({ type, request: this.requestId, from: this.options.self }, payload, note),
        });
    }
}
