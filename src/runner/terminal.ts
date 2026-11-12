// A program running in a pseudo-terminal whose screen can be read as text, the way a person would see it.
//
// Full-screen programs like Claude Code position text with cursor moves, style it and redraw lines, so their raw
// output cannot be read with a regular expression. Output is fed into a terminal emulator (xterm.js, headless) and
// the rendered screen is read instead. The pseudo-terminal comes from util-linux `script`, which needs no native
// Node module.
import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import xterm from "@xterm/headless";
import { sleep } from "../shared/time.ts";

const quote = (word: string): string => `'${word.replaceAll("'", `'\\''`)}'`;

export class TerminalProgram {
    private readonly child: ChildProcessWithoutNullStreams;
    private readonly screen: InstanceType<typeof xterm.Terminal>;
    private rendering: Promise<void> = Promise.resolve();
    private exited = false;

    constructor(command: string[], options: { env: NodeJS.ProcessEnv; columns: number; rows: number; cwd?: string }) {
        this.screen = new xterm.Terminal({ cols: options.columns, rows: options.rows, scrollback: 1000, allowProposedApi: true });
        // `script` gives the program a terminal but not a size; stty sets it before the program starts.
        const shell = `stty cols ${options.columns} rows ${options.rows}; exec ${command.map(quote).join(" ")}`;
        this.child = spawn("script", ["-qfc", shell, "/dev/null"], { env: options.env, cwd: options.cwd });
        this.child.stdout.on("data", (chunk: Buffer) => {
            this.rendering = this.rendering.then(() => new Promise<void>((resolve) => this.screen.write(chunk, resolve)));
        });
        this.child.stderr.resume();
        this.child.on("close", () => (this.exited = true));
        this.child.stdin.on("error", () => {});
    }

    /** The non-empty lines on the screen and in its scrollback, trailing spaces removed. */
    lines(): string[] {
        const buffer = this.screen.buffer.active;
        const lines: string[] = [];
        for (let index = 0; index < buffer.length; index++) {
            const line = buffer.getLine(index)?.translateToString(true).trimEnd();
            if (line) lines.push(line);
        }
        return lines;
    }

    text(): string {
        return this.lines().join("\n");
    }

    type(text: string): void {
        this.child.stdin.write(text);
    }

    /** Polls the screen text until `find` returns something other than null, the program exits, or time runs out. */
    async waitFor<T>(find: (text: string) => T | null, seconds: number): Promise<T | null> {
        const deadline = Date.now() + seconds * 1000;
        for (;;) {
            await this.rendering;
            const found = find(this.text());
            if (found !== null) return found;
            if (this.exited || Date.now() >= deadline) return null;
            await sleep(100);
        }
    }

    close(): void {
        this.child.kill("SIGTERM");
    }
}
