export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
    let text = "";
    for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
    return btoa(text);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
}

export function randomBase64(byteCount: number): string {
    return toBase64(crypto.getRandomValues(new Uint8Array(byteCount)));
}

export function randomId(prefix: string): string {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    return `${prefix}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
