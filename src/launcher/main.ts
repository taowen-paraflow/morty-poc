import { launch } from "./flow.ts";
import type { RunnerActions } from "./runner-actions.ts";
import * as ui from "./ui.ts";
import { vault } from "./vault.ts";
import { errorMessage } from "../shared/time.ts";

let current: { actions: RunnerActions; runId: number } | null = null;

ui.onStart(() => {
    void launch({ onRun: (actions, run) => { current = { actions, runId: run.id }; ui.showRun(run); } });
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
