const apply = process.argv.includes("--apply");
const apiKey = process.env.ELEVENLABS_API_KEY;
const agentId = process.env.ELEVENLABS_AGENT_ID || "agent_5501kx8wda1pendvh6xvme7fxn78";
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const phoneNumber = process.env.TWILIO_PHONE_NUMBER;
const appBaseUrl = process.env.APP_BASE_URL?.replace(/\/$/, "");

const missing = [
  ["ELEVENLABS_API_KEY", apiKey],
  ["TWILIO_ACCOUNT_SID", accountSid],
  ["TWILIO_AUTH_TOKEN", authToken],
  ["TWILIO_PHONE_NUMBER", phoneNumber],
  ["APP_BASE_URL", appBaseUrl],
].filter(([, value]) => !value).map(([name]) => name);

if (!apply) {
  console.log("Dry run only. No phone configuration changed.");
  console.log(`Agent: ${agentId}`);
  console.log(`Phone: ${phoneNumber || "<missing TWILIO_PHONE_NUMBER>"}`);
  console.log("Plan: route Twilio voice through app webhook (registration gate), keep SMS on app webhook.");
  console.log(`Missing: ${missing.length ? missing.join(", ") : "none"}`);
  console.log("Run npm run setup:phone -- --apply after review.");
  process.exit(0);
}

if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
if (!accountSid.startsWith("AC")) throw new Error("TWILIO_ACCOUNT_SID must start with AC");
if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("TWILIO_PHONE_NUMBER must use E.164 format");
if (!appBaseUrl.startsWith("https://")) throw new Error("APP_BASE_URL must be a public HTTPS URL");

async function elevenlabs(path, options = {}) {
  const response = await fetch(`https://api.elevenlabs.io/v1${path}`, {
    ...options,
    headers: { "xi-api-key": apiKey, "content-type": "application/json", ...options.headers },
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const detail = payload.detail || payload.message || payload.error;
    throw new Error(
      `ElevenLabs phone setup failed (${response.status})${detail ? `: ${JSON.stringify(detail)}` : ""}`,
    );
  }
  return payload;
}

const imported = await elevenlabs("/convai/phone-numbers", {
  method: "POST",
  body: JSON.stringify({
    provider: "twilio",
    label: "Voia Healthcare Receptionist",
    phone_number: phoneNumber,
    sid: accountSid,
    token: authToken,
    agent_id: agentId,
    enable_sms: false,
  }),
});

const phoneNumberId = imported.phone_number_id || imported.id;
if (!phoneNumberId) throw new Error("ElevenLabs import did not return phone_number_id");

const twilioAuth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
const lookupUrl = new URL(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json`);
lookupUrl.searchParams.set("PhoneNumber", phoneNumber);
const lookup = await fetch(lookupUrl, { headers: { authorization: `Basic ${twilioAuth}` } });
const lookupPayload = await lookup.json();
const incomingSid = lookupPayload.incoming_phone_numbers?.[0]?.sid;
if (!lookup.ok || !incomingSid) throw new Error("Twilio number lookup failed");

const smsConfig = new URLSearchParams({
  VoiceUrl: `${appBaseUrl}/api/webhooks/twilio/voice`,
  VoiceMethod: "POST",
  SmsUrl: `${appBaseUrl}/api/webhooks/twilio/sms`,
  SmsMethod: "POST",
});
const update = await fetch(
  `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers/${incomingSid}.json`,
  {
    method: "POST",
    headers: {
      authorization: `Basic ${twilioAuth}`,
      "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body: smsConfig,
  },
);
if (!update.ok) throw new Error(`Twilio voice/SMS webhook update failed (${update.status})`);

console.log(`Connected ${phoneNumber} voice through app registration gate to ElevenLabs agent ${agentId}.`);
console.log(`Configured Twilio Voice webhook at ${appBaseUrl}/api/webhooks/twilio/voice.`);
console.log(`Configured Twilio SMS webhook at ${appBaseUrl}/api/webhooks/twilio/sms.`);
console.log("Unregistered callers are told to register on the website before calling again.");
