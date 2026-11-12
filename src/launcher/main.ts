import { config } from "./config.ts";
import { launch } from "./flow.ts";
import { RunnerActions } from "./runner-actions.ts";
import * as ui from "./ui.ts";
import { vault } from "./vault.ts";
import { errorMessage } from "../shared/time.ts";

let current: { actions: RunnerActions; runId: number } | null = null;

function track(actions: RunnerActions, run: { id: number; url: string }): void {
    current = { actions, runId: run.id };
    ui.showRun(run);
}

/** After a reload the page no longer knows about a runner it started earlier; find it so it can still be stopped. */
async function resumeActiveRun(): Promise<void> {
    const saved = await vault.get("github");
    if (saved === null) return;
    try {
        const actions = await RunnerActions.connect(saved.token, config.repository);
        const run = await actions.activeRun();
        if (run !== null && current === null) track(actions, run);
    } catch {
        // No usable token or no network: the page works as for a first visit.
    }
}
void resumeActiveRun();

ui.onStart(() => {
    void launch({ onRun: track });
});

ui.onStop(async (force) => {
    if (current === null) return;
    const question = force ? "Force stop skips cleanup. Continue?" : "Stop the runner? Morty access from this run will be revoked.";
    if (!ui.confirmAction(question)) return;
    try {
        await current.actions.cancel(current.runId, force);
        ui.showStopping();
    } catch (error) {
        ui.reportError(errorMessage(error));
    }
});

ui.onForget(async () => {
    if (!ui.confirmAction("Forget the GitHub token, Claude sign-in and the key to saved conversations? Saved conversations become unreadable.")) return;
    await Promise.all([vault.set("github", null), vault.set("state", null), vault.set("claude", null)]);
    ui.showForgotten();
});
