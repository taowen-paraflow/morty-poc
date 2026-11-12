import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pack, readKey, stateLayout, unpack, writeKey } from "../src/runner/state.ts";

test("what one run packs, the next restores with the same key and cannot read with another", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "state-home-"));
    const layout = stateLayout({ RUNNER_TEMP: home, MORTY_STATE_DIRECTORY: path.join(home, ".morty-state") }, home);
    fs.mkdirSync(path.join(home, ".claude", "projects", "work"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "projects", "work", "s.jsonl"), "history\n");
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "secret");
    fs.mkdirSync(layout.mortyState);
    fs.writeFileSync(path.join(layout.mortyState, "identity"), "morty");

    const key = writeKey(layout, crypto.randomBytes(32).toString("base64"));
    assert.deepEqual(readKey(layout), key);
    assert.equal(pack(layout, key), true);
    assert.equal(fs.readFileSync(layout.archive).includes("history"), false, "the archive is encrypted");

    fs.rmSync(path.join(home, ".claude"), { recursive: true });
    fs.rmSync(layout.mortyState, { recursive: true });
    assert.equal(unpack(layout, crypto.randomBytes(32)), "unreadable");
    assert.equal(unpack(layout, key), "restored");
    assert.equal(fs.readFileSync(path.join(home, ".claude", "projects", "work", "s.jsonl"), "utf8"), "history\n");
    assert.equal(fs.readFileSync(path.join(layout.mortyState, "identity"), "utf8"), "morty");
    assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false, "the Claude token is never archived");
});

test("without an archive there is nothing to restore, and without state nothing to save", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "state-empty-"));
    const layout = stateLayout({ RUNNER_TEMP: home }, home);
    assert.equal(unpack(layout, crypto.randomBytes(32)), "none");
    assert.equal(pack(layout, crypto.randomBytes(32)), false);
    assert.throws(() => writeKey(layout, "c2hvcnQ="), /32 bytes/u);
});
