# CLAUDE.md

Orientation for the **Openlytic email send consumer** — a TypeScript port of `Backend.Service.Email`, scoped to outbound delivery + email tracking. It reads `app_queue` `send_email` rows written by the **`Openlytic.Backend.API.Server`** control plane (same PostgreSQL), delivers the email via **Amazon SES**, and serves the public tracking endpoints (`/email-tracking/open` pixel + `/email-tracking/click` redirect).

Deep conventions live in the API repo's docs (`.github/copilot-instructions.md`, `CLAUDE.md`, `.agents/instructions.md`) — this repo follows the same style (airbnb-base eslint, prettier no-semicolons, `src/` path alias, camelCase locals).

## Commands

```bash
npm install
cp .env.sample .env   # then point POSTGRES_URL at the same DB as the API server
npm run invoke -- <queue_id>   # local lambda invocation: feed a real queue row through `handler`
npm run invoke -- --all        # ...or all pending send_email rows
npm run lint          # eslint --quiet .
npm run typecheck     # tsc --noEmit
npm run build         # esbuild bundle → dist/index.js (lambda artifact, entry src/index.ts)
npm run dev:http -- --port 3001   # local HTTP server for the tracking endpoints (email-tracking.httpHandler)
```

- **CI (`.github/workflows/build.yml`):** PRs to `master`/`test`/`staging`/`release` run gitleaks + `npm install` + lint/typecheck/build. The repo is self-contained (no `@openlytic/*` deps) and deliberately keeps `package-lock.json` out of git (gitignored), so CI uses `npm install` rather than `npm ci`.

## How it works

- **It is a lambda, mirroring `Backend.Service.Email`.** The entry is `handler` in `src/index.ts` (deployed as a SAM function from `template.yaml`, SQS event source on the send queue **plus `HttpApi` events for `/email-tracking/open` and `/email-tracking/click`**; scheduled routes are not ported). The `{ event, queue_id, params }` envelope arrives as the SQS message body; the durable `app_queue` row is the source of truth, so the handler re-reads it from Postgres (no SQS payload trust).
- **Dev invocation:** with no SQS/localstack, `npm run invoke -- <queue_id>` synthesizes the SQS record for a real queue row (or `--all` for every pending `send_email`) and runs it through the exact `handler` the lambda executes — same as `sam local invoke`.
- **Lifecycle:** API writes `ready` → publishes to SQS → lambda claims via `processing` → SES send → `completed` (or `failed` after `MAX_RETRIES`; earlier failures re-queue with backoff `delay = retry_count * 60` s ≤ 300 s). `hold` rows are promoted to `ready` per org when a terminal row for that org+category completes (org-scoped — do not widen to a global category check).
- **On success:** `email_recipient.send_status='sent'` + `provider_message_id` + `sent_at`; `email.message_id` + `sent_at` + `queued_at` (COALESCE).
- **On failure:** pending recipients → `send_status='failed'`; retry/backoff or terminal `failed`.
- **Delivery mode** (`src/utils/simple-email-service/index.ts`): `EMAIL_DELIVERY_MODE=ses` uses `@aws-sdk/client-ses` `SendEmailCommand` (requires `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`); `stub` (default dev) logs and returns a fake `stubbed-*` MessageId so the whole pipeline runs offline. Sender address: `DEFAULT_FROM_EMAIL`.
- **Tracking** (`src/modules/email-tracking/`): at send time, when the queue envelope has `trackingEnabled !== false`, the HTML body is rewritten with **cheerio** (`<a href>` → `/email-tracking/click` with `data-gain-link-name` → `link_name`; `<img src="cid:…">` → `/email-tracking/attachment-view` with `data-gain-attachment-name` → `link_name`; open pixel appended) and `tracked_link` rows are persisted (`kind` `click`/`attachment`). The tracking endpoints verify the HMAC token, record `email_tracking_events` (deduped), and idempotently upsert the `email_analytic` projection (forward-only counters/timestamps). Open and attachment-view return a 1×1 GIF (attachment views bump `attachment_view_count`), click returns `302` to the original target.
- **Transport webhook** (`POST /email-tracking/webhook`): ingests SES/SNS notifications (`Type: Notification`, `Message` = SES JSON, or `SubscriptionConfirmation` which auto-confirms the `SubscribeURL`). Correlates on `email.message_id` = SES `mail.messageId` (stub: `stubbed-*`); unknown messageIds fail open (logged, `200`). Maps `Delivery`→`delivered`, `Bounce` (Permanent/Transient/other)→`bounce_permanent`/`bounce_transient`/`bounce_undetermined`, `Complaint`→`complaint`, `DeliveryDelay`→`delivery_delayed`, `Reject`→`reject`; records the event (`provider='ses'`, `source='transport_webhook'`) and sets the matching `email_analytic` timestamp. Signature verification (`src/modules/email-tracking/sns.helper.ts`, native RSA, no AWS SDK) runs by default; **first terminal failure wins** (bounced/complained/rejected stick; later non-terminal events only record timestamps), so bounce→reject leaves `status='bounced'` with `rejected_at` set. Disable via `SNS_WEBHOOK_SIGNATURE_VERIFICATION=false` (offline dev/E2E only).
- **Tracking tokens:** base64url(JSON) payload + HMAC-SHA256 signature over the raw token. Recipient scope (`{ email_id, recipient_email, tracking_scope: 'recipient' }`) when exactly 1 `to` and no cc/bcc, else email scope (`{ email_id, recipients[], tracking_scope: 'email' }`); clicks add `target_url` (+ optional `link_name`). Secret `EMAIL_TRACKING_SECRET` (falls back to `APPLICATION_TOKEN`) **must match the API server's `TRACKING_SECRET`**.

## Key files

- `src/index.ts` — lambda entry: routes SQS records to the SQS handler and HTTP events to the email-tracking handler.
- `src/modules/handlers/sqs/sqs.handler.ts` — SQS batch handler + `processQueueEnvelope` dispatcher (only `send_email` handled today; other events left for other consumers).
- `src/modules/handlers/http/http.handler.ts` — `email-tracking.httpHandler`: serves `GET /email-tracking/open` (pixel), `GET /email-tracking/attachment-view` (pixel), `GET /email-tracking/click` (302) and `POST /email-tracking/webhook` (SNS/SES ingestion).
- `src/modules/email-tracking/email-tracking.helper.ts` — token sign/verify, `prepareTrackedEmailBody` (cheerio link rewrite + pixel), `parseAndVerifyTrackingRequest`, pixel/redirect response builders.
- `src/modules/email-tracking/sns.helper.ts` — SNS message signature verification (string-to-sign, RSA over cert from `SigningCertURL`, cert host-locked to `*.amazonaws.com`; gated by `SNS_WEBHOOK_SIGNATURE_VERIFICATION`).
- `src/modules/email-tracking/email-tracking.service.ts` — `recordEmailTrackingEvent` (dedupe), `upsertEmailAnalytic` (idempotent projection), `persistTrackedLinks`, `trackEmailOpen`, `trackEmailClick`, `ingestTransportWebhook` (+ `processSesNotification`).
- `src/modules/email/email.service.ts` — the send flow (claim → load email+recipients → group to/cc/bcc → render tracked body → send → persist → complete/fail).
- `src/modules/app-queue/app-queue.helper.ts` — raw-pg reads/writes for `app_queue` (claim, complete, fail, requeue, promote-hold).
- `src/utils/simple-email-service/index.ts` — SES client + stub fallback.
- `src/dev-http.ts` — local HTTP server (default :3001) wired to `email-tracking.httpHandler` (reads request bodies, for webhook E2E), for offline tracking E2E.
- `template.yaml` — SAM definition (SQS event source, `HttpApi` tracking routes, env vars; deploy via `sam deploy` after `npm run build`).

## Guardrails

- Never bypass `app_queue`: only send emails referenced by a `send_email` row. Never change the `{ event, queue_id, params }` envelope without co-updating `Openlytic.Backend.API.Server`'s publisher and the docs' Queue/SQS Envelope section.
- `EMAIL_TRACKING_SECRET` must match the API server's `TRACKING_SECRET`; `EMAIL_TRACKING_BASE_URL` is the public origin the tracking links/pixel are rewritten to. Tracking errors never break the send: link rewriting/persistence and event recording fail open (swallowed + logged).
- Keep the retry/backoff and org-scoped hold-promotion semantics (`retry_count`/`delay_seconds`, `STALE_PROCESSING_MINUTES` reclaims crashed `processing` rows).
- Raw SQL is fine here (consumer is a pg utility layer) — always parameterized, never string-concatenated user input.
