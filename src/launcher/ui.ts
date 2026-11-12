// Everything that touches the page's DOM. The launch flow talks to the user only through these functions.

export type StepName = "github" | "runner" | "claude" | "morty";
export type StepState = "" | "active" | "waiting" | "done" | "failed";

export const STEPS: readonly StepName[] = ["github", "runner", "claude", "morty"];

function element<T extends HTMLElement>(id: string): T {
    const found = document.getElementById(id);
    if (found === null) throw new Error(`The page has no #${id}.`);
    return found as T;
}

const stepElement = (name: StepName): HTMLElement => {
    const found = document.querySelector<HTMLElement>(`[data-step="${name}"]`);
    if (found === null) throw new Error(`The page has no step ${name}.`);
    return found;
};

const show = (id: string, visible: boolean): void => void element(id).classList.toggle("hidden", !visible);

export function setStep(name: StepName, state: StepState, detail = ""): void {
    const item = stepElement(name);
    item.className = `step ${state}`;
    item.querySelector(".detail")!.textContent = detail;
}

/** Marks the step that is currently working or waiting as failed; false when no step was. */
export function failActiveStep(message: string): boolean {
    const active = document.querySelector<HTMLElement>(".step.active, .step.waiting");
    if (active === null) return false;
    setStep(active.dataset.step as StepName, "failed", message);
    return true;
}

export function beginLaunch(): void {
    show("start", false);
    show("steps", true);
    for (const name of STEPS) setStep(name, "");
}

export function offerRestart(): void {
    element("start").textContent = "Start again";
    show("start", true);
}

export function onStart(handler: () => void): void {
    element("start").addEventListener("click", handler);
}

export function onStop(handler: (force: boolean) => void): void {
    element("stop").addEventListener("click", (event) => handler(event.shiftKey));
}

export function onForget(handler: () => void): void {
    element("forget").addEventListener("click", handler);
}

export function confirmAction(message: string): boolean {
    return confirm(message);
}

export function reportError(message: string): void {
    alert(message);
}

export function showRun(run: { id: number; url: string }): void {
    const link = document.createElement("a");
    link.href = run.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = `Run ${run.id}`;
    element("run-info").replaceChildren(link);
    show("stop", true);
}

export function showStopping(): void {
    element("run-info").textContent = "Stopping…";
    show("stop", false);
}

export function showForgotten(): void {
    element("forget").textContent = "Forgotten";
}

/** Shows the token form and resolves with each token the user submits, until `done` is called. */
export function promptGitHubToken(createUrl: string): { next: () => Promise<string>; done: () => void } {
    element<HTMLAnchorElement>("github-create").href = createUrl;
    show("github-action", true);
    return {
        next: () =>
            new Promise((resolve) => {
                element("github-submit").onclick = () => resolve(element<HTMLInputElement>("github-token").value.trim());
            }),
        done: () => {
            show("github-action", false);
            element<HTMLInputElement>("github-token").value = "";
        },
    };
}

/** Opens the Claude sign-in link on request and resolves with the code the user pastes. */
export function promptClaudeCode(signInUrl: string): Promise<string> {
    const url = new URL(signInUrl);
    if (url.protocol !== "https:" || !["claude.com", "claude.ai"].includes(url.hostname)) {
        throw new Error("The runner returned an unexpected sign-in link.");
    }
    show("claude-action", true);
    element("claude-open").onclick = () => void window.open(url, "_blank", "noopener");
    return new Promise((resolve) => {
        element("claude-submit").onclick = () => {
            const code = element<HTMLInputElement>("claude-code").value.trim();
            if (code === "") return;
            element<HTMLInputElement>("claude-code").value = "";
            show("claude-action", false);
            resolve(code);
        };
    });
}

export function showMortyLink(href: string): void {
    element<HTMLAnchorElement>("morty-open").href = href;
    show("morty-action", true);
}
