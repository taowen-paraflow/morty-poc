/** Removes Claude tokens and Morty sign-in codes from text that is about to be logged or sent. */
export function redact(text: unknown): string {
    return String(text).replace(/sk-ant-[A-Za-z0-9_-]+/gu, "<token>").replace(/#code=\S+/gu, "<code>");
}
