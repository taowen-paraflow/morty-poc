const API = "https://api.github.com";

/** The only thing the message channel needs from GitHub; tests provide a fake. */
export interface GitHubApi {
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
}

export class GitHubError extends Error {
    readonly status: number;
    constructor(message: string, status: number) {
        super(message);
        this.status = status;
    }
}

export class GitHubClient implements GitHubApi {
    readonly repository: string;
    private readonly token: string;

    constructor(token: string, repository: string) {
        if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) throw new Error("Repository must be owner/name.");
        this.token = token;
        this.repository = repository;
    }

    /** `path` is relative to the repository, e.g. `/issues`. */
    request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
        return this.send(method, `${API}/repos/${this.repository}${path}`, body);
    }

    /** A call that is not about the repository, e.g. `GET /user`. */
    requestGlobal<T = unknown>(method: string, path: string): Promise<T> {
        return this.send(method, `${API}${path}`);
    }

    private async send<T>(method: string, url: string, body?: unknown): Promise<T> {
        const response = await fetch(url, {
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
            const detail = (await response.text()).slice(0, 200);
            throw new GitHubError(`GitHub ${method} ${new URL(url).pathname} answered ${response.status}: ${detail}`, response.status);
        }
        return (response.status === 204 || response.status === 202 ? null : await response.json()) as T;
    }
}
