// Packs and unpacks the runner state that carries a conversation across runs: Claude Code's history (~/.claude,
// ~/.claude.json) and the Morty identity (MORTY_STATE_DIRECTORY), so every run is the same Morty computer.
//
// The Actions cache only ever holds the encrypted archive. The key comes from the launcher page, which keeps it in
// the browser; a stolen launcher token can start a runner but cannot read the history without it.
//
//   node scripts/state.mjs unpack   restore the archive if one was restored from the cache and the key is known
//   node scripts/state.mjs pack     encrypt the current state into the archive for the cache save step
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = os.homedir();
export const archiveDirectory = path.join(home, "morty-poc-cache");
export const archive = path.join(archiveDirectory, "state.enc");
export const keyFile = path.join(env("RUNNER_TEMP", os.tmpdir()), "morty-poc-state.key");
export const metadataFile = path.join(home, ".morty-poc.json");
const mortyState = env("MORTY_STATE_DIRECTORY", path.join(home, ".morty-state"));
// Relative to $HOME. Claude's token is never stored in these: it only lives in the environment.
const included = [".claude", ".claude.json", path.relative(home, mortyState), path.basename(metadataFile)];
const excluded = [".claude/.credentials.json", ".claude/shell-snapshots", ".claude/statsig", ".claude/todos"];

function env(name, fallback) {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
}

export function readKey() {
    if (!fs.existsSync(keyFile)) return null;
    const key = Buffer.from(fs.readFileSync(keyFile, "utf8").trim(), "base64");
    return key.length === 32 ? key : null;
}

export function writeKey(base64) {
    if (Buffer.from(base64, "base64").length !== 32) throw new Error("The state key must be 32 bytes.");
    fs.writeFileSync(keyFile, base64, { mode: 0o600 });
}

/** Restores the archive; returns "restored", "none" (no archive) or "unreadable" (wrong key or damaged). */
export function unpack(key) {
    if (!fs.existsSync(archive)) return "none";
    const data = fs.readFileSync(archive);
    let plain;
    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
        decipher.setAuthTag(data.subarray(data.length - 16));
        plain = Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]);
    } catch {
        return "unreadable";
    }
    const result = spawnSync("tar", ["-xz", "-C", home], { input: plain });
    if (result.status !== 0) return "unreadable";
    return "restored";
}

export function pack(key) {
    const present = included.filter((entry) => fs.existsSync(path.join(home, entry)));
    if (present.length === 0) return false;
    const result = spawnSync(
        "tar",
        ["-cz", "-C", home, ...excluded.flatMap((entry) => ["--exclude", entry]), ...present],
        { maxBuffer: 512 * 1024 * 1024 },
    );
    if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(result.stdout), cipher.final()]);
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(archive, Buffer.concat([iv, body, cipher.getAuthTag()]), { mode: 0o600 });
    return true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const command = process.argv[2];
    const key = readKey();
    if (command === "pack") {
        // Without the page's key nothing is saved, so a failed run never replaces the last good state.
        const packed = key !== null && pack(key);
        console.log(packed ? `Packed ${fs.statSync(archive).size} bytes of encrypted state.` : "No state to save.");
        if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `packed=${packed}\n`);
    } else {
        throw new Error("usage: node scripts/state.mjs pack");
    }
}
