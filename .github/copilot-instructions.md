<!-- PURPOSE: Systems-level context for GitHub Copilot (IDE completions and Web PR Reviews). -->
<!-- This file is automatically read by GitHub Copilot in both VS Code and github.com PR reviews. -->
<!-- It provides project-specific conventions, architectural patterns, and guardrails. -->

# Copilot Instructions — Openlytic Email Send Consumer

## Project Persona

This is the **Openlytic email send consumer** — the delivery worker for the Openlytic email/tracking platform. It is a TypeScript port of **Gain.IO's `Backend.Service.Email`**, scoped to outbound delivery + email tracking.

It is a **lambda** (SAM `template.yaml`): an **SQS event source** delivers the `{ event, queue_id, params }` envelope written by the API control plane (`Openlytic.Backend.API.Server`). The consumer re-reads the durable `app_queue` row from the **same PostgreSQL** (source of truth), delivers the email via **Amazon SES** (`@aws-sdk/client-ses`, or a `stub` mode for offline dev), and serves the **public tracking endpoints** (`GET /email-tracking/open` pixel, `GET /email-tracking/click` redirect, `GET /email-tracking/attachment-view`, `POST /email-tracking/webhook`).

Stack: **Node 20+, TypeScript, `pg` (raw parameterized SQL), cheerio (HTML body rewrite), `@aws-sdk/client-ses`**. No `@openlytic/*` package dependencies — the repo is self-contained.

---

## Architecture Overview

```
src/
├── index.ts                      # Lambda entry: routes SQS records → sqs.handler, HTTP events → http.handler
├── invoke.ts                     # Local dev: synthesize an SQS record from a real queue row (or --all)
├── dev-http.ts                   # Local HTTP server (:3001) wiring the tracking endpoints
├── modules/
│   ├── app-queue/app-queue.helper.ts     # raw-pg app_queue lifecycle: claim, complete, fail, requeue, promote-hold
│   ├── email/email.helper.ts              # load email + recipients
│   ├── email/email.service.ts             # THE send flow: claim → load → group to/cc/bcc → render tracked body → send → persist → complete/fail
│   └── email-tracking/
│       ├── email-tracking.helper.ts       # token sign/verify, prepareTrackedEmailBody (cheerio), request parsing, pixel/redirect builders
│       ├── email-tracking.service.ts      # recordEmailTrackingEvent (dedupe), upsertEmailAnalytic (idempotent projection), ingestTransportWebhook
│       └── sns.helper.ts                  # native SNS message signature verification (RSA over AWS cert)
├── handlers/
│   ├── sqs/sqs.handler.ts                 # SQS batch handler + processQueueEnvelope dispatcher
│   └── http/http.handler.ts               # email-tracking.httpHandler (open/click/attachment-view/webhook)
└── utils/
    ├── database.ts               # pg Pool
    ├── env.ts                    # dotenv + env/envInt/envBool helpers
    ├── logger.ts                 # module-scoped gated logger
    └── simple-email-service/     # SES SendEmailCommand + stub fallback (EMAIL_DELIVERY_MODE)
```

---

## Commands

```bash
npm install               # install (lockfile is npm; no @openlytic/* deps)
cp .env.sample .env       # first-time env setup (point POSTGRES_URL at the API server's DB)
npm run invoke -- <queue_id>   # local lambda invocation for one queue row
npm run invoke -- --all        # ...or all pending send_email rows
npm run dev:http -- --port 3001   # local HTTP server for the tracking endpoints
npm run lint              # eslint --quiet .
npm run lint-fix          # eslint --fix
npm run format            # prettier . --write
npm run typecheck         # tsc --noEmit
npm run build             # esbuild bundle → dist/index.js (lambda artifact)
```

- **CI (`.github/workflows/build.yml`):** PRs to `master`/`test`/`staging`/`release` run gitleaks + `npm install` + lint/typecheck/build. `package-lock.json` is gitignored; CI uses `npm install`.
- **husky hooks:** `pre-commit` runs `npm run lint` + lint-staged (prettier); `pre-push` runs `npm run build` (skippable via `BUILD_ON_PRE_PUSH=false` in `.env`/`.env.local`); `post-commit`/`post-merge` refresh the Graphify graph (safe no-op without graphify).

---

## Core Concepts & Conventions

### Formatting & code style (airbnb-base + prettier)

- **No semicolons**, single quotes, 2-space indent, no trailing commas, printWidth **120** (see `prettier.config.js`).
- Imports: always the `src/` path alias (tsconfig `paths` + tsx/esbuild alias), no relative `../`, no file extension.
- Locals stay **camelCase**; constants/env/DB columns are **snake_case**/UPPER_SNAKE as the source contract demands. Raw SQL uses parameterized queries — never string-concatenate user input.
- No `eslint-disable` comments exist in the codebase — fix violations properly.

### Queue lifecycle (durable `app_queue` — the source of truth)

- Envelope: `{ event, queue_id, params }` (SQS transport only; the row is truth). **Never change the envelope without co-updating `Openlytic.Backend.API.Server`'s publisher.**
- Lifecycle: API writes `ready` → publishes to SQS → lambda claims via `processing` → SES send → `completed` (or `failed` after `MAX_RETRIES`; earlier failures re-queue with backoff `delay = retry_count * 60` s ≤ 300 s).
- `hold` rows are promoted to `ready` per org when a terminal row for that **same org + category** completes — **org-scoped; do not widen to a global category check.**
- `STALE_PROCESSING_MINUTES` reclaims crashed `processing` rows. `claimQueueForProcessing` must stay atomic (conditional status update).
- **Never bypass `app_queue`:** only send emails referenced by a `send_email` row.

### Send flow (`email.service.ts`)

1. `claimQueueForProcessing(queueId)` — no-op if not claimed.
2. Load email + recipients via `getEmailWithRecipients(emailId)`.
3. Group recipients by type → `to` / `cc` / `bcc`.
4. If `trackingEnabled !== false` and body exists, rewrite the HTML with cheerio (`prepareTrackedEmailBody`): `<a href>` → `/email-tracking/click`, `<img src="cid:…">` → `/email-tracking/attachment-view`, append the open pixel. Persist `tracked_link` rows (`kind` `click`/`attachment`) and upsert the analytic (`sent`).
5. Send via `sendEmail` (SES or stub). Persist: recipient `send_status='sent'` + `provider_message_id` + `sent_at`; email `message_id` + `sent_at` + `queued_at` (COALESCE).
6. `markQueueCompleted` + `promoteNextHoldQueue` (org-scoped). Failures: pending recipients → `send_status='failed'`; retry/backoff or terminal `failed`.

### Email tracking (`email-tracking/`)

- **Tokens:** base64url(JSON) payload + HMAC-SHA256 signature over the raw token. Recipient scope (`{ email_id, recipient_email, tracking_scope: 'recipient' }`) when exactly 1 `to` and no cc/bcc, else email scope (`{ email_id, recipients[], tracking_scope: 'email' }`); clicks add `target_url` (+ optional `link_name`).
- `EMAIL_TRACKING_SECRET` **must match the API server's `TRACKING_SECRET`**; `EMAIL_TRACKING_BASE_URL` is the public origin the tracking links/pixel are rewritten to.
- The event log (`email_tracking_events`, append-only, `dedupe_key` unique) is the source of truth; `email_analytic` is the idempotent materialized projection (forward-only counters/timestamps; **first terminal failure wins** — bounced/complained/rejected stick).
- Tracking errors never break the send: link rewriting/persistence and event recording fail open (swallowed + logged).

### Transport webhook (`POST /email-tracking/webhook`)

- Ingests SES/SNS notifications (`Type: Notification`, `Message` = SES JSON, or `SubscriptionConfirmation` which auto-confirms the `SubscribeURL`).
- Correlates on `email.message_id` = SES `mail.messageId` (stub: `stubbed-*`); unknown messageIds fail open (logged, `200`).
- Maps `Delivery`→`delivered`, `Bounce` (Permanent/Transient/other)→`bounce_permanent`/`bounce_transient`/`bounce_undetermined`, `Complaint`→`complaint`, `DeliveryDelay`→`delivery_delayed`, `Reject`→`reject`.
- Signature verification (`sns.helper.ts`, native RSA, cert host-locked to `*.amazonaws.com`) runs by default; disable via `SNS_WEBHOOK_SIGNATURE_VERIFICATION=false` (offline dev/E2E only).

### Env (`src/utils/env.ts`)

Loads `.env` via dotenv. Key vars: `POSTGRES_URL` (must match the API server's DB), `EMAIL_DELIVERY_MODE` (`ses`/`stub`), `DEFAULT_FROM_EMAIL`, `MAX_RETRIES`, `STALE_PROCESSING_MINUTES`, `EMAIL_TRACKING_SECRET`, `EMAIL_TRACKING_BASE_URL`, `SNS_WEBHOOK_SIGNATURE_VERIFICATION`, `SQS_*`, AWS SES credentials.

---

## Guardrails (PR review checklist)

1. **Never bypass `app_queue`** — every send must trace back to a `send_email` row.
2. **Never change the `{ event, queue_id, params }` envelope** without co-updating the API publisher + docs.
3. Keep the **retry/backoff** and **org-scoped hold-promotion** semantics (`retry_count`/`delay_seconds`, `STALE_PROCESSING_MINUTES`).
4. `EMAIL_TRACKING_SECRET` must stay in sync with the API server's `TRACKING_SECRET`.
5. **Tracking fails open** — a tracking error must never fail the send.
6. Raw SQL must stay **parameterized**; keep `prepareTrackedEmailBody` deterministic (same input → same rewrite).
7. Keep the `src/` alias imports, no semicolons/prettier style, camelCase locals — run `npm run lint` + `npm run typecheck` on every change.