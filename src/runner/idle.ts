import { sleep } from "../shared/time.ts";
import { latestTranscriptActivity } from "./claude/session.ts";

/** Returns when the conversation has been idle for `idleMinutes`, or `maxMinutes` have passed since `startedAt`. */
export async function waitUntilDone(options: { idleMinutes: number; maxMinutes: number; startedAt: number }): Promise<void> {
    let lastActivity = Date.now();
    for (;;) {
        await sleep(30_000);
        lastActivity = Math.max(lastActivity, latestTranscriptActivity());
        const idle = (Date.now() - lastActivity) / 60_000;
        if (idle >= options.idleMinutes) {
            console.log(`Idle for ${idle.toFixed(1)} min; stopping.`);
            return;
        }
        if ((Date.now() - options.startedAt) / 60_000 >= options.maxMinutes) {
            console.log(`Reached the ${options.maxMinutes} min limit; stopping.`);
            return;
        }
    }
}
