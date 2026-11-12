// What the page does with GitHub: check the token, start and stop runner runs, and find a run's message channel.
import { Channel } from "../shared/channel.ts";
import { GitHubClient } from "../shared/github.ts";

const WORKFLOW_FILE = "runner.yml";
const ACTIONS_BOT = "github-actions[bot]";

export interface RunSummary {
    id: number;
    name: string;
    status: string;
    conclusion: string | null;
    url: string;
}

interface WorkflowRun {
    id: number;
    name?: string | null;
    display_title?: string;
    status: string;
    conclusion: string | null;
    html_url: string;
}

interface Issue {
    number: number;
    title: string;
    user: { login: string } | null;
    pull_request?: unknown;
}

export class RunnerActions {
    readonly github: GitHubClient;
    readonly login: string;

    private constructor(github: GitHubClient, login: string) {
        this.github = github;
        this.login = login;
    }

    /**
     * Confirms the token is valid and can read the repository's runs before it is saved. Public repositories answer
     * anonymous reads, so the token itself is checked through /user, which rejects an invalid token.
     */
    static async connect(token: string, repository: string): Promise<RunnerActions> {
        if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/u.test(token)) throw new Error("This does not look like a GitHub token.");
        const github = new GitHubClient(token, repository);
        const { login } = await github.requestGlobal<{ login: string }>("GET", "/user");
        const actions = new RunnerActions(github, login);
        await actions.runs();
        return actions;
    }

    async dispatch(inputs: { request_id: string; public_key: string; idle_minutes: string }): Promise<void> {
        const { default_branch: ref } = await this.github.request<{ default_branch: string }>("GET", "");
        await this.github.request("POST", `/actions/workflows/${WORKFLOW_FILE}/dispatches`, { ref, inputs });
    }

    async runs(): Promise<RunSummary[]> {
        const page = await this.github.request<{ workflow_runs: WorkflowRun[] }>("GET", `/actions/workflows/${WORKFLOW_FILE}/runs?per_page=20`);
        return page.workflow_runs.map((run) => ({
            id: run.id,
            name: run.name ?? run.display_title ?? "",
            status: run.status,
            conclusion: run.conclusion,
            url: run.html_url,
        }));
    }

    /** The run that is queued or running, if any; the workflow allows only one at a time. */
    async activeRun(): Promise<RunSummary | null> {
        return (await this.runs()).find((run) => run.status !== "completed") ?? null;
    }

    async cancel(runId: number, force = false): Promise<void> {
        await this.github.request("POST", `/actions/runs/${runId}/${force ? "force-cancel" : "cancel"}`);
    }

    /** The page's side of a run's message channel; it only listens to the Actions bot that the runner posts as. */
    channel(requestId: string): Channel {
        return new Channel(this.github, requestId, {
            self: "page",
            isPeer: (login) => login === ACTIONS_BOT,
            findIssue: async () => {
                const issues = await this.github.request<Issue[]>("GET", "/issues?state=all&sort=created&direction=desc&per_page=30");
                // Only the issue the runner opened counts; anyone can open an issue with the same title.
                const issue = issues.find((item) => item.title === `morty-run ${requestId}` && item.pull_request === undefined && item.user?.login === ACTIONS_BOT);
                return issue?.number ?? null;
            },
        });
    }
}

/** GitHub's template link for a fine-grained token with exactly the permissions the launcher needs. */
export function tokenTemplateUrl(repository: string): string {
    const [owner = "", name = ""] = repository.split("/");
    const url = new URL("https://github.com/settings/personal-access-tokens/new");
    url.searchParams.set("name", `${name} launcher`);
    url.searchParams.set("description", `Starts and stops ${repository} runners. Select only the ${name} repository.`);
    url.searchParams.set("target_name", owner);
    url.searchParams.set("expires_in", "90");
    url.searchParams.set("actions", "write");
    url.searchParams.set("issues", "write");
    return url.toString();
}
