import assert from "node:assert/strict";
import { test } from "node:test";
import { Channel } from "../src/shared/channel.ts";
import type { GitHubApi } from "../src/shared/github.ts";

const request = "r-0123456789abcdef01234567";

/** An in-memory issue: comments posted by either side show up for both, with the author's login. */
function fakeIssue() {
    const comments: { id: number; body: string; user: { login: string } }[] = [];
    let author = "";
    const api: GitHubApi = {
        async request<T>(method: string, _path: string, body?: unknown): Promise<T> {
            if (method === "POST") comments.push({ id: comments.length + 1, body: (body as { body: string }).body, user: { login: author } });
            return (method === "GET" ? [...comments] : null) as T;
        },
    };
    const side = (login: string, options: ConstructorParameters<typeof Channel>[2]) => {
        const channel = new Channel({ request: (...args) => ((author = login), api.request(...args)) }, request, options);
        return channel;
    };
    return { side };
}

test("a side only hears the other side, and only from trusted authors", async () => {
    const { side } = fakeIssue();
    const alice = side("alice", { self: "page", findIssue: async () => 1, isPeer: () => true });
    const mallory = side("mallory", { self: "page", findIssue: async () => 1, isPeer: () => true });
    const runner = side("github-actions[bot]", { self: "runner", findIssue: async () => 1, isPeer: (login) => login === "alice" });
    await mallory.send("error", { message: "forged" });
    await alice.send("claude-login-request", {});
    await runner.send("runner-key", { publicKey: "k" });
    const heard = await runner.poll();
    assert.deepEqual(heard, [{ type: "claude-login-request", payload: {} }]);
    assert.deepEqual(await runner.poll(), [], "messages are delivered once");
});

test("waitFor keeps messages of other types for a later wait", async () => {
    const { side } = fakeIssue();
    const sender = side("alice", { self: "page", findIssue: async () => 1, isPeer: () => true });
    const receiver = side("bob", { self: "runner", findIssue: async () => 1, isPeer: (login) => login === "alice" });
    await sender.send("claude-login-request", {});
    await sender.send("state", { restored: "none" });
    const first = await receiver.waitFor(["state"], 1000, 10);
    assert.equal(first.type, "state");
    const second = await receiver.waitFor(["claude-login-request"], 1000, 10);
    assert.equal(second.type, "claude-login-request");
});

test("waitFor times out", async () => {
    const { side } = fakeIssue();
    const receiver = side("bob", { self: "runner", findIssue: async () => 1, isPeer: () => true });
    await assert.rejects(receiver.waitFor(["state"], 50, 10), /Timed out waiting for state/u);
});
