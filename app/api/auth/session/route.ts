import { getRegisteredPatientByKey } from "@/db/repository";
import {
  clearSessionCookieValue,
  readSessionFromRequest,
} from "@/lib/patient-auth";

export async function GET(request: Request) {
  const session = await readSessionFromRequest(request);
  if (!session) {
    return Response.json({ registered: false }, { headers: { "cache-control": "no-store" } });
  }
  const patient = await getRegisteredPatientByKey(session.patientKey);
  if (!patient) {
    return Response.json(
      { registered: false },
      {
        headers: {
          "cache-control": "no-store",
          "set-cookie": clearSessionCookieValue(),
        },
      },
    );
  }
  return Response.json(
    {
      registered: true,
      patient: {
        phoneLast4: patient.phoneLast4,
        verifiedAt: patient.verifiedAt,
        careDataGranted: patient.careDataGranted,
        screeningGranted: patient.screeningGranted,
        smsGranted: patient.smsGranted,
      },
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function DELETE() {
  return Response.json(
    { registered: false },
    {
      headers: {
        "cache-control": "no-store",
        "set-cookie": clearSessionCookieValue(),
      },
    },
  );
}
