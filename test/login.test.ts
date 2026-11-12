import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { findToken, findUrl, startClaudeLogin } from "../src/runner/claude/login.ts";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-claude.cjs");
let bin = "";
let env: NodeJS.ProcessEnv = {};

before(() => {
    bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
    fs.copyFileSync(fixture, path.join(bin, "claude"));
    fs.chmodSync(path.join(bin, "claude"), 0o755);
    env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
});
after(() => fs.rmSync(bin, { recursive: true, force: true }));

test("signs in through the terminal UI and reads the wrapped token", async () => {
    const login = await startClaudeLogin(env);
    assert.match(login.url, /^https:\/\/claude\.com\/cai\/oauth\/authorize\?.*s{300}$/u);
    assert.equal(await login.complete("good-code#state1"), `sk-ant-oat01-${"A".repeat(30)}${"B".repeat(20)}`);
});

test("a wrong code is reported without leaking the sign-in link", async () => {
    const login = await startClaudeLogin(env);
    await assert.rejects(login.complete("bad-code#state1"), (error: Error) => {
        assert.match(error.message, /Claude did not issue a token/u);
        assert.doesNotMatch(error.message, /https:/u);
        return true;
    });
});

test("a code with an unexpected shape is refused before it is typed", async () => {
    const login = await startClaudeLogin(env);
    await assert.rejects(login.complete("no spaces allowed here"), /unexpected format/u);
});

test("screen parsing", () => {
    assert.equal(findUrl("x https://claude.ai/oauth/authorize?a=b y"), "https://claude.ai/oauth/authorize?a=b");
    assert.equal(findUrl("nothing here"), null);
    assert.equal(findToken("nothing here"), null);
    assert.equal(findToken(`valid for 1 year\nsk-ant-oat01-${"A".repeat(25)}\nStore this token`), `sk-ant-oat01-${"A".repeat(25)}`);
});
