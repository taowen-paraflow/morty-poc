// The runner's half of a launch. In order:
//   1. publish the runner's public key and receive the state key; restore the last run's conversation and Morty
//      identity from the encrypted archive,
//   2. receive a saved Claude token, or sign in with the page (sign-in link out, code in),
//   3. continue the last Claude Code session (or start one),
//   4. connect to Morty as the same computer and return the encrypted continue link.
import fs from "node:fs";
import type { Channel } from "../shared/channel.ts";
import type { Encrypted } from "../shared/crypto.ts";
import type { Secrets } from "../shared/protocol.ts";
import { checkClaudeToken } from "./claude/token.ts";
import { startClaudeLogin } from "./claude/login.ts";
import { sessionExists, startClaudeSession } from "./claude/session.ts";
import type { RunnerConfig } from "./config.ts";
import { MortySetupError, setupMorty } from "./morty.ts";
import type { MortyReady } from "./morty.ts";
import { readMetadata, unpack, writeKey, writeMetadata } from "./state.ts";
import type { StateLayout } from "./state.ts";

const MINUTE = 60_000;

export interface RunnerContext {
    config: RunnerConfig;
    channel: Channel;
    layout: StateLayout;
    /** Public key to publish to the page. */
    publicKey: string;
    encrypt: (value: unknown) => Promise<Encrypted>;
    decrypt: <T>(payload: Encrypted) => Promise<T>;
}

async function restoreState(context: RunnerContext): Promise<void> {
    const { channel, layout } = context;
    const message = await channel.waitFor(["state-key"], 10 * MINUTE);
    const { key } = await context.decrypt<Secrets["state-key"]>(message.payload);
    const restored = unpack(layout, writeKey(layout, key));
    console.log(`Saved state: ${restored}.`);
    await channel.send("state", { restored }, restored === "restored" ? "Restored the last conversation." : "Starting fresh.");
}

async function signInToClaude(context: RunnerContext): Promise<string> {
    const login = await startClaudeLogin(process.env);
    await context.channel.send("claude-login", await context.encrypt({ url: login.url }), "Open the Claude sign-in link from the launcher page.");
    console.log("Waiting for the Claude sign-in code…");
    const message = await context.channel.waitFor(["claude-code"], 15 * MINUTE);
    const { code } = await context.decrypt<Secrets["claude-code"]>(message.payload);
    return await login.complete(code);
}

/** The saved token from the page if Anthropic still accepts it, otherwise one from a fresh sign-in. */
async function obtainClaudeToken(context: RunnerContext): Promise<string> {
    const { channel } = context;
    const first = await channel.waitFor(["claude-token", "claude-login-request"], 10 * MINUTE);
    if (first.type === "claude-token") {
        const { token } = await context.decrypt<Secrets["claude-token"]>(first.payload);
        const rejected = await checkClaudeToken(token);
        if (rejected === null) return token;
        console.log(rejected);
        await channel.send("claude-token-rejected", {}, "The saved Claude token no longer works; sign in again.");
        await channel.waitFor(["claude-login-request"], 10 * MINUTE);
    }
    const token = await signInToClaude(context);
    const rejected = await checkClaudeToken(token);
    if (rejected !== null) throw new Error(rejected);
    // Saved as soon as Anthropic accepts it, so a later failure does not cost another sign-in.
    await channel.send("claude-token", await context.encrypt({ token } satisfies Secrets["claude-token"]), "Save this Claude token in the launcher to skip sign-in next time.");
    return token;
}

/** Continues the session Morty already knows, so its Recent list keeps one conversation instead of growing. */
async function ensureSession(context: RunnerContext, token: string): Promise<string> {
    const metadata = readMetadata(context.layout);
    const known = metadata.sessionId !== undefined && sessionExists(metadata.sessionId) ? metadata.sessionId : null;
    const sessionId = known ?? (await startClaudeSession(context.config.workspace, token));
    writeMetadata(context.layout, { ...metadata, sessionId });
    console.log(`Claude Code session ${known === null ? "started" : "continued"}; connecting to Morty.`);
    return sessionId;
}

async function connectToMorty(context: RunnerContext, sessionId: string, claudeToken: string): Promise<MortyReady> {
    const options = { cli: context.config.mortyCli, workspace: context.config.workspace, sessionId, claudeToken };
    try {
        return await setupMorty(options);
    } catch (error) {
        if (!(error instanceof MortySetupError) || error.code !== "PROJECT_REPLACEMENT_REQUIRED") throw error;
        // The restored identity no longer opens its Morty computer: start a new one rather than replace silently.
        fs.renameSync(context.layout.mortyState, `${context.layout.mortyState}.replaced-${Date.now()}`);
        await context.channel.send("state", { restored: "identity-reset" }, "The saved Morty computer was gone; created a new one.");
        return await setupMorty(options);
    }
}

export async function connect(context: RunnerContext): Promise<void> {
    await context.channel.send("runner-key", { publicKey: context.publicKey }, "Runner is up.");
    console.log("Waiting for the page.");
    await restoreState(context);
    const token = await obtainClaudeToken(context);
    const sessionId = await ensureSession(context, token);
    const ready = await connectToMorty(context, sessionId, token);
    await context.channel.send("morty", await context.encrypt(ready satisfies Secrets["morty"]), "Morty is ready.");
    console.log(`Morty is ready. Idle limit ${context.config.idleMinutes} min, hard limit ${context.config.maxMinutes} min.`);
}

