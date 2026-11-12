// Workflow step: encrypt the runner state for the cache save step. Prints `packed=true|false` to GITHUB_OUTPUT.
import fs from "node:fs";
import { pack, readKey, stateLayout } from "./state.ts";

const layout = stateLayout();
const key = readKey(layout);
// Without the page's key nothing is saved, so a failed run never replaces the last good state.
const packed = key !== null && pack(layout, key);
console.log(packed ? `Packed ${fs.statSync(layout.archive).size} bytes of encrypted state.` : "No state to save.");
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `packed=${packed}\n`);
