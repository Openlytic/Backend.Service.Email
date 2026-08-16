# CLAUDE.md

Orientation for the **Openlytic email send consumer** — a TypeScript port of `Backend.Service.Email`, scoped to outbound delivery. It reads `app_queue` `send_email` rows written by the **`Openlytic.Backend.API.Server`** control plane (same PostgreSQL) and delivers the email via **Amazon SES**.

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
```

## How it works

- **It is a lambda, mirroring `Backend.Service.Email`.** The single entry is `handler` in `src/index.ts` (deployed as a SAM function from `template.yaml`, SQS event source on the send queue; HTTP/scheduled routes are not ported). The `{ event, queue_id, params }` envelope arrives as the SQS message body; the durable `app_queue` row is the source of truth, so the handler re-reads it from Postgres (no SQS payload trust).
- **Dev invocation:** with no SQS/localstack, `npm run invoke -- <queue_id>` synthesizes the SQS record for a real queue row (or `--all` for every pending `send_email`) and runs it through the exact `handler` the lambda executes — same as `sam local invoke`.
- **Lifecycle:** API writes `ready` → publishes to SQS → lambda claims via `processing` → SES send → `completed` (or `failed` after `MAX_RETRIES`; earlier failures re-queue with backoff `delay = retry_count * 60` s ≤ 300 s). `hold` rows are promoted to `ready` per org when a terminal row for that org+category completes (org-scoped — do not widen to a global category check).
- **On success:** `email_recipient.send_status='sent'` + `provider_message_id` + `sent_at`; `email.message_id` + `sent_at` + `queued_at` (COALESCE).
- **On failure:** pending recipients → `send_status='failed'`; retry/backoff or terminal `failed`.
- **Delivery mode** (`src/utils/simple-email-service/index.ts`): `EMAIL_DELIVERY_MODE=ses` uses `@aws-sdk/client-ses` `SendEmailCommand` (requires `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`); `stub` (default dev) logs and returns a fake `stubbed-*` MessageId so the whole pipeline runs offline. Sender address: `DEFAULT_FROM_EMAIL`.

## Key files

- `src/index.ts` — lambda entry: routes to the SQS handler (HTTP/scheduled throw; not ported).
- `src/invoke.ts` — local lambda invocation (synthetic SQS record per queue row; `--all` mode).
- `src/modules/handlers/sqs/sqs.handler.ts` — SQS batch handler + `processQueueEnvelope` dispatcher (only `send_email` handled today; other events left for other consumers).
- `src/modules/email/email.service.ts` — the send flow (claim → load email+recipients → group to/cc/bcc → send → persist → complete/fail).
- `src/modules/app-queue/app-queue.helper.ts` — raw-pg reads/writes for `app_queue` (claim, complete, fail, requeue, promote-hold).
- `src/utils/simple-email-service/index.ts` — SES client + stub fallback.
- `template.yaml` — SAM definition (SQS event source, env vars; deploy via `sam deploy` after `npm run build`).

## Guardrails

- Never bypass `app_queue`: only send emails referenced by a `send_email` row. Never change the `{ event, queue_id, params }` envelope without co-updating `Openlytic.Backend.API.Server`'s publisher and the docs' Queue/SQS Envelope section.
- Keep the retry/backoff and org-scoped hold-promotion semantics (`retry_count`/`delay_seconds`, `STALE_PROCESSING_MINUTES` reclaims crashed `processing` rows).
- Raw SQL is fine here (consumer is a pg utility layer) — always parameterized, never string-concatenated user input.
