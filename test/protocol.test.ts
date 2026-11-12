import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMessage, parseMessage } from "../src/shared/protocol.ts";

const request = "r-0123456789abcdef01234567";

test("a formatted message parses back", () => {
    const body = formatMessage({ type: "state", request, from: "runner" }, { restored: "none" }, "note");
    assert.deepEqual(parseMessage(body), { request, from: "runner", message: { type: "state", payload: { restored: "none" } } });
});

test("anything that is not one of our messages is ignored", () => {
    assert.equal(parseMessage("hello"), null);
    assert.equal(parseMessage(null), null);
    assert.equal(parseMessage(`<!-- morty-poc {"type":"nope","request":"${request}","from":"page"} -->\n\n\`\`\`json\n{}\n\`\`\``), null);
    assert.equal(parseMessage(`<!-- morty-poc {"type":"state","request":"${request}","from":"someone"} -->\n\n\`\`\`json\n{}\n\`\`\``), null);
    assert.equal(parseMessage(`<!-- morty-poc {"type":"state","request":"${request}","from":"page"} -->\n\n\`\`\`json\nnot json\n\`\`\``), null);
});
