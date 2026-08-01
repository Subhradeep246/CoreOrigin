<p align="center">
  <strong>Voia by CoinOrigin</strong><br/>
  Multilingual voice and chat care navigation
</p>

---

## Why this project exists

Healthcare access often breaks down before a patient ever reaches a clinician. People struggle to find the right specialty, understand what kind of visit they need, compare nearby options, and complete intake without repeating themselves across phone trees, forms, and portals.

**CoinOrigin** built **Voia** to close that gap. Voia is a care-navigation assistant that meets patients where they already communicate — web voice, web chat, phone, and SMS — and guides them through a safer, consent-aware path to a **pending appointment request**.

This repository is an end-to-end preview of that experience. It wires together conversational AI, provider discovery, appointment intake, consent tracking, emergency gating, and webhook-driven notifications in one deployable application.

### What Voia does

| Capability | Description |
|---|---|
| **Multilingual care navigation** | Voice and chat assistant helps patients describe needs, choose a specialty, and understand next steps |
| **Provider discovery** | Searches public provider listings by specialty and coarse location via Nimble |
| **Appointment requests** | Captures preferred date, time window, modality, and provider choice; stores a `pending_provider` request |
| **Emergency safety gate** | Detects possible stroke, cardiac, breathing, neurologic, or self-harm language and stops routine booking |
| **Consent management** | Separate care-data, screening, and SMS consents with auditable records |
| **Multi-channel access** | Web (voice + chat), Twilio voice, and Twilio SMS |
| **Medical education** | Agent can query allowlisted CDC, NIH, MedlinePlus, and WHO sources for general information |
| **Operational health** | `/api/health` reports integration readiness without exposing secrets |

### What Voia does not do

These boundaries are intentional and enforced in code and agent policy:

- **No confirmed bookings.** Requests stay `pending_provider` until a real scheduling or EHR adapter confirms availability.
- **No voice disease screening.** No validated screening model is configured; Voia must not infer disease from voice or wording.
- **No PHI in third-party search.** Patient identity, contact details, insurance, and free-text symptoms are never sent to Nimble.
- **No raw transcript or audio retention.** ElevenLabs post-call webhooks are verified and receipted; transcript content is not persisted.
- **Not production-HIPAA-ready out of the box.** Live PHI requires vendor BAAs, encryption keys, counsel-approved policies, and operational controls.

---

## Architecture

```text
                         ┌─────────────────────────────────────────┐
                         │           Patient channels              │
                         │  Web voice/chat · Phone · SMS           │
                         └───────────────┬─────────────────────────┘
                                         │
           ┌─────────────────────────────┼─────────────────────────────┐
           │                             │                             │
           v                             v                             v
  /api/elevenlabs/token          ElevenLabs native            /api/webhooks/twilio/*
  (WebRTC session)               phone integration              (signed SMS/voice/status)
           │                             │                             │
           └─────────────────────────────┼─────────────────────────────┘
                                         v
                              ElevenLabs Conversational Agent
                              (config/voia-agent-prompt.md)
                                         │
                    authenticated tools  │  emergency + consent policy
                                         v
           ┌─────────────────────────────┼─────────────────────────────┐
           │                             │                             │
           v                             v                             v
 /api/tools/providers/search   /api/tools/appointments/request   /api/tools/medical-info
           │                             │                             │
           v                             v                             v
        Nimble API                   App business logic            Allowlisted sources
     (sanitized query)            (validation, crypto, SMS)         (CDC/NIH/etc.)
                                         │
                                         v
                              libSQL / Turso (SQLite)
                    appointments · consents · notifications · webhooks · rate limits
```

### Tech stack

| Layer | Choice |
|---|---|
| Framework | [Next.js 16](https://nextjs.org/) App Router |
| Hosting | [Vercel](https://vercel.com/) |
| Database | [libSQL](https://github.com/tursodatabase/libsql) / [Turso](https://turso.tech/) with [Drizzle ORM](https://orm.drizzle.team/) |
| Voice / chat AI | [ElevenLabs Conversational AI](https://elevenlabs.io/) |
| Telephony / SMS | [Twilio](https://www.twilio.com/) |
| Provider data | [Nimble](https://nimbleway.com/) |
| UI | React 19, Tailwind CSS 4, Lucide icons |
| Validation | Zod 4 |

---

## User workflows

### Web voice or chat

1. Patient opens the landing page and accepts care-data consent (screening consent is optional and separate).
2. Patient starts a voice or chat session with the ElevenLabs agent.
3. Voia asks about symptoms, location, specialty, visit type, and scheduling preferences.
4. If emergency language is detected, routine booking stops and urgent guidance is shown.
5. Voia searches providers and presents two to four public listings.
6. After confirmation, Voia submits a pending appointment request and returns a request ID such as `VOIA-XXXXXXXXXX`.
7. Optional generic SMS receipt is sent if SMS consent was granted.

### Phone (Twilio → ElevenLabs)

1. Patient calls the configured Twilio number.
2. Call routes through ElevenLabs native phone integration.
3. The same agent policy and tools apply as on web voice.

### SMS

1. Inbound SMS hits a signed Twilio webhook.
2. Outbound receipts and status callbacks use signed webhooks and delivery tracking in D1.

### Web form (parallel path)

The UI also exposes a structured booking form that calls `POST /api/appointments` directly, sharing the same validation, emergency gate, and persistence logic as the agent tools.

---

## Agent workflow

Agent behavior is defined in [`config/voia-agent-prompt.md`](config/voia-agent-prompt.md). Priority order:

1. **Emergency safety** — stop routine flow for stroke, cardiac, breathing, neurologic, or self-harm signals
2. **Consent and privacy** — explicit care-data and SMS consent before storage or texting
3. **Care navigation** — specialty, location, modality, scheduling, provider choice
4. **Education** — short, source-grounded answers from approved medical sources only

Authenticated agent tools (require `VOIA_TOOL_SECRET`):

| Tool route | Purpose |
|---|---|
| `POST /api/tools/providers/search` | Specialty + location provider lookup |
| `POST /api/tools/appointments/request` | Create pending appointment + consent record |
| `POST /api/tools/medical-info` | Search allowlisted public health sources |
| `POST /api/tools/screenings/create` | Disabled — no validated screening backend |

---

## Security and privacy

- **Rate limiting** on public session, provider search, and appointment endpoints
- **Signed webhooks** for Twilio and ElevenLabs when secrets are configured
- **PII minimization in demo mode** — contact details discarded after request; only hashed patient key + initials stored
- **AES-256-GCM contact encryption** in `live` mode when `DATA_ENCRYPTION_KEY` is set
- **Patient key hashing** via `PII_HASH_SALT` + normalized phone/email
- **Tool authentication** via bearer token or `x-voia-tool-secret` header
- **Emergency regex gate** in [`lib/safety.ts`](lib/safety.ts) before appointment persistence

---

## Getting started

### Prerequisites

- **Node.js 22.13+**
- Accounts and API keys for ElevenLabs, Twilio, and Nimble (for full functionality)
- A [Turso](https://turso.tech/) database for production persistence on Vercel

### Local development

```bash
npm install
cp .env.example .env.local
# Fill in .env.local with your secrets (never commit this file)
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

Check integration readiness at [http://localhost:3000/api/health](http://localhost:3000/api/health).

### Environment variables

Copy [`.env.example`](.env.example) for the full list. Key groups:

| Group | Variables | Notes |
|---|---|---|
| Product | `APP_BASE_URL`, `PRODUCT_MODE`, `ELEVENLABS_AGENT_ID` | `demo` vs `live` controls contact retention |
| Database | `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | Local default: `file:.data/voia.db`; production: Turso `libsql://...` |
| ElevenLabs | `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`, `ELEVENLABS_TOOL_SECRET_ID`, `VOIA_TOOL_SECRET` | API key required for private WebRTC sessions |
| Twilio | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, `TWILIO_PHONE_NUMBER`, `TWILIO_MESSAGING_SERVICE_SID` | `AC...` is Account SID; `SK...` is API Key SID |
| Nimble | `NIMBLE_API_KEY` | Server-only provider search |
| Crypto (live) | `DATA_ENCRYPTION_KEY`, `PII_HASH_SALT` | Generate key: `openssl rand -base64 32` |

> **Credential hygiene:** Any secret shared in chat or committed to git should be rotated before production use.

### Connect the agent and phone number

Setup scripts are **dry-run by default**:

```bash
npm run setup:agent    # Preview ElevenLabs tool + prompt configuration
npm run setup:phone    # Preview Twilio number import + SMS webhook wiring
```

Apply after reviewing output and setting secure env values:

```bash
npm run setup:agent -- --apply
npm run setup:phone -- --apply
```

- `setup:agent` — creates/updates authenticated ElevenLabs webhook tools, applies the agent prompt, preserves existing tool IDs
- `setup:phone` — imports the Twilio number into ElevenLabs for native inbound voice and points inbound SMS to this app

---

## API reference

### Public routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/health` | Integration readiness and product mode |
| `POST` | `/api/elevenlabs/token` | WebRTC session token (rate-limited) |
| `POST` | `/api/providers/search` | Public provider lookup (rate-limited) |
| `POST` | `/api/appointments` | Emergency-gated appointment request (rate-limited) |

### Webhooks

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/webhooks/twilio/sms` | Inbound SMS |
| `POST` | `/api/webhooks/twilio/status` | Delivery status callbacks |
| `POST` | `/api/webhooks/twilio/voice` | Optional custom voice webhook |
| `POST` | `/api/webhooks/elevenlabs` | Signed, idempotent post-call receipt |

---

## Database

Schema: [`db/schema.ts`](db/schema.ts)

| Table | Purpose |
|---|---|
| `appointment_requests` | Pending appointment intake |
| `consent_events` | Care-data, screening, and SMS consent audit trail |
| `notifications` | SMS delivery tracking |
| `webhook_receipts` | Idempotent webhook processing |
| `rate_limits` | Per-key request throttling |

Migration SQL: [`drizzle/0000_nifty_deathstrike.sql`](drizzle/0000_nifty_deathstrike.sql)

Runtime also ensures tables via libSQL batch statements in [`db/runtime.ts`](db/runtime.ts).

```bash
npm run db:generate   # Regenerate migrations after schema changes
```

---

## Testing and quality

```bash
npm run lint
npx tsc --noEmit
npm test
```

Tests cover validation rules, emergency detection, safety messaging, and rendered HTML expectations.

---

## Deployment

### Vercel (recommended)

This project uses standard `next build` and deploys to Vercel.

1. **Link and deploy**

   ```bash
   npx vercel link
   npx vercel deploy --prod
   ```

   Or connect the GitHub repository in the Vercel dashboard for automatic deploys.

2. **Add a Turso database**

   Vercel serverless functions need a remote SQLite-compatible database. [Turso](https://turso.tech/) is the supported option:

   ```bash
   turso db create coinorigin
   turso db show coinorigin --url
   turso db tokens create coinorigin
   ```

   Add the returned values in Vercel → Project → Settings → Environment Variables:

   - `DATABASE_URL` = `libsql://...`
   - `DATABASE_AUTH_TOKEN` = Turso auth token

3. **Set production secrets**

   Add the remaining server-only variables from [`.env.example`](.env.example) in the Vercel dashboard (`ELEVENLABS_API_KEY`, `NIMBLE_API_KEY`, `VOIA_TOOL_SECRET`, Twilio credentials, etc.).

4. **Post-deploy**

   - Set `APP_BASE_URL` to your production HTTPS URL (e.g. `https://coinorigin.vercel.app`)
   - Run `npm run setup:phone -- --apply` so Twilio webhooks point at production
   - Verify `GET /api/health` returns `"status": "ok"`

---

## Production launch checklist

- [ ] Rotate any credentials that were ever exposed
- [ ] Store secrets in Vercel environment variables (or another managed secret store)
- [ ] Execute Twilio and ElevenLabs BAAs; enable ElevenLabs Zero Retention for PHI
- [ ] Set `PRODUCT_MODE=live` with `DATA_ENCRYPTION_KEY` and `PII_HASH_SALT`
- [ ] Choose HIPAA-eligible hosting, monitoring, and retention policies
- [ ] Complete A2P 10DLC or toll-free verification for SMS
- [ ] Implement STOP / START / HELP handling and geo-permissions
- [ ] Add patient authentication (OTP) before exposing history
- [ ] Integrate a real scheduling / FHIR / EHR adapter before marking appointments confirmed
- [ ] Replace preview privacy and terms copy with counsel-approved policies
- [ ] Complete clinical and legal review before enabling any screening feature

---

## Project structure

```text
app/                  # Next.js App Router pages and API routes
  components/         # VoiaExperience UI (voice, chat, booking form)
  api/                # Public APIs, agent tools, and webhooks
config/               # ElevenLabs agent system prompt
db/                   # Drizzle schema, repository, D1 runtime helpers
drizzle/              # SQL migrations
lib/                  # Business logic (appointments, safety, twilio, nimble, crypto)
scripts/              # ElevenLabs + Twilio setup automation
tests/                # Unit and integration tests
```

---

## License

Private preview — CoinOrigin. Not licensed for redistribution without permission.
