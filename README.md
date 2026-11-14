# 💊 Remba

> A WhatsApp-based AI medication-adherence companion for patients with chronic conditions (HIV, TB, hypertension) — built for Cameroon, bilingual in English and French, and aligned with **UN SDG 3: Good Health & Well-being**.

Remba is a full conversational agent living inside WhatsApp. It sends timezone-aware dose reminders, understands natural-language check-ins (text, voice notes, and prescription photos), tracks adherence streaks, escalates repeated missed doses to a designated treatment supporter, and generates weekly adherence reports — all through an OpenAI tool-calling loop backed by a Postgres database.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🗣️ **Conversational agent** | A tool-using OpenAI agent (`gpt-4o-mini`) that can actually take actions — create, update, and cancel reminders, log doses, fetch reports — rather than just talk about them. Up to 5 model↔tool round-trips per message. |
| ⏰ **Timezone-aware reminders** | A cron loop ticks every minute, computes each patient's local time from their stored UTC offset, and dispatches dose alerts within a 10-minute catch-up window (resilient to late cron ticks, restarts, and container throttling). |
| ✅ **Dose tracking & streaks** | Every dispatched reminder creates a `PENDING` dose log. Confirming ("taken") logs it as `TAKEN` (or `TAKEN_LATE` if 1–4 h late, `SKIPPED` if > 4 h) and increments a streak; skipping or timing out resets it to zero. |
| 📸 **Prescription photo reading** | Patients send a photo of a prescription or pill box; the agent uses vision to read medication names and dosing schedules, then sets up reminders — asking for times when the label doesn't show any. |
| 🎙️ **Voice notes** | Incoming audio is downloaded from Meta, transcribed with Whisper (language-hinted), and handled exactly like a typed message. |
| 🚨 **Mentor escalation** | If a patient's last 3 dose events are all `SKIPPED` or `TAKEN_LATE`, an S.O.S. message is sent to their linked treatment supporter (mentor) asking them to check in. |
| 📊 **Weekly reports** | Every Sunday at 20:00 UTC (and on demand via "what's my report / bilan ?"), a 7-day dashboard — adherence rate, skip rate, late rate, total doses — is compiled and narrated by an LLM whose coaching tone adapts to the score (stern < 80 %, coaching 80–94 %, celebratory ≥ 95 %). |
| 🌍 **Bilingual (EN/FR)** | Language is detected at onboarding and stored per user. Every message, reminder, report, and fallback reply is generated in the patient's language. |
| 👋 **Smart onboarding** | First contact auto-creates the user: the LLM cleans the WhatsApp profile name, detects language, and sends a warm localized greeting. |
| 🫀 **Ops niceties** | Read receipts + typing indicators on inbound messages, per-user message serialization to prevent race conditions, a keep-warm self-ping cron for sleeping containers, and a health-check endpoint. |

---

## 🏗️ How it works

```
                ┌─────────────────────────────────────────────────┐
                │                  Meta WhatsApp                  │
                │               Cloud API (Graph v21)             │
                └───────────────▲───────────────┬─────────────────┘
                                │               │
                     POST /whatsapp/webhook     │  outbound messages
                                │               │
┌───────────────────────────────┴───────────────▼─────────────────────────────┐
│  NestJS app                                                                 │
│                                                                             │
│  WhatsappController ──► WhatsappService        (verify, mark read, typing)  │
│         │                                                                 │
│         ▼                                                                 │
│  MessageHandlerService                                                    │
│    ├── new user?  ──► OpenaiService.processNewUserOnboarding              │
│    │                    (language detect, name cleanup, greeting)          │
│    ├── voice note ──► WhatsappService.fetchMediaBytes                     │
│    │                 ──► OpenaiService.transcribeAudio (Whisper)          │
│    └── image?     ──► WhatsappService.fetchMediaAsDataUrl (vision input)  │
│         │                                                                 │
│         ▼                                                                 │
│  AgentService  ────────────── OpenaiService.runToolCompletion             │
│    • loads 12-msg history from Postgres                                   │
│    • builds system prompt (name, language, local time, active reminders)  │
│    • tool loop (max 5 steps) over TOOL_SCHEMAS:                           │
│        create_medication_reminders · log_dose · get_weekly_report         │
│        link_mentor · list_reminders · update_reminder · cancel_reminder   │
│    • persists the turn, sends the final reply                             │
│                                                                           │
│  SchedulerService (@nestjs/schedule)                                      │
│    • EVERY_MINUTE   — dispatch dose alerts (10-min window, 18-h dedupe)   │
│    • EVERY_MINUTE   — sweep PENDING logs older than 5 h → SKIPPED,        │
│                       reset streak, run mentor escalation check           │
│    • 0 20 * * 0     — broadcast weekly reports to all users               │
│    • */10 * * * *   — keep-warm self-ping to PRODUCTION_URL               │
│                                                                           │
│  Prisma + PostgreSQL (via @prisma/adapter-pg)                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Inbound flow:** Meta → webhook → payload extraction (text / image / audio) → onboarding or agent → tool calls mutate the database → agent composes the reply → outbound WhatsApp message.

**Reminder lifecycle:** cron creates a `PENDING` `DoseLog` and sends the alert → the patient replies → the agent calls `log_dose` → the log becomes `TAKEN` / `TAKEN_LATE` / `SKIPPED` and the streak updates → unanswered logs are auto-skipped after 5 h → 3 consecutive bad logs escalate to the mentor.

---

## 🛠️ Tech stack

- **[NestJS](https://nestjs.com) 11** (Express) with **SWC** builds — modular service architecture
- **TypeScript 5.7**, ESLint 9 + Prettier, Jest (unit + e2e)
- **[Prisma 7](https://www.prisma.io)** with the `@prisma/adapter-pg` driver adapter and **PostgreSQL**
- **[OpenAI SDK v6]** — `gpt-4o-mini` for chat/tools/vision and JSON-structured outputs, `whisper-1` for voice transcription
- **Meta WhatsApp Cloud API** — webhook verification, text/image/audio messages, media download
- **@nestjs/schedule** for cron jobs
- **Axios** for Graph API calls

---

## 📁 Project structure

```
src/
├── main.ts                        # Bootstrap + global error filter (unmasks webhook errors)
├── app.module.ts                  # Root module (config, schedule, feature modules)
├── app.controller.ts              # GET / and GET /health-check
├── prisma.service.ts              # Prisma client service
├── openai/
│   ├── openai.service.ts          # Chat tools, Whisper, onboarding, weekly review
│   └── interfaces/                # Onboarding & weekly-report types
└── modules/
    ├── whatsapp/
    │   ├── whatsapp.controller.ts     # GET/POST /whatsapp/webhook
    │   ├── whatsapp.service.ts        # Payload parsing, media, outbound sends
    │   ├── message-handler.service.ts # Routing, onboarding, voice/image handling
    │   └── interfaces/                # Meta webhook payload types
    ├── agent/
    │   ├── agent.service.ts       # The tool-using agent loop + system prompt
    │   └── tools.ts               # Tool JSON schemas + handler registry
    └── scheduler/
        ├── scheduler.service.ts   # Cron: alerts, sweeps, weekly reports, heartbeat
        └── analytics.service.ts   # 7-day metrics + report composition
prisma/
├── schema.prisma                  # User, Message, Mentor, Reminder, DoseLog
└── migrations/                    # SQL migrations
```

---

## 🚀 Getting started

### Prerequisites

- **Node.js ≥ 20** (Node 22 recommended)
- A **PostgreSQL** database (local, or a free hosted one — e.g. `npx create-db` or Supabase)
- An **OpenAI API key**
- A **Meta WhatsApp developer account** (Cloud API) — see [WhatsApp setup](#-whatsapp-cloud-api-setup) below

### 1. Install & configure

```bash
git clone <your-repo-url> remba
cd remba
npm install
cp .env.example .env        # then fill in the values
```

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (for Supabase, use the **session pooler** URL, port 5432) |
| `OPENAI_API_KEY` | Powers the agent, onboarding, Whisper, and report generation |
| `FACEBOOK_ENTRY_URL` | Graph API base, e.g. `https://graph.facebook.com/v21.0` |
| `WHATSAPP_PHONE_NUMBER_ID` | ID of your WhatsApp Business number |
| `WHATSAPP_API_TOKEN` | Permanent access token for the WhatsApp Business account |
| `WHATSAPP_VERIFY_TOKEN` | Any string you choose; must match the value in the Meta webhook config |
| `WHATSAPP_APP_SECRET` | (Optional) app secret, reserved for future signature verification |
| `PORT` | Server port (default `3000`) |
| `PRODUCTION_URL` | Public base URL used by the keep-warm self-ping cron |

### 2. Set up the database

```bash
npx prisma migrate deploy    # apply migrations
npx prisma generate          # generate the client into src/generated/prisma
```

### 3. Run

```bash
npm run start:dev            # dev server with watch mode
npm run build && npm run start:prod   # production build & serve
```

The API is now listening on `http://localhost:3000` (`GET /health-check` should return *"Remba Core Engine is running smoothly!"*).

### 4. Test

```bash
npm test                     # unit tests (jest)
npm run test:e2e             # e2e tests
npm run test:cov             # coverage
```

### Lint & format

```bash
npm run lint                 # eslint --fix
npm run format               # prettier
```

---

## 📱 WhatsApp Cloud API setup

1. Create an app at [developers.facebook.com](https://developers.facebook.com) and add the **WhatsApp** product.
2. In the WhatsApp → Configuration page, note your **Phone Number ID** and generate a **permanent access token**.
3. Point the webhook to your deployment:
   - **Callback URL:** `https://<your-domain>/whatsapp/webhook`
   - **Verify token:** the same value as `WHATSAPP_VERIFY_TOKEN`
   - Meta sends a `GET` with `hub.mode=subscribe`, `hub.verify_token`, and `hub.challenge`; Remba echoes the challenge when the token matches.
4. Subscribe to the **messages** webhook field.
5. Start chatting with your WhatsApp Business number. During development, add your phone as a recipient/test number.

> 💡 For local development, expose the server with a tunnel (e.g. `ngrok http 3000`) and use the tunnel URL as the callback URL.

---

## 🤖 Agent tools

The agent advertises these functions to the model; `AgentService` dispatches each call to a handler in `src/modules/agent/tools.ts`:

| Tool | What it does |
|---|---|
| `create_medication_reminders` | Registers one or more medication reminders; maps vague periods to 24 h times (morning → 08:00, afternoon → 13:00, evening → 19:00, night → 21:00); skips duplicates. |
| `log_dose` | Logs the latest pending dose as `TAKEN` / `TAKEN_LATE` (> 1 h) / `SKIPPED` (> 4 h, or explicit skip with a categorized reason: side effects, out of stock, forgot, other) and updates the streak. |
| `get_weekly_report` | Returns the formatted 7-day adherence report, which the agent delivers verbatim. |
| `link_mentor` | Upserts a treatment supporter and links them to the patient for escalation. |
| `list_reminders` | Lists active reminders with names, times, and streaks. |
| `update_reminder` | Reschedules an existing reminder (with collision detection) — never creates a duplicate. |
| `cancel_reminder` | Deactivates a specific reminder, or all reminders for a medication. |

---

## ⏲️ Scheduled jobs

| Schedule (UTC) | Job | Behavior |
|---|---|---|
| Every minute | Dose alerts | Fires reminders within a 10-minute window past their scheduled local time; dedupes with an 18-hour lookback so each dose alerts once. |
| Every minute | Timeout sweep | Auto-marks `PENDING` dose logs older than 5 h as `SKIPPED`, resets the streak, and checks mentor escalation. |
| Sunday 20:00 | Weekly reports | Compiles and sends the 7-day adherence report to every user. |
| Every 10 min | Heartbeat | Self-pings `PRODUCTION_URL/health-check` to keep free-tier containers awake (no-op in local dev). |

---

## 🗃️ Data model

```
User      phoneNumber (PK) · name · language (EN|FR) · timezoneOffset · mentorId?
Mentor    id (PK) · name · phoneNumber (unique)          ← one mentor, many patients
Reminder  id (PK) · medicationName · reminderTime ("08:00") · streakCount · isActive
DoseLog   id (PK) · status (PENDING | TAKEN | TAKEN_LATE | SKIPPED) · notes · timestamp
Message   id (PK) · role (user | assistant) · content · createdAt
```

- `User 1—N Reminder`, `Reminder 1—N DoseLog`, `User 1—N Message` (all cascade on delete)
- `Message` is indexed by `(userPhoneNumber, createdAt)` to make the 12-message conversation history cheap to load.

---

## 🔒 Safety & design notes

- **Not a doctor.** The system prompt forbids diagnosis or dosage changes, urges contacting a clinic for red-flag symptoms, and keeps the conversation on adherence.
- **Prompt-injection hygiene:** onboarding input is length-capped (500 chars) and stripped of control characters before reaching the model.
- **Numbers are never hallucinated:** weekly-report figures are computed in SQL/TS first; the LLM only narrates them, and the agent is instructed to relay the report verbatim.
- **Resilience:** per-user promise chains serialize concurrent messages; tool failures return structured errors the agent explains gently; every send failure has a bilingual fallback text; a global exception filter surfaces webhook errors to the console instead of swallowing them.

---

## 🗺️ Roadmap ideas

- [ ] Webhook signature verification using `WHATSAPP_APP_SECRET`
- [ ] Interactive WhatsApp buttons/lists for "TAKEN / SKIP" confirmations
- [ ] Refill (out-of-stock) alerts and adherence export for clinics
- [ ] Multi-language expansion beyond EN/FR
- [ ] Docker + deployment guide

---

## 🤝 Contributing

Issues and PRs are welcome. Please run `npm run lint`, `npm run format`, and `npm test` before submitting.

## 📄 License

MIT © [Beleke Ian](https://github.com/)
