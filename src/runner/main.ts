// Runs inside the GitHub Actions job (`node src/runner/main.ts`). It talks to the launcher page through comments on a
// per-run issue, connects Claude Code to Morty (see connect.ts) and then stays up until the conversation is idle, the
// time limit passes, or the run is cancelled; the workflow then packs the state again for the cache.
// Secrets are never printed. Only messages from the user who dispatched the run are accepted.
import fs from "node:fs";
import { Channel } from "../shared/channel.ts";
import { createKeyPair, decryptWith, encryptTo, importPublicKey } from "../shared/crypto.ts";
import type { Encrypted } from "../shared/crypto.ts";
import { GitHubClient } from "../shared/github.ts";
import { errorMessage } from "../shared/time.ts";
import { readConfig } from "./config.ts";
import { connect } from "./connect.ts";
import { waitUntilDone } from "./idle.ts";
import { stateLayout } from "./state.ts";

const startedAt = Date.now();
const config = readConfig();
const pageKey = await importPublicKey(config.pagePublicKey);
const own = await createKeyPair();

const github = new GitHubClient(config.githubToken, config.repository);
const issue = await github.request<{ number: number }>("POST", "/issues", {
    title: `morty-run ${config.requestId}`,
    body: `Message channel for [this run](${config.runUrl}). Secrets in it are encrypted; the run closes this issue when it ends.`,
});
fs.writeFileSync(config.issueFile, String(issue.number));
console.log(`Channel issue #${issue.number}.`);

const channel = new Channel(github, config.requestId, {
    self: "runner",
    isPeer: (login) => login === config.actor,
    findIssue: async () => issue.number,
});

try {
    await connect({
        config,
        channel,
        layout: stateLayout(),
        publicKey: own.publicKey,
        encrypt: (value) => encryptTo(pageKey, value),
        decrypt: <T>(payload: Encrypted) => decryptWith<T>(own.privateKey, payload),
    });
} catch (error) {
    const message = errorMessage(error);
    console.error(`::error::${message}`);
    await channel.send("error", { message }, "The runner stopped.").catch(() => {});
    process.exit(1);
}

await waitUntilDone({ idleMinutes: config.idleMinutes, maxMinutes: config.maxMinutes, startedAt });
