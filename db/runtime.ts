import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { ensureMemoryStore } from "./memory";
import { getEnv } from "@/lib/runtime-env";

let schemaReady: Promise<void> | null = null;
let client: Client | null = null;

export type StorageBackend = "memory" | "libsql";

export function storageBackend(): StorageBackend {
  const configured = getEnv("STORAGE_BACKEND")?.toLowerCase();
  if (configured === "memory" || configured === "libsql") return configured;
  const remoteUrl = getEnv("DATABASE_URL") ?? getEnv("TURSO_DATABASE_URL");
  return remoteUrl ? "libsql" : "memory";
}

export function usesMemoryStorage(): boolean {
  return storageBackend() === "memory";
}

function databaseUrl(): string {
  return getEnv("DATABASE_URL") ?? getEnv("TURSO_DATABASE_URL") ?? "file:.data/voia.db";
}

function databaseAuthToken(): string | undefined {
  return getEnv("DATABASE_AUTH_TOKEN") ?? getEnv("TURSO_AUTH_TOKEN");
}

export function getLibsql(): Client {
  if (!client) {
    client = createClient({
      url: databaseUrl(),
      authToken: databaseAuthToken(),
    });
  }
  return client;
}

async function addColumnIfMissing(db: Client, sql: string): Promise<void> {
  try {
    await db.execute(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column|already exists/i.test(message)) throw error;
  }
}

export async function ensureDatabase(): Promise<void> {
  if (usesMemoryStorage()) {
    await ensureMemoryStore();
    return;
  }

  if (schemaReady) return schemaReady;

  const url = databaseUrl();
  if (url.startsWith("file:")) {
    const filePath = url.replace(/^file:/, "");
    await mkdir(dirname(filePath), { recursive: true });
  }

  const db = getLibsql();
  const pending: Promise<void> = (async () => {
    try {
      await db.batch(
        [
          `CREATE TABLE IF NOT EXISTS appointment_requests (
            id TEXT PRIMARY KEY,
            patient_key TEXT NOT NULL,
            patient_initials TEXT NOT NULL,
            encrypted_contact TEXT,
            specialty TEXT NOT NULL,
            provider_id TEXT,
            provider_name TEXT,
            facility_name TEXT,
            provider_phone TEXT,
            provider_website TEXT,
            address TEXT,
            location TEXT NOT NULL,
            modality TEXT NOT NULL,
            requested_date TEXT NOT NULL,
            time_window TEXT NOT NULL,
            timezone TEXT NOT NULL,
            reason_category TEXT NOT NULL,
            insurance TEXT NOT NULL DEFAULT '',
            issue_kind TEXT NOT NULL DEFAULT 'new',
            status TEXT NOT NULL DEFAULT 'pending_provider',
            source TEXT NOT NULL DEFAULT 'web',
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          "CREATE INDEX IF NOT EXISTS appointment_patient_idx ON appointment_requests(patient_key)",
          "CREATE INDEX IF NOT EXISTS appointment_created_idx ON appointment_requests(created_at)",
          `CREATE TABLE IF NOT EXISTS consent_events (
            id TEXT PRIMARY KEY,
            patient_key TEXT NOT NULL,
            appointment_id TEXT,
            care_data_granted INTEGER NOT NULL,
            screening_granted INTEGER NOT NULL,
            sms_granted INTEGER NOT NULL,
            policy_version TEXT NOT NULL,
            channel TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          "CREATE INDEX IF NOT EXISTS consent_patient_idx ON consent_events(patient_key)",
          `CREATE TABLE IF NOT EXISTS notifications (
            id TEXT PRIMARY KEY,
            appointment_id TEXT NOT NULL,
            channel TEXT NOT NULL,
            provider_message_id TEXT,
            status TEXT NOT NULL,
            error_code TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          "CREATE INDEX IF NOT EXISTS notification_appointment_idx ON notifications(appointment_id)",
          "CREATE INDEX IF NOT EXISTS notification_provider_id_idx ON notifications(provider_message_id)",
          `CREATE TABLE IF NOT EXISTS webhook_receipts (
            id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            external_id TEXT NOT NULL,
            payload_hash TEXT NOT NULL,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          "CREATE INDEX IF NOT EXISTS webhook_external_idx ON webhook_receipts(provider, external_id)",
          `CREATE TABLE IF NOT EXISTS rate_limits (
            key TEXT PRIMARY KEY,
            count INTEGER NOT NULL,
            window_started_at INTEGER NOT NULL
          )`,
          `CREATE TABLE IF NOT EXISTS registered_patients (
            patient_key TEXT PRIMARY KEY,
            phone_hash TEXT NOT NULL UNIQUE,
            phone_last4 TEXT NOT NULL,
            encrypted_contact TEXT,
            care_data_granted INTEGER NOT NULL,
            screening_granted INTEGER NOT NULL,
            sms_granted INTEGER NOT NULL,
            policy_version TEXT NOT NULL,
            verified_at TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          "CREATE INDEX IF NOT EXISTS registered_phone_hash_idx ON registered_patients(phone_hash)",
          `CREATE TABLE IF NOT EXISTS otp_challenges (
            id TEXT PRIMARY KEY,
            phone_hash TEXT NOT NULL,
            code_hash TEXT NOT NULL,
            expires_at INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0,
            care_data_granted INTEGER NOT NULL,
            screening_granted INTEGER NOT NULL,
            sms_granted INTEGER NOT NULL,
            email TEXT,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )`,
          "CREATE INDEX IF NOT EXISTS otp_phone_hash_idx ON otp_challenges(phone_hash)",
        ],
        "write",
      );
      await addColumnIfMissing(
        db,
        "ALTER TABLE appointment_requests ADD COLUMN issue_kind TEXT NOT NULL DEFAULT 'new'",
      );
      await addColumnIfMissing(db, "ALTER TABLE appointment_requests ADD COLUMN insurance TEXT NOT NULL DEFAULT ''");
    } catch (error) {
      schemaReady = null;
      throw error;
    }
  })();

  schemaReady = pending;
  return pending;
}
