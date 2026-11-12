import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import { test } from "node:test";
import { fromBase64, toBase64 } from "../src/shared/base64.ts";
import { createKeyPair, decryptWith, encryptTo, importPublicKey } from "../src/shared/crypto.ts";

test("a value encrypted to a public key decrypts with the private key", async () => {
    const keys = await createKeyPair();
    const encrypted = await encryptTo(keys.publicKey, { url: "https://morty.build/continue#code=x" });
    assert.deepEqual(await decryptWith(keys.privateKey, encrypted), { url: "https://morty.build/continue#code=x" });
});

test("another private key cannot decrypt", async () => {
    const [keys, other] = [await createKeyPair(), await createKeyPair()];
    await assert.rejects(decryptWith(other.privateKey, await encryptTo(keys.publicKey, { secret: 1 })));
});

test("a tampered ciphertext is rejected", async () => {
    const keys = await createKeyPair();
    const encrypted = await encryptTo(keys.publicKey, { secret: 1 });
    const bytes = fromBase64(encrypted.c);
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    await assert.rejects(decryptWith(keys.privateKey, { ...encrypted, c: toBase64(bytes) }));
});

test("keys weaker than RSA-2048 are refused", async () => {
    const weak = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = weak.publicKey.export({ type: "spki", format: "der" }).toString("base64");
    await assert.rejects(importPublicKey(spki), /2048/u);
    await assert.rejects(importPublicKey("not a key"), /public key/u);
});

// The wire format is what the previous node:crypto implementation produced; saved state and an older page or
// runner must stay readable, so it is pinned here against node:crypto directly.
test("the wire format is RSA-OAEP-SHA256 around AES-256-GCM with the tag appended", async () => {
    const keys = await createKeyPair();
    const aes = nodeCrypto.randomBytes(32);
    const iv = nodeCrypto.randomBytes(12);
    const cipher = nodeCrypto.createCipheriv("aes-256-gcm", aes, iv);
    const c = Buffer.concat([cipher.update(JSON.stringify({ code: "abc#def" })), cipher.final(), cipher.getAuthTag()]);
    const wrapped = nodeCrypto.publicEncrypt(
        { key: nodeCrypto.createPublicKey({ key: Buffer.from(keys.publicKey, "base64"), format: "der", type: "spki" }), padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        aes,
    );
    const legacy = { k: wrapped.toString("base64"), iv: iv.toString("base64"), c: c.toString("base64") };
    assert.deepEqual(await decryptWith(keys.privateKey, legacy), { code: "abc#def" });
});
