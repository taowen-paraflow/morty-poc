// Offline checks: the page and runner halves of the encryption and message format agree, and the Claude sign-in
// driver handles the setup-token conversation (with a stand-in `claude` that behaves like setup-token).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import * as page from "../app.js";
import * as runner from "../scripts/runner-crypto.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Page key -> runner encrypts -> page decrypts.
const pageKeys = await page.createKeyPair();
const toPage = runner.encryptFor(runner.importPublicKey(pageKeys.publicKey), { url: "https://morty.build/continue#code=x" });
assert.deepEqual(await page.decryptWith(pageKeys.privateKey, toPage), { url: "https://morty.build/continue#code=x" });

// Runner key -> page encrypts -> runner decrypts.
const own = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const runnerKey = own.publicKey.export({ type: "spki", format: "der" }).toString("base64");
const toRunner = await page.encryptTo(runnerKey, { code: "abc#def" });
assert.deepEqual(runner.decryptWith(own.privateKey, toRunner), { code: "abc#def" });

// Messages written by either side parse on the other.
const meta = { type: "claude-code", request: "r-0123456789abcdef01234567", from: "page" };
assert.deepEqual(runner.parseMessage(page.formatMessage(meta, toRunner, "note")), { meta, payload: toRunner });
assert.deepEqual(page.parseMessage(runner.formatMessage({ ...meta, from: "runner" }, toPage)).payload, toPage);
assert.equal(page.parseMessage("hello"), null);
console.log("crypto and messages: ok");

// Claude sign-in driver against a stand-in setup-token.
const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
fs.writeFileSync(
    path.join(bin, "claude"),
    `#!/usr/bin/env python3
import sys, time
print("Welcome to Claude Code"); print("Browser didn't open? Use the url below to sign in")
print("https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=" + "s" * 300)
sys.stdout.write("Paste code here if prompted > "); sys.stdout.flush()
code = sys.stdin.readline().strip()
time.sleep(0.2)
ok = code == "good-code#state1"
if ok:
    # Like Ink: spaces as cursor moves, a styled token wrapped across lines, charset escapes.
    sys.stdout.write("\\x1b[32m\\u2713\\x1b[39m\\x1b(BLong-lived\\x1b[1Cauthentication\\x1b[1Ctoken\\x1b[1Ccreated!\\r\\n")
    sys.stdout.write("Your\\x1b[1COAuth\\x1b[1Ctoken\\x1b[1C(valid\\x1b[1Cfor\\x1b[1C1\\x1b[1Cyear):\\r\\n\\r\\n")
    sys.stdout.write("\\x1b[1m\\x1b[33msk-ant-oat01-" + "A" * 30 + "\\r\\n" + "B" * 20 + "\\x1b[39m\\x1b[22m\\x1b(B\\r\\n\\r\\n")
    sys.stdout.write("Store\\x1b[1Cthis\\x1b[1Ctoken\\x1b[1Csecurely.\\r\\n")
else:
    print("OAuth error: invalid_grant")
sys.stdout.flush()
time.sleep(0.5)
`,
    { mode: 0o755 },
);
const child = spawn("python3", [path.join(root, "scripts", "claude_login.py")], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    stdio: ["pipe", "pipe", "inherit"],
});
const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
const first = JSON.parse((await lines.next()).value);
assert.match(first.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?.*s{300}$/u);
child.stdin.write(`${JSON.stringify({ code: "good-code#state1" })}\n`);
const second = JSON.parse((await lines.next()).value);
assert.equal(second.token, `sk-ant-oat01-${"A".repeat(30)}${"B".repeat(20)}`);
console.log("claude sign-in driver: ok");

// State archive: what one run packs, the next restores with the same key and cannot read with another.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "state-home-"));
fs.mkdirSync(path.join(home, ".claude", "projects", "work"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "projects", "work", "s.jsonl"), "history\n");
fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "secret");
fs.mkdirSync(path.join(home, ".morty-state"));
fs.writeFileSync(path.join(home, ".morty-state", "identity"), "morty");
const stateEnv = { ...process.env, HOME: home, RUNNER_TEMP: home, MORTY_STATE_DIRECTORY: path.join(home, ".morty-state") };
const runState = (code) =>
    spawn(process.execPath, ["--input-type=module", "-e", code], { env: stateEnv, cwd: root, stdio: ["ignore", "pipe", "inherit"] });
const output = async (child) => {
    let text = "";
    for await (const chunk of child.stdout) text += chunk;
    return text.trim();
};
const stateModule = JSON.stringify(path.join(root, "scripts", "state.mjs"));
const key = crypto.randomBytes(32).toString("base64");
assert.equal(await output(runState(`import * as s from ${stateModule}; s.writeKey(${JSON.stringify(key)}); console.log(s.pack(s.readKey()));`)), "true");
fs.rmSync(path.join(home, ".claude"), { recursive: true });
fs.rmSync(path.join(home, ".morty-state"), { recursive: true });
const other = crypto.randomBytes(32).toString("base64");
assert.equal(await output(runState(`import * as s from ${stateModule}; console.log(s.unpack(Buffer.from(${JSON.stringify(other)}, "base64")));`)), "unreadable");
assert.equal(await output(runState(`import * as s from ${stateModule}; console.log(s.unpack(s.readKey()));`)), "restored");
assert.equal(fs.readFileSync(path.join(home, ".claude", "projects", "work", "s.jsonl"), "utf8"), "history\n");
assert.equal(fs.readFileSync(path.join(home, ".morty-state", "identity"), "utf8"), "morty");
assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
assert.equal(fs.readFileSync(path.join(home, "morty-poc-cache", "state.enc")).includes("history"), false);
console.log("state archive: ok");
process.exit(0);
