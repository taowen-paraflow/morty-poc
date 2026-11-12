// The runner's half of the page/runner encryption scheme (see app.js): RSA-OAEP-SHA256 wraps an AES-256-GCM key.
import crypto from "node:crypto";

export function importPublicKey(base64) {
    const key = crypto.createPublicKey({ key: Buffer.from(base64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) {
        throw new Error("public_key must be RSA with at least 2048 bits.");
    }
    return key;
}

export function encryptFor(publicKey, value) {
    const key = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const c = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final(), cipher.getAuthTag()]);
    const k = crypto.publicEncrypt({ key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, key);
    return { k: k.toString("base64"), iv: iv.toString("base64"), c: c.toString("base64") };
}

export function decryptWith(privateKey, payload) {
    const key = crypto.privateDecrypt(
        { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(payload.k, "base64"),
    );
    const data = Buffer.from(payload.c, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(data.subarray(data.length - 16));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString("utf8"));
}

export function formatMessage(meta, payload, note = "") {
    return `<!-- morty-poc ${JSON.stringify(meta)} -->\n${note}\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}

export function parseMessage(body) {
    const meta = body?.match(/^<!-- morty-poc (\{.*?\}) -->/u)?.[1];
    const payload = body?.match(/```json\n([\s\S]+?)\n```/u)?.[1];
    if (meta === undefined || payload === undefined) return null;
    try {
        return { meta: JSON.parse(meta), payload: JSON.parse(payload) };
    } catch {
        return null;
    }
}
