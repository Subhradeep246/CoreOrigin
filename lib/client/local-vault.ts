/**
 * The Voia local vault: an encrypted IndexedDB store, browser-only.
 *
 * There is no cloud database. A patient's booking data exists in exactly one
 * place: the `voia` IndexedDB database on this one browser on this one device,
 * as a single AES-GCM ciphertext blob.
 *
 * IRREVERSIBLE BY DESIGN:
 *  - Clearing browser storage (site data, private-window close, profile reset,
 *    OS cleanup tools) destroys the record permanently.
 *  - Forgetting the unlock PIN destroys access permanently: the key is derived
 *    from the PIN and is never stored anywhere.
 * Neither case is recoverable by us, because we never hold the key or the data.
 *
 * What is stored in the clear: KDF parameters, the IV, timestamps, and the last
 * two digits of the phone number (`phoneHint`) so the unlock screen can show
 * "•••• 34". Nothing else. No phone number, no name, no health concern.
 */

import { openDB, deleteDB, type DBSchema, type IDBPDatabase } from "idb";
import type { VaultData } from "@/lib/shared/types";
import {
  decryptJson,
  deriveKey,
  encryptJson,
  newKdfParams,
  type KdfParams,
} from "./vault-crypto";

const DB_NAME = "voia";
const DB_VERSION = 1;
const STORE = "vault";
const RECORD_ID = "primary";

/** The only shape ever written to disk. Ciphertext plus non-identifying metadata. */
export type VaultRecord = {
  id: typeof RECORD_ID;
  kdf: KdfParams;
  /** Base64 AES-GCM IV for this ciphertext. */
  iv: string;
  /** Base64 AES-GCM ciphertext of the whole `VaultData` object. */
  ciphertext: string;
  createdAt: string;
  updatedAt: string;
  /** Last 2 digits of the phone number ONLY, for UI like "•••• 34". */
  phoneHint: string;
};

interface VoiaDB extends DBSchema {
  vault: {
    key: string;
    value: VaultRecord;
  };
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function assertBrowser(): void {
  if (!isBrowser()) {
    throw new Error("Local storage is only available in the browser");
  }
}

async function db(): Promise<IDBPDatabase<VoiaDB>> {
  assertBrowser();
  return openDB<VoiaDB>(DB_NAME, DB_VERSION, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "id" });
      }
    },
  });
}

async function readRecord(): Promise<VaultRecord | undefined> {
  const database = await db();
  try {
    return await database.get(STORE, RECORD_ID);
  } finally {
    database.close();
  }
}

async function writeRecord(record: VaultRecord): Promise<void> {
  const database = await db();
  try {
    await database.put(STORE, record);
  } finally {
    database.close();
  }
}

/** Last two digits of a phone number, digits only. Never more than two. */
function toPhoneHint(phone: string): string {
  const digits = phone.replace(/\D+/g, "");
  return digits.slice(-2);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** True when this device already holds a vault record. */
export async function vaultExists(): Promise<boolean> {
  if (!isBrowser()) return false;
  try {
    return (await readRecord()) !== undefined;
  } catch {
    // A blocked or unavailable IndexedDB is treated as "no vault here".
    return false;
  }
}

/**
 * Create the vault: derive a key from the PIN with the strongest available KDF,
 * encrypt the whole `VaultData`, and write the single record.
 */
export async function createVault(pin: string, data: VaultData): Promise<void> {
  assertBrowser();
  const kdf = await newKdfParams();
  const key = await deriveKey(pin, kdf);
  const { iv, ciphertext } = await encryptJson(key, data);
  const now = new Date().toISOString();
  await writeRecord({
    id: RECORD_ID,
    kdf,
    iv,
    ciphertext,
    createdAt: now,
    updatedAt: now,
    phoneHint: toPhoneHint(data.phone),
  });
}

/**
 * Unlock the vault with the PIN, returning the in-memory key and decrypted data.
 *
 * Throws the generic `Unable to unlock` for a wrong PIN, a missing record, or
 * tampered ciphertext — the caller cannot tell these apart, and neither can an
 * attacker probing the UI.
 */
export async function unlockVault(pin: string): Promise<{ key: CryptoKey; data: VaultData }> {
  assertBrowser();
  const record = await readRecord();
  if (!record) {
    throw new Error("Unable to unlock");
  }
  const key = await deriveKey(pin, record.kdf);
  const data = await decryptJson<VaultData>(key, record.iv, record.ciphertext);
  if (!data || typeof data !== "object" || data.version !== 1) {
    throw new Error("Unable to unlock");
  }
  return { key, data };
}

/**
 * Persist an updated `VaultData` using the already-unlocked key.
 *
 * Re-encrypts with a fresh IV and bumps the record's `updatedAt`. The KDF
 * parameters are preserved so the same PIN keeps working. `data` is encrypted
 * exactly as given; callers own `data.updatedAt`.
 */
export async function saveVault(key: CryptoKey, data: VaultData): Promise<void> {
  assertBrowser();
  const existing = await readRecord();
  if (!existing) {
    throw new Error("No local vault on this device");
  }
  const { iv, ciphertext } = await encryptJson(key, data);
  await writeRecord({
    ...existing,
    iv,
    ciphertext,
    updatedAt: new Date().toISOString(),
    phoneHint: toPhoneHint(data.phone),
  });
}

/** Last 2 digits of the stored phone number, or null when there is no vault. */
export async function getPhoneHint(): Promise<string | null> {
  if (!isBrowser()) return null;
  try {
    const record = await readRecord();
    return record ? record.phoneHint : null;
  } catch {
    return null;
  }
}

/**
 * "Delete this device's data": remove the record AND drop the whole `voia`
 * database, so nothing (not even empty stores or metadata) is left behind.
 * Irreversible.
 */
export async function deleteVault(): Promise<void> {
  assertBrowser();
  try {
    const database = await db();
    try {
      await database.delete(STORE, RECORD_ID);
    } finally {
      database.close();
    }
  } catch {
    // Even if the record delete fails, still try to drop the database.
  }
  await deleteDB(DB_NAME, {
    blocked() {
      // Another tab still holds a connection; the delete completes once it
      // closes. Nothing to surface to the patient here.
    },
  });
}
