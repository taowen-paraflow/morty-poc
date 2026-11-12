// Browser vault: values encrypted with a non-extractable AES key that never leaves this browser's IndexedDB.

export interface VaultEntries {
    /** Fine-grained GitHub token for this repository. */
    github: { token: string };
    /** Key (base64, 32 bytes) that encrypts the conversation state cached by the runner. */
    state: { key: string };
    /** Long-lived Claude token. */
    claude: { token: string };
}

interface StoredEntry {
    iv: Uint8Array<ArrayBuffer>;
    data: ArrayBuffer;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open("morty-poc", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("vault");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function transact<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const database = await openDatabase();
    try {
        return await new Promise<T>((resolve, reject) => {
            const transaction = database.transaction("vault", mode);
            const request = run(transaction.objectStore("vault"));
            transaction.oncomplete = () => resolve(request.result);
            transaction.onerror = () => reject(transaction.error);
        });
    } finally {
        database.close();
    }
}

async function encryptionKey(): Promise<CryptoKey> {
    const existing = await transact<CryptoKey | undefined>("readonly", (store) => store.get("key"));
    if (existing) return existing;
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await transact("readwrite", (store) => store.put(key, "key"));
    return key;
}

export const vault = {
    async get<K extends keyof VaultEntries>(name: K): Promise<VaultEntries[K] | null> {
        try {
            const entry = await transact<StoredEntry | undefined>("readonly", (store) => store.get(name));
            if (!entry) return null;
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: entry.iv }, await encryptionKey(), entry.data);
            return JSON.parse(new TextDecoder().decode(plain)) as VaultEntries[K];
        } catch {
            return null;
        }
    },

    /** Passing null forgets the entry. */
    async set<K extends keyof VaultEntries>(name: K, value: VaultEntries[K] | null): Promise<void> {
        if (value === null) {
            await transact("readwrite", (store) => store.delete(name));
            return;
        }
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), new TextEncoder().encode(JSON.stringify(value)));
        await transact("readwrite", (store) => store.put({ iv, data } satisfies StoredEntry, name));
    },
};
