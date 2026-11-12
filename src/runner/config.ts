// Everything the runner reads from the environment, validated once at start-up.
export interface RunnerConfig {
    requestId: string;
    /** Base64 SPKI public key of the launcher page. */
    pagePublicKey: string;
    idleMinutes: number;
    maxMinutes: number;
    /** The GitHub user who dispatched the run; only their comments are obeyed. */
    actor: string;
    workspace: string;
    repository: string;
    githubToken: string;
    runUrl: string;
    /** npx package spec of the Morty CLI. */
    mortyCli: string;
    /** Where the workflow's cleanup step finds the run's issue number. */
    issueFile: string;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
    const required = (name: string): string => {
        const value = env[name];
        if (value === undefined || value === "") throw new Error(`${name} is not set.`);
        return value;
    };
    const requestId = required("REQUEST_ID");
    if (!/^r-[0-9a-f]{24}$/u.test(requestId)) throw new Error("request_id is invalid.");
    const idleMinutes = Number(env.IDLE_MINUTES ?? "30");
    if (!Number.isFinite(idleMinutes) || idleMinutes < 5 || idleMinutes > 300) throw new Error("idle_minutes must be 5-300.");
    const repository = required("GITHUB_REPOSITORY");
    return {
        requestId,
        pagePublicKey: required("PUBLIC_KEY"),
        idleMinutes,
        maxMinutes: Number(env.MAX_MINUTES ?? "340"),
        actor: env.GITHUB_ACTOR ?? "",
        workspace: env.GITHUB_WORKSPACE ?? process.cwd(),
        repository,
        githubToken: required("GITHUB_TOKEN"),
        runUrl: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
        mortyCli: env.MORTY_CLI ?? "@morty-build/cli@latest",
        issueFile: "/tmp/morty-poc-issue",
    };
}
