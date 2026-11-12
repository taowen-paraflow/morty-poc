// The launch sequence the user clicks through: GitHub token → runner → Claude sign-in → Morty link.
import type { Channel } from "../shared/channel.ts";
import { randomBase64, randomId } from "../shared/base64.ts";
import { createKeyPair, decryptWith, encryptTo } from "../shared/crypto.ts";
import type { KeyPair } from "../shared/crypto.ts";
import type { Message, Secrets } from "../shared/protocol.ts";
import { errorMessage, sleep } from "../shared/time.ts";
import { config } from "./config.ts";
import { RunnerActions, tokenTemplateUrl } from "./runner-actions.ts";
import type { RunSummary } from "./runner-actions.ts";
import * as ui from "./ui.ts";
import { vault } from "./vault.ts";

const RUNNER_START_TIMEOUT_MS = 15 * 60_000;

export interface LaunchHooks {
    /** Called as soon as the workflow run for this launch is known, so the page can offer to stop it. */
    onRun: (actions: RunnerActions, run: RunSummary) => void;
}

/** Uses the saved token, or walks the user through creating one from GitHub's pre-filled template. */
async function connectGitHub(): Promise<RunnerActions> {
    const saved = await vault.get("github");
    if (saved !== null) {
        try {
            return await RunnerActions.connect(saved.token, config.repository);
        } catch {
            await vault.set("github", null);
        }
    }
    const repositoryName = config.repository.split("/")[1];
    ui.setStep("github", "waiting", `Create a token, choose "Only select repositories" → ${repositoryName}, then paste it here.`);
    const prompt = ui.promptGitHubToken(tokenTemplateUrl(config.repository));
    for (;;) {
        const token = await prompt.next();
        if (token === "") continue;
        try {
            const actions = await RunnerActions.connect(token, config.repository);
            await vault.set("github", { token });
            prompt.done();
            return actions;
        } catch (error) {
            const reason = errorMessage(error).slice(0, 120);
            ui.setStep("github", "waiting", `That token did not work (${reason}). Check the repository and permissions, then paste again.`);
        }
    }
}

/** Throws if the runner reported an error. */
function failOnError(message: Message): void {
    if (message.type === "error") throw new Error(message.payload.message);
}

/** Dispatches the workflow and waits for the runner's public key; returns the key and the channel. */
async function startRunner(actions: RunnerActions, keys: KeyPair, hooks: LaunchHooks): Promise<{ channel: Channel; runnerKey: string }> {
    ui.setStep("runner", "active", "Dispatching the workflow…");
    const requestId = randomId("r-");
    await actions.dispatch({ request_id: requestId, public_key: keys.publicKey, idle_minutes: String(config.idleMinutes) });
    const channel = actions.channel(requestId);
    const startedAt = Date.now();
    let runFound = false;
    for (;;) {
        if (Date.now() - startedAt > RUNNER_START_TIMEOUT_MS) throw new Error("The runner did not start within 15 minutes.");
        if (!runFound) {
            const run = (await actions.runs()).find((item) => item.name.includes(requestId));
            if (run !== undefined) {
                runFound = true;
                hooks.onRun(actions, run);
            }
        }
        for (const message of await channel.poll()) {
            failOnError(message);
            if (message.type === "runner-key") return { channel, runnerKey: message.payload.publicKey };
        }
        ui.setStep("runner", "active", `Waiting for the runner… ${Math.round((Date.now() - startedAt) / 1000)}s`);
        await sleep(4000);
    }
}

/**
 * Hands the runner the key that decrypts the conversation and Morty computer saved by earlier runs. The key only
 * ever leaves this browser encrypted to the runner, so the cached state is unreadable to anyone holding just the
 * GitHub token.
 */
async function restoreState(channel: Channel, runnerKey: string): Promise<void> {
    let state = await vault.get("state");
    if (state === null) {
        state = { key: randomBase64(32) };
        await vault.set("state", state);
    }
    await channel.send("state-key", await encryptTo(runnerKey, { key: state.key } satisfies Secrets["state-key"]), "State key.");
    for (;;) {
        for (const message of await channel.poll()) {
            failOnError(message);
            if (message.type === "state") {
                const notes = { restored: "continuing your last conversation", none: "first run, starting fresh", unreadable: "saved state unreadable, starting fresh", "identity-reset": "started a new Morty computer" };
                ui.setStep("runner", "done", `Runner is up — ${notes[message.payload.restored]}`);
                return;
            }
        }
        await sleep(3000);
    }
}

/** Signs in to Claude (or reuses the saved sign-in) and waits for the runner's Morty link. */
async function signInAndConnect(channel: Channel, keys: KeyPair, runnerKey: string): Promise<Secrets["morty"]> {
    ui.setStep("claude", "active", "Checking for a saved Claude sign-in…");
    const saved = await vault.get("claude");
    let signedIn = saved !== null;
    if (saved !== null) {
        await channel.send("claude-token", await encryptTo(runnerKey, { token: saved.token } satisfies Secrets["claude-token"]), "Saved Claude sign-in.");
        ui.setStep("claude", "done", "Using your saved sign-in");
    } else {
        await channel.send("claude-login-request", {}, "Sign in to Claude.");
    }

    for (;;) {
        for (const message of await channel.poll()) {
            failOnError(message);
            switch (message.type) {
                case "claude-token-rejected":
                    signedIn = false;
                    await vault.set("claude", null);
                    ui.setStep("claude", "active", "The saved sign-in no longer works…");
                    await channel.send("claude-login-request", {}, "Sign in to Claude.");
                    break;
                case "claude-login": {
                    const { url } = await decryptWith<Secrets["claude-login"]>(keys.privateKey, message.payload);
                    ui.setStep("claude", "waiting", "Sign in, then paste the code Claude shows.");
                    const code = await ui.promptClaudeCode(url);
                    await channel.send("claude-code", await encryptTo(runnerKey, { code } satisfies Secrets["claude-code"]), "Claude sign-in code.");
                    ui.setStep("claude", "active", "Checking the sign-in…");
                    break;
                }
                case "claude-token":
                    await vault.set("claude", await decryptWith<Secrets["claude-token"]>(keys.privateKey, message.payload));
                    signedIn = true;
                    ui.setStep("claude", "done", "Signed in");
                    break;
                case "state":
                    if (message.payload.restored === "identity-reset") ui.setStep("morty", "active", "The saved Morty computer was gone; creating a new one…");
                    break;
                case "morty":
                    ui.setStep("claude", "done", "Signed in");
                    return await decryptWith<Secrets["morty"]>(keys.privateKey, message.payload);
            }
        }
        if (signedIn) ui.setStep("morty", "active", "Connecting the runner to Morty…");
        await sleep(3000);
    }
}

function showMortyLink(morty: Secrets["morty"]): void {
    const link = new URL(morty.url);
    if (link.origin !== "https://morty.build" || link.pathname !== "/continue") throw new Error("The runner returned an unexpected link.");
    ui.showMortyLink(morty.url);
    ui.setStep("morty", "done", "Open within 10 minutes; Morty keeps this browser signed in for a day.");
}

/** Runs the whole sequence; failures are shown on the step that was in progress. */
export async function launch(hooks: LaunchHooks): Promise<void> {
    ui.beginLaunch();
    try {
        ui.setStep("github", "active", "Checking GitHub access…");
        const actions = await connectGitHub();
        ui.setStep("github", "done", `Connected as ${actions.login}`);

        const keys = await createKeyPair();
        const { channel, runnerKey } = await startRunner(actions, keys, hooks);
        await restoreState(channel, runnerKey);
        const morty = await signInAndConnect(channel, keys, runnerKey);
        showMortyLink(morty);
    } catch (error) {
        const message = errorMessage(error);
        if (!ui.failActiveStep(message)) ui.reportError(message);
        ui.offerRestart();
    }
}
