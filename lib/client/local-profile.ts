/**
 * In-memory unlocked-state store for the Voia local vault.
 *
 * Framework-agnostic: a plain observable object with `subscribe` / `getSnapshot`
 * so a `"use client"` component can bind to it (e.g. `useSyncExternalStore`)
 * without this module importing React.
 *
 * PRIVACY RULES ENFORCED HERE:
 *  - The decrypted `VaultData` and the `CryptoKey` live in JS memory only.
 *  - The `CryptoKey` is held in a private field and is never part of the public
 *    snapshot, so it cannot be serialized into React devtools, logs, or state.
 *  - Nothing unlocked is ever written to localStorage, sessionStorage, or a
 *    cookie. Only the encrypted IndexedDB record persists.
 *  - Inactivity, tab hiding, and page unload all drop the key.
 */

import {
  emptyVaultData,
  type ConsentState,
  type Language,
  type VaultData,
} from "@/lib/shared/types";
import {
  createVault,
  deleteVault,
  getPhoneHint,
  saveVault,
  unlockVault,
  vaultExists,
} from "./local-vault";

export type LocalProfileStatus = "loading" | "no_vault" | "locked" | "unlocked";

export type LocalProfileState = {
  status: LocalProfileStatus;
  /** Decrypted data, present only while unlocked. Memory only. */
  data: VaultData | null;
  /** Last 2 digits of the phone number, for "•••• 34" UI. */
  phoneHint: string | null;
  error: string | null;
};

/** Default inactivity window before the key is discarded. */
export const DEFAULT_INACTIVITY_MS = 5 * 60 * 1000;

const GENERIC_UNLOCK_ERROR = "Unable to unlock";

function isBrowser(): boolean {
  return typeof window !== "undefined";
}

function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export class LocalProfileStore {
  /** Never exposed. Dropped by `lock()`. */
  #key: CryptoKey | null = null;

  #state: LocalProfileState = {
    status: "loading",
    data: null,
    phoneHint: null,
    error: null,
  };

  #listeners = new Set<() => void>();

  #inactivityMs = DEFAULT_INACTIVITY_MS;

  #timer: ReturnType<typeof setTimeout> | null = null;

  #hiddenAt: number | null = null;

  #lifecycleBound = false;

  /* ---------------- subscription ---------------- */

  subscribe = (fn: () => void): (() => void) => {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  };

  getSnapshot = (): LocalProfileState => this.#state;

  #set(patch: Partial<LocalProfileState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of this.#listeners) fn();
  }

  /* ---------------- lifecycle ---------------- */

  /** Detect whether this device holds a vault. Safe to call repeatedly. */
  init = async (): Promise<void> => {
    if (!isBrowser()) return;
    this.#bindLifecycle();
    try {
      const exists = await vaultExists();
      if (!exists) {
        this.#set({ status: "no_vault", data: null, phoneHint: null, error: null });
        return;
      }
      const phoneHint = await getPhoneHint();
      // An existing vault always starts locked: the key is never persisted.
      this.#set({
        status: this.#key ? "unlocked" : "locked",
        phoneHint,
        error: null,
      });
    } catch (error) {
      this.#set({
        status: "no_vault",
        data: null,
        error: messageOf(error, "Local storage is unavailable"),
      });
    }
  };

  /**
   * Create this device's vault and leave it unlocked.
   * `careData` consent is required to hold any data at all, so it is forced on.
   */
  create = async (
    phone: string,
    pin: string,
    consent: ConsentState,
    language: Language = "en",
  ): Promise<void> => {
    if (!isBrowser()) return;
    this.#bindLifecycle();
    try {
      const data: VaultData = {
        ...emptyVaultData(phone, language),
        consent: { ...consent, careData: true },
      };
      await createVault(pin, data);
      const unlocked = await unlockVault(pin);
      this.#key = unlocked.key;
      this.#set({
        status: "unlocked",
        data: unlocked.data,
        phoneHint: await getPhoneHint(),
        error: null,
      });
      this.touch();
    } catch (error) {
      this.#key = null;
      this.#set({
        status: "no_vault",
        data: null,
        error: messageOf(error, "Could not set up local storage"),
      });
      throw error;
    }
  };

  /** Unlock with the PIN. A wrong PIN yields the generic error only. */
  unlock = async (pin: string): Promise<void> => {
    if (!isBrowser()) return;
    this.#bindLifecycle();
    try {
      const { key, data } = await unlockVault(pin);
      this.#key = key;
      this.#set({ status: "unlocked", data, error: null });
      this.touch();
    } catch {
      this.#key = null;
      this.#set({ status: "locked", data: null, error: GENERIC_UNLOCK_ERROR });
      throw new Error(GENERIC_UNLOCK_ERROR);
    }
  };

  /** Drop the key and the decrypted data. The encrypted record stays put. */
  lock = (): void => {
    this.#key = null;
    this.#clearTimer();
    this.#hiddenAt = null;
    this.#set({
      status: this.#state.status === "no_vault" ? "no_vault" : "locked",
      data: null,
      error: null,
    });
  };

  /** Apply a pure mutation to the vault data, then re-encrypt and persist it. */
  update = async (mutator: (current: VaultData) => VaultData): Promise<void> => {
    const key = this.#key;
    const current = this.#state.data;
    if (!key || !current) {
      throw new Error("Vault is locked");
    }
    const next: VaultData = {
      ...mutator(current),
      updatedAt: new Date().toISOString(),
    };
    await saveVault(key, next);
    this.#set({ status: "unlocked", data: next, phoneHint: await getPhoneHint(), error: null });
    this.touch();
  };

  /** Wipe this device's data entirely. Irreversible. */
  deleteEverything = async (): Promise<void> => {
    this.#key = null;
    this.#clearTimer();
    try {
      await deleteVault();
    } finally {
      this.#set({ status: "no_vault", data: null, phoneHint: null, error: null });
    }
  };

  /* ---------------- inactivity auto-lock ---------------- */

  /** Record patient activity and restart the inactivity countdown. */
  touch = (): void => {
    if (!isBrowser() || this.#state.status !== "unlocked") return;
    this.#hiddenAt = null;
    this.#clearTimer();
    this.#timer = setTimeout(() => {
      this.lock();
    }, this.#inactivityMs);
  };

  /** Override the auto-lock window (milliseconds). */
  setInactivityMs = (ms: number): void => {
    this.#inactivityMs = Math.max(15_000, ms);
    this.touch();
  };

  #clearTimer(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  #bindLifecycle(): void {
    if (this.#lifecycleBound || !isBrowser()) return;
    this.#lifecycleBound = true;

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        // Background timers get throttled, so also stamp the time we left.
        this.#hiddenAt = Date.now();
        return;
      }
      const hiddenAt = this.#hiddenAt;
      this.#hiddenAt = null;
      if (this.#state.status !== "unlocked") return;
      if (hiddenAt !== null && Date.now() - hiddenAt >= this.#inactivityMs) {
        this.lock();
        return;
      }
      this.touch();
    });

    // Reload / navigation away: the key must not survive into the next page.
    window.addEventListener("beforeunload", () => {
      this.lock();
    });
  }
}

/** Shared singleton: one unlocked vault per tab, in memory only. */
export const localProfile = new LocalProfileStore();

/** Reset the inactivity countdown from anywhere (input handlers, routing). */
export function touch(): void {
  localProfile.touch();
}
