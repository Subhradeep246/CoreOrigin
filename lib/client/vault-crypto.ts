/**
 * Browser-only cryptography for the Voia local vault.
 *
 * Threat model
 * ------------
 * Patient data never leaves this device in the clear and there is no cloud
 * database. Everything the patient enters is encrypted with AES-GCM-256 using a
 * key derived from their unlock PIN. The derived `CryptoKey` lives in JS memory
 * only, is non-extractable, and is dropped on lock / reload / inactivity.
 *
 * Consequences (by design):
 *  - Forgetting the PIN means the vault is unrecoverable. There is no reset,
 *    no escrow, no recovery key held by us, because we hold nothing at all.
 *  - An attacker with the encrypted record must brute force the PIN offline,
 *    which is why key derivation is deliberately expensive (Argon2id).
 *
 * This module NEVER logs PINs, derived keys, plaintext, or ciphertext.
 */

/** Which password hashing function produced the AES key. */
export type KdfName = "argon2id" | "pbkdf2";

/**
 * Parameters needed to reproduce a key derivation. Stored alongside the
 * ciphertext so unlocking always uses the same KDF and cost settings the vault
 * was created with (upgrading the KDF would otherwise lock the patient out).
 */
export type KdfParams = {
  name: KdfName;
  /** Base64 random salt. Not secret. */
  salt: string;
  /** Argon2id time cost, or PBKDF2 iteration count. */
  iterations?: number;
  /** Argon2id memory cost in KiB. */
  memorySize?: number;
  /** Argon2id lanes. */
  parallelism?: number;
};

/**
 * Argon2id cost settings. ~64 MiB of memory per attempt is what makes offline
 * guessing of a short PIN expensive on GPUs and ASICs.
 */
export const ARGON2ID_DEFAULTS = {
  iterations: 3,
  memorySize: 65536,
  parallelism: 1,
} as const;

/**
 * PBKDF2 fallback cost.
 *
 * TRADEOFF: PBKDF2-SHA256 is memory-cheap and massively parallelizable on GPUs,
 * so it is meaningfully weaker than Argon2id against offline brute force of a
 * short PIN. It exists ONLY as a compatibility path for browsers/environments
 * where the Argon2 WebAssembly module cannot load. We push the iteration count
 * well past the OWASP floor to partly compensate, but Argon2id is always
 * preferred when available.
 */
export const PBKDF2_ITERATIONS = 600_000;

const AES_KEY_LENGTH = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const DERIVED_KEY_BYTES = 32;

/* ------------------------------------------------------------------ */
/* Environment guards                                                  */
/* ------------------------------------------------------------------ */

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.crypto !== "undefined";
}

function subtle(): SubtleCrypto {
  if (!isBrowser() || !window.crypto.subtle) {
    // Web Crypto is unavailable on the server and on insecure origins.
    throw new Error("Secure browser storage is unavailable in this context");
  }
  return window.crypto.subtle;
}

/* ------------------------------------------------------------------ */
/* Bytes and base64                                                    */
/* ------------------------------------------------------------------ */

/**
 * Bytes backed by a plain (non-shared) ArrayBuffer, which is what Web Crypto's
 * `BufferSource` parameters require under TypeScript's current DOM typings.
 */
type Bytes = Uint8Array<ArrayBuffer>;

/** Cryptographically random salt for a new vault. */
export function randomSalt(): Bytes {
  if (!isBrowser()) {
    throw new Error("Secure browser storage is unavailable in this context");
  }
  const salt = new Uint8Array(SALT_BYTES);
  window.crypto.getRandomValues(salt);
  return salt;
}

function randomIv(): Bytes {
  const iv = new Uint8Array(IV_BYTES);
  window.crypto.getRandomValues(iv);
  return iv;
}

/** Base64-encode bytes. Chunked so large payloads do not blow the call stack. */
export function toB64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    binary += String.fromCharCode(...Array.from(slice));
  }
  return btoa(binary);
}

/** Decode base64 back to bytes. */
export function fromB64(value: string): Bytes {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Best-effort scrub of a transient byte buffer (raw key material). */
function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}

/* ------------------------------------------------------------------ */
/* KDF availability probe                                              */
/* ------------------------------------------------------------------ */

let argon2Probe: Promise<boolean> | null = null;

async function argon2Available(): Promise<boolean> {
  if (!isBrowser()) return false;
  if (!argon2Probe) {
    argon2Probe = (async () => {
      try {
        const { argon2id } = await import("hash-wasm");
        // Tiny, cheap hash purely to confirm the WASM module instantiates.
        await argon2id({
          password: "probe",
          salt: new Uint8Array(SALT_BYTES),
          parallelism: 1,
          iterations: 1,
          memorySize: 8,
          hashLength: 32,
          outputType: "binary",
        });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return argon2Probe;
}

/** Which KDF this browser should use for a NEW vault. */
export async function preferredKdf(): Promise<KdfName> {
  return (await argon2Available()) ? "argon2id" : "pbkdf2";
}

/** Fresh KDF parameters for a new vault, using the strongest available KDF. */
export async function newKdfParams(): Promise<KdfParams> {
  const name = await preferredKdf();
  const salt = toB64(randomSalt());
  if (name === "argon2id") {
    return { name, salt, ...ARGON2ID_DEFAULTS };
  }
  return { name, salt, iterations: PBKDF2_ITERATIONS };
}

/* ------------------------------------------------------------------ */
/* Key derivation                                                      */
/* ------------------------------------------------------------------ */

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  try {
    return await subtle().importKey(
      "raw",
      // Copy into a plain ArrayBuffer so the caller can wipe `raw` immediately.
      raw.slice().buffer as ArrayBuffer,
      { name: "AES-GCM", length: AES_KEY_LENGTH },
      /* extractable */ false,
      ["encrypt", "decrypt"],
    );
  } finally {
    wipe(raw);
  }
}

async function deriveArgon2id(pin: string, params: KdfParams): Promise<CryptoKey> {
  const { argon2id } = await import("hash-wasm");
  const raw = await argon2id({
    password: pin,
    salt: fromB64(params.salt),
    parallelism: params.parallelism ?? ARGON2ID_DEFAULTS.parallelism,
    iterations: params.iterations ?? ARGON2ID_DEFAULTS.iterations,
    memorySize: params.memorySize ?? ARGON2ID_DEFAULTS.memorySize,
    hashLength: DERIVED_KEY_BYTES,
    outputType: "binary",
  });
  return importAesKey(new Uint8Array(raw));
}

async function derivePbkdf2(pin: string, params: KdfParams): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(pin),
    "PBKDF2",
    /* extractable */ false,
    ["deriveKey"],
  );
  // Derived directly as a non-extractable AES-GCM key: the raw bytes never
  // become visible to JS at all on this path.
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      salt: fromB64(params.salt),
      iterations: params.iterations ?? PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    /* extractable */ false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Derive the vault key from the patient's PIN.
 *
 * The returned key is non-extractable and usable only for encrypt/decrypt, so
 * it cannot be serialized out of memory by application code.
 */
export async function deriveKey(pin: string, params: KdfParams): Promise<CryptoKey> {
  if (!isBrowser()) {
    throw new Error("Secure browser storage is unavailable in this context");
  }
  if (params.name === "argon2id") {
    return deriveArgon2id(pin, params);
  }
  return derivePbkdf2(pin, params);
}

/* ------------------------------------------------------------------ */
/* Authenticated encryption                                            */
/* ------------------------------------------------------------------ */

/**
 * Encrypt a JSON-serializable value. A fresh 12-byte IV is generated for every
 * single call: reusing an IV with the same AES-GCM key is catastrophic.
 */
export async function encryptJson(
  key: CryptoKey,
  value: unknown,
): Promise<{ iv: string; ciphertext: string }> {
  const iv = randomIv();
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  try {
    const buffer = await subtle().encrypt({ name: "AES-GCM", iv }, key, plaintext);
    return { iv: toB64(iv), ciphertext: toB64(new Uint8Array(buffer)) };
  } finally {
    wipe(plaintext);
  }
}

/**
 * Decrypt and parse a previously encrypted value.
 *
 * Any failure (wrong PIN, tampering, truncation, unparseable JSON) surfaces the
 * same generic error, so a wrong PIN is indistinguishable from corruption and
 * nothing about the stored data leaks through error messages.
 */
export async function decryptJson<T>(
  key: CryptoKey,
  iv: string,
  ciphertext: string,
): Promise<T> {
  try {
    const buffer = await subtle().decrypt(
      { name: "AES-GCM", iv: fromB64(iv) },
      key,
      fromB64(ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(buffer)) as T;
  } catch {
    throw new Error("Unable to unlock");
  }
}
