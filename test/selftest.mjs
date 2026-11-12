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
print("Your OAuth token (valid for 1 year):") if code == "good-code#state1" else print("OAuth error")
print("sk-ant-oat01-" + "A" * 40) if code == "good-code#state1" else None
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
assert.equal(second.token, `sk-ant-oat01-${"A".repeat(40)}`);
console.log("claude sign-in driver: ok");
process.exit(0);
