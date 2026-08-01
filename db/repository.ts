import { and, desc, eq, gt, lt } from "drizzle-orm";
import { getReadyDb } from ".";
import {
  memoryDeleteOtpChallenge,
  memoryGetActiveOtpChallenge,
  memoryGetRegisteredPatientByKey,
  memoryGetRegisteredPatientByPhoneHash,
  memoryIncrementOtpAttempts,
  memoryInsertAppointment,
  memoryInsertNotification,
  memoryListAppointments,
  memoryPurgeExpiredOtpChallenges,
  memoryRecordWebhookReceipt,
  memoryReplaceOtpChallenge,
  memoryUpdateNotificationStatus,
  memoryUpsertRegisteredPatient,
} from "./memory";
import {
  appointmentRequests,
  consentEvents,
  notifications,
  otpChallenges,
  registeredPatients,
  webhookReceipts,
} from "./schema";
import { usesMemoryStorage } from "./runtime";

export type AppointmentRow = typeof appointmentRequests.$inferSelect;
export type RegisteredPatientRow = typeof registeredPatients.$inferSelect;

export async function insertAppointment(
  appointment: typeof appointmentRequests.$inferInsert,
  consent: Omit<typeof consentEvents.$inferInsert, "id" | "appointmentId">,
): Promise<AppointmentRow> {
  if (usesMemoryStorage()) {
    return memoryInsertAppointment(appointment, consent);
  }

  const db = await getReadyDb();
  await db.insert(appointmentRequests).values(appointment);
  await db.insert(consentEvents).values({
    ...consent,
    id: crypto.randomUUID(),
    appointmentId: appointment.id,
  });
  const [row] = await db
    .select()
    .from(appointmentRequests)
    .where(eq(appointmentRequests.id, appointment.id))
    .limit(1);
  if (!row) throw new Error("Appointment request could not be saved");
  return row;
}

export async function listAppointments(patientKey: string): Promise<AppointmentRow[]> {
  if (usesMemoryStorage()) {
    return memoryListAppointments(patientKey);
  }

  const db = await getReadyDb();
  return db
    .select()
    .from(appointmentRequests)
    .where(eq(appointmentRequests.patientKey, patientKey))
    .orderBy(desc(appointmentRequests.createdAt))
    .limit(20);
}

export async function insertNotification(input: {
  appointmentId: string;
  providerMessageId?: string;
  status: string;
  errorCode?: string;
  channel?: string;
}): Promise<void> {
  if (usesMemoryStorage()) {
    return memoryInsertNotification(input);
  }

  const db = await getReadyDb();
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    appointmentId: input.appointmentId,
    channel: input.channel ?? "sms",
    providerMessageId: input.providerMessageId,
    status: input.status,
    errorCode: input.errorCode,
  });
}

export async function updateNotificationStatus(input: {
  providerMessageId: string;
  status: string;
  errorCode?: string;
}): Promise<void> {
  if (usesMemoryStorage()) {
    return memoryUpdateNotificationStatus(input);
  }

  const db = await getReadyDb();
  await db
    .update(notifications)
    .set({
      status: input.status,
      errorCode: input.errorCode,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(notifications.providerMessageId, input.providerMessageId));
}

export async function recordWebhookReceipt(input: {
  provider: string;
  externalId: string;
  payloadHash: string;
  status: string;
}): Promise<boolean> {
  if (usesMemoryStorage()) {
    return memoryRecordWebhookReceipt(input);
  }

  const db = await getReadyDb();
  const id = `${input.provider}:${input.externalId}:${input.status}`;
  const rows = await db
    .insert(webhookReceipts)
    .values({ id, ...input })
    .onConflictDoNothing()
    .returning({ id: webhookReceipts.id });
  return rows.length > 0;
}

export async function replaceOtpChallenge(
  challenge: typeof otpChallenges.$inferInsert,
): Promise<void> {
  if (usesMemoryStorage()) {
    return memoryReplaceOtpChallenge(challenge);
  }
  const db = await getReadyDb();
  await db.delete(otpChallenges).where(eq(otpChallenges.phoneHash, challenge.phoneHash));
  await db.insert(otpChallenges).values(challenge);
}

export async function getActiveOtpChallenge(phoneHash: string) {
  if (usesMemoryStorage()) {
    return memoryGetActiveOtpChallenge(phoneHash);
  }
  const db = await getReadyDb();
  const now = Date.now();
  const [row] = await db
    .select()
    .from(otpChallenges)
    .where(and(eq(otpChallenges.phoneHash, phoneHash), gt(otpChallenges.expiresAt, now)))
    .orderBy(desc(otpChallenges.createdAt))
    .limit(1);
  return row ?? null;
}

export async function incrementOtpAttempts(id: string, attempts: number): Promise<void> {
  if (usesMemoryStorage()) {
    return memoryIncrementOtpAttempts(id, attempts);
  }
  const db = await getReadyDb();
  await db.update(otpChallenges).set({ attempts }).where(eq(otpChallenges.id, id));
}

export async function deleteOtpChallenge(id: string): Promise<void> {
  if (usesMemoryStorage()) {
    return memoryDeleteOtpChallenge(id);
  }
  const db = await getReadyDb();
  await db.delete(otpChallenges).where(eq(otpChallenges.id, id));
}

export async function purgeExpiredOtpChallenges(): Promise<void> {
  if (usesMemoryStorage()) {
    return memoryPurgeExpiredOtpChallenges();
  }
  const db = await getReadyDb();
  await db.delete(otpChallenges).where(lt(otpChallenges.expiresAt, Date.now()));
}

export async function upsertRegisteredPatient(
  patient: typeof registeredPatients.$inferInsert,
): Promise<RegisteredPatientRow> {
  if (usesMemoryStorage()) {
    return memoryUpsertRegisteredPatient(patient);
  }
  const db = await getReadyDb();
  await db
    .insert(registeredPatients)
    .values(patient)
    .onConflictDoUpdate({
      target: registeredPatients.patientKey,
      set: {
        phoneHash: patient.phoneHash,
        phoneLast4: patient.phoneLast4,
        encryptedContact: patient.encryptedContact,
        careDataGranted: patient.careDataGranted,
        screeningGranted: patient.screeningGranted,
        smsGranted: patient.smsGranted,
        policyVersion: patient.policyVersion,
        verifiedAt: patient.verifiedAt,
        updatedAt: new Date().toISOString(),
      },
    });
  const [row] = await db
    .select()
    .from(registeredPatients)
    .where(eq(registeredPatients.patientKey, patient.patientKey))
    .limit(1);
  if (!row) throw new Error("Registration could not be saved");
  return row;
}

export async function getRegisteredPatientByKey(patientKey: string) {
  if (usesMemoryStorage()) {
    return memoryGetRegisteredPatientByKey(patientKey);
  }
  const db = await getReadyDb();
  const [row] = await db
    .select()
    .from(registeredPatients)
    .where(eq(registeredPatients.patientKey, patientKey))
    .limit(1);
  return row ?? null;
}

export async function getRegisteredPatientByPhoneHash(phoneHash: string) {
  if (usesMemoryStorage()) {
    return memoryGetRegisteredPatientByPhoneHash(phoneHash);
  }
  const db = await getReadyDb();
  const [row] = await db
    .select()
    .from(registeredPatients)
    .where(eq(registeredPatients.phoneHash, phoneHash))
    .limit(1);
  return row ?? null;
}
