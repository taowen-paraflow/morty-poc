// Packs and unpacks the runner state that carries a conversation across runs: Claude Code's history (~/.claude,
// ~/.claude.json) and the Morty identity (the Morty state directory), so every run is the same Morty computer.
//
// The Actions cache only ever holds the encrypted archive. The key comes from the launcher page, which keeps it in
// the browser; a stolen launcher token can start a runner but cannot read the history without it.
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StateLayout {
    home: string;
    /** Where the Morty identity lives (MORTY_STATE_DIRECTORY). */
    mortyState: string;
    archiveDirectory: string;
    archive: string;
    keyFile: string;
    /** Facts about the last run that are not in Claude's or Morty's own files. */
    metadataFile: string;
}

export interface Metadata {
    sessionId?: string;
}

export function stateLayout(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): StateLayout {
    const archiveDirectory = path.join(home, "morty-poc-cache");
    return {
        home,
        mortyState: env.MORTY_STATE_DIRECTORY || path.join(home, ".morty-state"),
        archiveDirectory,
        archive: path.join(archiveDirectory, "state.enc"),
        keyFile: path.join(env.RUNNER_TEMP || os.tmpdir(), "morty-poc-state.key"),
        metadataFile: path.join(home, ".morty-poc.json"),
    };
}

// Relative to $HOME. Claude's token is never stored in these: it only lives in the environment.
const EXCLUDED = [".claude/.credentials.json", ".claude/shell-snapshots", ".claude/statsig", ".claude/todos"];
const included = (layout: StateLayout): string[] => [
    ".claude",
    ".claude.json",
    path.relative(layout.home, layout.mortyState),
    path.basename(layout.metadataFile),
];

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key (32 bytes) the launcher page sent for this run, if it has arrived. */
export function readKey(layout: StateLayout): Buffer | null {
    if (!fs.existsSync(layout.keyFile)) return null;
    const key = Buffer.from(fs.readFileSync(layout.keyFile, "utf8").trim(), "base64");
    return key.length === 32 ? key : null;
}

export function writeKey(layout: StateLayout, base64: string): Buffer {
    const key = Buffer.from(base64, "base64");
    if (key.length !== 32) throw new Error("The state key must be 32 bytes.");
    fs.writeFileSync(layout.keyFile, base64, { mode: 0o600 });
    return key;
}

export type UnpackResult = "restored" | "none" | "unreadable";

/** Restores the archive from the previous run: "none" when there is no archive, "unreadable" for a wrong key or damage. */
export function unpack(layout: StateLayout, key: Buffer): UnpackResult {
    if (!fs.existsSync(layout.archive)) return "none";
    const data = fs.readFileSync(layout.archive);
    let plain: Buffer;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, IV_BYTES));
        decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
        plain = Buffer.concat([decipher.update(data.subarray(IV_BYTES, data.length - TAG_BYTES)), decipher.final()]);
    } catch {
        return "unreadable";
    }
    const result = spawnSync("tar", ["-xz", "-C", layout.home], { input: plain });
    return result.status === 0 ? "restored" : "unreadable";
}

/** Encrypts the current state into the archive; false when there is nothing to save. */
export function pack(layout: StateLayout, key: Buffer): boolean {
    const present = included(layout).filter((entry) => fs.existsSync(path.join(layout.home, entry)));
    if (present.length === 0) return false;
    const excludes = EXCLUDED.flatMap((entry) => ["--exclude", entry]);
    const result = spawnSync("tar", ["-cz", "-C", layout.home, ...excludes, ...present], { maxBuffer: 512 * 1024 * 1024 });
    if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(result.stdout), cipher.final()]);
    fs.mkdirSync(layout.archiveDirectory, { recursive: true });
    fs.writeFileSync(layout.archive, Buffer.concat([iv, body, cipher.getAuthTag()]), { mode: 0o600 });
    return true;
}

export function readMetadata(layout: StateLayout): Metadata {
    try {
        return JSON.parse(fs.readFileSync(layout.metadataFile, "utf8")) as Metadata;
    } catch {
        return {};
    }
}

export function writeMetadata(layout: StateLayout, metadata: Metadata): void {
    fs.writeFileSync(layout.metadataFile, JSON.stringify(metadata), { mode: 0o600 });
}
