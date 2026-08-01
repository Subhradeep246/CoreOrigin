import type {
  appointmentRequests,
  consentEvents,
  notifications,
  otpChallenges,
  registeredPatients,
} from "./schema";

type AppointmentRow = typeof appointmentRequests.$inferSelect;
type RegisteredPatientRow = typeof registeredPatients.$inferSelect;
type AppointmentInsert = typeof appointmentRequests.$inferInsert;
type ConsentInsert = Omit<typeof consentEvents.$inferInsert, "id" | "appointmentId">;
type OtpInsert = typeof otpChallenges.$inferInsert;
type RegisteredInsert = typeof registeredPatients.$inferInsert;
type OtpRow = typeof otpChallenges.$inferSelect;

const appointments = new Map<string, AppointmentRow>();
const consents: Array<typeof consentEvents.$inferSelect> = [];
const notificationRows: Array<typeof notifications.$inferSelect> = [];
const webhookIds = new Set<string>();
const rateLimits = new Map<string, { count: number; windowStartedAt: number }>();
const patientsByKey = new Map<string, RegisteredPatientRow>();
const patientsByPhoneHash = new Map<string, RegisteredPatientRow>();
const otpById = new Map<string, OtpRow>();

let ready = false;

export async function ensureMemoryStore(): Promise<void> {
  ready = true;
}

export function memoryStoreReady(): boolean {
  return ready;
}

export async function memoryInsertAppointment(
  appointment: AppointmentInsert,
  consent: ConsentInsert,
): Promise<AppointmentRow> {
  await ensureMemoryStore();
  const now = new Date().toISOString();
  const row: AppointmentRow = {
    ...appointment,
    encryptedContact: appointment.encryptedContact ?? null,
    providerId: appointment.providerId ?? null,
    providerName: appointment.providerName ?? null,
    facilityName: appointment.facilityName ?? null,
    providerPhone: appointment.providerPhone ?? null,
    providerWebsite: appointment.providerWebsite ?? null,
    address: appointment.address ?? null,
    issueKind: appointment.issueKind ?? "new",
    insurance: appointment.insurance ?? "",
    status: appointment.status ?? "pending_provider",
    source: appointment.source ?? "web",
    createdAt: appointment.createdAt ?? now,
    updatedAt: appointment.updatedAt ?? now,
  };
  appointments.set(row.id, row);
  consents.push({
    ...consent,
    id: crypto.randomUUID(),
    appointmentId: row.id,
    createdAt: now,
  });
  return row;
}

export async function memoryListAppointments(patientKey: string): Promise<AppointmentRow[]> {
  await ensureMemoryStore();
  return [...appointments.values()]
    .filter((row) => row.patientKey === patientKey)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20);
}

export async function memoryInsertNotification(input: {
  appointmentId: string;
  providerMessageId?: string;
  status: string;
  errorCode?: string;
  channel?: string;
}): Promise<void> {
  await ensureMemoryStore();
  const now = new Date().toISOString();
  notificationRows.push({
    id: crypto.randomUUID(),
    appointmentId: input.appointmentId,
    channel: input.channel ?? "sms",
    providerMessageId: input.providerMessageId ?? null,
    status: input.status,
    errorCode: input.errorCode ?? null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function memoryUpdateNotificationStatus(input: {
  providerMessageId: string;
  status: string;
  errorCode?: string;
}): Promise<void> {
  await ensureMemoryStore();
  const row = notificationRows.find((item) => item.providerMessageId === input.providerMessageId);
  if (!row) return;
  row.status = input.status;
  row.errorCode = input.errorCode ?? null;
  row.updatedAt = new Date().toISOString();
}

export async function memoryRecordWebhookReceipt(input: {
  provider: string;
  externalId: string;
  payloadHash: string;
  status: string;
}): Promise<boolean> {
  await ensureMemoryStore();
  const id = `${input.provider}:${input.externalId}:${input.status}`;
  if (webhookIds.has(id)) return false;
  webhookIds.add(id);
  return true;
}

export async function memoryEnforceRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; retryAfter: number }> {
  await ensureMemoryStore();
  const now = Math.floor(Date.now() / 1000);
  const resetBefore = now - windowSeconds;
  const existing = rateLimits.get(key);

  if (!existing || existing.windowStartedAt <= resetBefore) {
    rateLimits.set(key, { count: 1, windowStartedAt: now });
    return { allowed: true, retryAfter: 0 };
  }

  existing.count += 1;
  if (existing.count > limit) {
    return { allowed: false, retryAfter: Math.max(1, existing.windowStartedAt + windowSeconds - now) };
  }
  return { allowed: true, retryAfter: 0 };
}

export async function memoryReplaceOtpChallenge(challenge: OtpInsert): Promise<void> {
  await ensureMemoryStore();
  for (const [id, row] of otpById) {
    if (row.phoneHash === challenge.phoneHash) otpById.delete(id);
  }
  const now = new Date().toISOString();
  otpById.set(challenge.id, {
    ...challenge,
    attempts: challenge.attempts ?? 0,
    email: challenge.email ?? null,
    createdAt: challenge.createdAt ?? now,
  });
}

export async function memoryGetActiveOtpChallenge(phoneHash: string): Promise<OtpRow | null> {
  await ensureMemoryStore();
  const now = Date.now();
  return (
    [...otpById.values()]
      .filter((row) => row.phoneHash === phoneHash && row.expiresAt > now)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
  );
}

export async function memoryIncrementOtpAttempts(id: string, attempts: number): Promise<void> {
  await ensureMemoryStore();
  const row = otpById.get(id);
  if (row) row.attempts = attempts;
}

export async function memoryDeleteOtpChallenge(id: string): Promise<void> {
  await ensureMemoryStore();
  otpById.delete(id);
}

export async function memoryPurgeExpiredOtpChallenges(): Promise<void> {
  await ensureMemoryStore();
  const now = Date.now();
  for (const [id, row] of otpById) {
    if (row.expiresAt < now) otpById.delete(id);
  }
}

export async function memoryUpsertRegisteredPatient(
  patient: RegisteredInsert,
): Promise<RegisteredPatientRow> {
  await ensureMemoryStore();
  const now = new Date().toISOString();
  const row: RegisteredPatientRow = {
    ...patient,
    encryptedContact: patient.encryptedContact ?? null,
    createdAt: patient.createdAt ?? now,
    updatedAt: now,
  };
  patientsByKey.set(row.patientKey, row);
  patientsByPhoneHash.set(row.phoneHash, row);
  return row;
}

export async function memoryGetRegisteredPatientByKey(patientKey: string) {
  await ensureMemoryStore();
  return patientsByKey.get(patientKey) ?? null;
}

export async function memoryGetRegisteredPatientByPhoneHash(phoneHash: string) {
  await ensureMemoryStore();
  return patientsByPhoneHash.get(phoneHash) ?? null;
}
