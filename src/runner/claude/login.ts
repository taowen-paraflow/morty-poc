// Drives `claude setup-token` for the launcher page: it shows a sign-in link, the user signs in in their own browser
// and pastes back the code Claude shows, and Claude then prints a long-lived token. Everything is read from the
// rendered terminal screen (see terminal.ts).
import { sleep } from "../../shared/time.ts";
import { TerminalProgram } from "../terminal.ts";

// A wide terminal keeps the sign-in link and the token on one line each.
const COLUMNS = 1000;
const ROWS = 80;
const URL_PATTERN = /https:\/\/claude\.(?:com|ai)\/\S*oauth\/authorize\S+/u;
const TOKEN_PATTERN = /sk-ant-[a-z0-9]+-[A-Za-z0-9_-]{20,}/u;
const FAILURE_PATTERN = /OAuth error.*|[Ii]nvalid (?:code|grant).*/u;
const SECRETS_PATTERN = /sk-ant-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{24,}#[A-Za-z0-9_-]{8,}|https:\/\/\S+/gu;
const CODE_PATTERN = /^[A-Za-z0-9_\-#.~]{10,2048}$/u;

export function findUrl(text: string): string | null {
    return URL_PATTERN.exec(text)?.[0] ?? null;
}

/**
 * The token sits between the "valid for 1 year" label and the "Store this token" advice; a narrow terminal could
 * wrap it, so the lines between them are joined before matching.
 */
export function findToken(text: string): string | null {
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line.includes("valid for 1 year"));
    if (start < 0) return null;
    const end = lines.findIndex((line, index) => index > start && line.includes("Store this token"));
    if (end < 0) return null;
    const joined = lines.slice(start + 1, end).map((line) => line.trim()).join("");
    return TOKEN_PATTERN.exec(joined)?.[0] ?? null;
}

type Outcome = { token: string } | { failure: string };

function findOutcome(text: string): Outcome | null {
    const token = findToken(text);
    if (token !== null) return { token };
    const failure = FAILURE_PATTERN.exec(text)?.[0];
    return failure === undefined ? null : { failure };
}

export interface ClaudeLogin {
    /** The Claude sign-in link to show the user. */
    url: string;
    /** Types the code Claude showed after sign-in and returns the long-lived token. */
    complete: (code: string) => Promise<string>;
}

/** The last lines on screen with secrets and links removed, for diagnosing a failed sign-in. */
function safeTail(terminal: TerminalProgram): string {
    const lines = terminal.lines().map((line) => line.trim().replace(SECRETS_PATTERN, "<redacted>"));
    return lines.slice(-5).join(" | ").slice(-400) || "nothing";
}

export async function startClaudeLogin(env: NodeJS.ProcessEnv): Promise<ClaudeLogin> {
    const terminal = new TerminalProgram(["claude", "setup-token"], {
        env: { ...env, BROWSER: "false", TERM: "xterm-256color" },
        columns: COLUMNS,
        rows: ROWS,
    });
    const url = await terminal.waitFor(findUrl, 90);
    if (url === null) {
        const said = safeTail(terminal);
        terminal.close();
        throw new Error(`claude setup-token did not show a sign-in link. Claude said: ${said}`);
    }
    return {
        url,
        complete: async (rawCode) => {
            try {
                const code = rawCode.trim();
                if (!CODE_PATTERN.test(code)) throw new Error("the sign-in code has an unexpected format");
                // Type the code, then press Enter separately, as a terminal paste would.
                terminal.type(code);
                await sleep(500);
                terminal.type("\r");
                const outcome = await terminal.waitFor(findOutcome, 180);
                if (outcome === null || !("token" in outcome)) {
                    throw new Error(`Claude did not issue a token. Claude said: ${safeTail(terminal)}`);
                }
                return outcome.token;
            } finally {
                terminal.close();
            }
        },
    };
}
