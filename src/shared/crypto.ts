// The one encryption scheme between the launcher page and the runner: RSA-OAEP-SHA256 wraps a fresh AES-256-GCM key.
// Only WebCrypto is used, so the same code runs in browsers and in Node 24.
import { fromBase64, toBase64 } from "./base64.ts";

/** `k`: the wrapped AES key. `iv`: the GCM nonce. `c`: the ciphertext with the 16-byte tag appended. All base64. */
export interface Encrypted {
    k: string;
    iv: string;
    c: string;
}

export interface KeyPair {
    /** Base64 SPKI, safe to publish. */
    publicKey: string;
    /** Never leaves the process that created it. */
    privateKey: CryptoKey;
}

const RSA = { name: "RSA-OAEP", hash: "SHA-256" } as const;
const MINIMUM_MODULUS_BITS = 2048;

export async function createKeyPair(): Promise<KeyPair> {
    const pair = await crypto.subtle.generateKey(
        { ...RSA, modulusLength: MINIMUM_MODULUS_BITS, publicExponent: new Uint8Array([1, 0, 1]) },
        false,
        ["encrypt", "decrypt"],
    );
    return { publicKey: toBase64(await crypto.subtle.exportKey("spki", pair.publicKey)), privateKey: pair.privateKey };
}

/** Imports a peer's public key and refuses anything weaker than RSA-2048. */
export async function importPublicKey(base64: string): Promise<CryptoKey> {
    let key: CryptoKey;
    try {
        key = await crypto.subtle.importKey("spki", fromBase64(base64), RSA, false, ["encrypt"]);
    } catch {
        throw new Error("The public key must be a base64 SPKI RSA-OAEP key.");
    }
    if ((key.algorithm as RsaHashedKeyAlgorithm).modulusLength < MINIMUM_MODULUS_BITS) {
        throw new Error("The public key must be RSA with at least 2048 bits.");
    }
    return key;
}

export async function encryptTo(publicKey: string | CryptoKey, value: unknown): Promise<Encrypted> {
    const wrapper = typeof publicKey === "string" ? await importPublicKey(publicKey) : publicKey;
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
    const c = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
    const k = await crypto.subtle.encrypt(RSA, wrapper, raw);
    return { k: toBase64(k), iv: toBase64(iv), c: toBase64(c) };
}

export async function decryptWith<T>(privateKey: CryptoKey, payload: Encrypted): Promise<T> {
    const raw = await crypto.subtle.decrypt(RSA, privateKey, fromBase64(payload.k));
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(payload.iv) }, key, fromBase64(payload.c));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
}
