import { redact } from "../redact.ts";
import { errorMessage } from "../../shared/time.ts";

/**
 * Asks the API directly whether the token is accepted, so a bad token fails in seconds with Anthropic's reason
 * instead of Claude Code retrying until a timeout. Only authentication and permission errors reject the token;
 * returns the reason for a rejection, or null when the token is accepted or the check itself could not be made.
 */
export async function checkClaudeToken(token: string): Promise<string | null> {
    const shape = `${token.slice(0, 13)}… (${token.length} chars)`;
    try {
        const response = await fetch("https://api.anthropic.com/v1/messages", {
            method: "POST",
            headers: {
                authorization: `Bearer ${token}`,
                "anthropic-version": "2023-06-01",
                "anthropic-beta": "oauth-2025-04-20",
                "content-type": "application/json",
            },
            body: JSON.stringify({
                model: "claude-haiku-4-5",
                max_tokens: 1,
                system: "You are Claude Code, Anthropic's official CLI for Claude.",
                messages: [{ role: "user", content: "hi" }],
            }),
            signal: AbortSignal.timeout(30_000),
        });
        const body = (await response.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
        const type = body.error?.type;
        if (type === "authentication_error" || type === "permission_error") {
            return `Anthropic rejected the token ${shape}: ${redact(body.error?.message)}`;
        }
        console.log(`Claude token ${shape} accepted (HTTP ${response.status}${type ? `, ${type}` : ""}).`);
        return null;
    } catch (error) {
        console.log(`Could not pre-check the Claude token: ${redact(errorMessage(error))}`);
        return null;
    }
}
