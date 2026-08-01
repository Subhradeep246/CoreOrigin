import assert from "node:assert/strict";
import test from "node:test";
import { appointmentRequestSchema, followUpMessageSchema, registerStartSchema, registerVerifySchema } from "../lib/validation";

const validRequest = {
  phone: "+12125550123",
  email: "patient@example.com",
  location: "Boston, MA",
  specialty: "Primary care",
  reason: "Routine annual visit",
  reasonCategory: "Primary care",
  issueKind: "new",
  insurance: "Blue Cross PPO",
  modality: "either",
  requestedDate: "2030-01-01",
  timeWindow: "morning",
  timezone: "America/New_York",
  consent: { careData: true, screening: false, sms: false },
  source: "web",
};

test("accepts a valid minimized appointment request without a name", () => {
  const parsed = appointmentRequestSchema.parse(validRequest);
  assert.equal(parsed.consent.careData, true);
  assert.equal(parsed.phone, "+12125550123");
  assert.equal(parsed.issueKind, "new");
  assert.equal("fullName" in parsed, false);
});

test("accepts continuation issue kind", () => {
  const parsed = appointmentRequestSchema.parse({ ...validRequest, issueKind: "continuation" });
  assert.equal(parsed.issueKind, "continuation");
});

test("requires issue kind", () => {
  const { issueKind: _issueKind, ...withoutKind } = validRequest;
  assert.equal(appointmentRequestSchema.safeParse(withoutKind).success, false);
});

test("requires explicit care-data consent", () => {
  assert.equal(
    appointmentRequestSchema.safeParse({
      ...validRequest,
      consent: { ...validRequest.consent, careData: false },
    }).success,
    false,
  );
});

test("requires E.164 phone format", () => {
  assert.equal(appointmentRequestSchema.safeParse({ ...validRequest, phone: "212-555-0123" }).success, false);
});

test("accepts consented follow-up message payload", () => {
  const parsed = followUpMessageSchema.parse({
    phone: "+12125550123",
    issueKind: "continuation",
    consent: { sms: true },
  });
  assert.equal(parsed.issueKind, "continuation");
  assert.equal(parsed.consent.sms, true);
});

test("rejects follow-up without SMS consent", () => {
  assert.equal(
    followUpMessageSchema.safeParse({
      phone: "+12125550123",
      issueKind: "new",
      consent: { sms: false },
    }).success,
    false,
  );
});

test("accepts registration start without a name", () => {
  const parsed = registerStartSchema.parse({
    phone: "+12125550123",
    consent: { careData: true, screening: false, sms: true },
  });
  assert.equal(parsed.phone, "+12125550123");
  assert.equal(
    registerVerifySchema.safeParse({ phone: "+12125550123", code: "123456" }).success,
    true,
  );
});
