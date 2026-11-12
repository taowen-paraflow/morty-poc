#!/usr/bin/env node
// Stand-in for `claude setup-token`: draws the same kind of terminal output (cursor moves, styling, a token wrapped
// across lines) and accepts exactly one code.
const readline = require("node:readline");
const out = (text) => process.stdout.write(text);

out("Welcome to Claude Code\r\nBrowser didn't open? Use the url below to sign in\r\n");
out(`https://claude.com/cai/oauth/authorize?code=true&client_id=x&state=${"s".repeat(300)}\r\n`);
out("Paste code here if prompted > ");
readline.createInterface({ input: process.stdin }).once("line", (line) => {
    if (line.trim() === "good-code#state1") {
        out("\x1b[32m✓\x1b[39m\x1b(BLong-lived\x1b[1Cauthentication\x1b[1Ctoken\x1b[1Ccreated!\r\n");
        out("Your\x1b[1COAuth\x1b[1Ctoken\x1b[1C(valid\x1b[1Cfor\x1b[1C1\x1b[1Cyear):\r\n\r\n");
        out(`\x1b[1m\x1b[33msk-ant-oat01-${"A".repeat(30)}\r\n${"B".repeat(20)}\x1b[39m\x1b[22m\x1b(B\r\n\r\n`);
        out("Store\x1b[1Cthis\x1b[1Ctoken\x1b[1Csecurely.\r\n");
    } else {
        out("OAuth error: invalid_grant\r\n");
    }
    setTimeout(() => process.exit(0), 500);
});
