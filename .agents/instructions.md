<!-- PURPOSE: Behavioral and planning rules for Antigravity Agent Manager and autonomous coding agents. -->
<!-- This file governs how AI agents plan, execute, and validate multi-file changes in this repository. -->
<!-- Agents MUST read and follow .github/copilot-instructions.md for all style and architectural rules. -->

# Agent Instructions — Openlytic Email Send Consumer

## Knowledge Inheritance

**Before performing any code generation or modification, agents MUST read and internalize the rules in `.github/copilot-instructions.md`.** That file is the single source of truth for:

- Formatting rules (no semicolons, single quotes, 2-space indent, no trailing commas, printWidth 120)
- Naming conventions (file names, variables, constants, DB columns)
- Import rules (absolute `src/` imports only, no extension)
- Queue / SQS envelope conventions (`{ event, queue_id, params }`)
- Raw SQL conventions (parameterized only, never string-concatenated input)
- Retry/backoff and org-scoped hold-promotion semantics

**If any instruction below conflicts with `.github/copilot-instructions.md`, the copilot-instructions file takes precedence.**

---

## The Planning Protocol

### Mandatory Plan-Before-Edit Rule

For any task that modifies **2 or more files**, the agent MUST output a structured plan in Markdown and wait for user approval before executing changes.

### Plan Format

```markdown
## Change Plan: [Brief Description]

### Affected Files

| #   | File Path                                 | Action | Summary                          |
| --- | ----------------------------------------- | ------ | -------------------------------- |
| 1   | src/modules/email/email.service.ts        | MODIFY | Add X step to the send flow      |
| 2   | src/modules/email-tracking/email-tracking.helper.ts | MODIFY | New token field                |

### Dependency Order

1. Helper (data access / shared builders)
2. Service (send / tracking business logic)
3. Handler (SQS / HTTP wiring)
4. Env / docs (`.env.sample`, `CLAUDE.md`, `copilot-instructions.md`)

### Risks & Assumptions

- [Any assumptions about existing data or schema]
- [Any destructive operations requiring confirmation]
```

### Exceptions to Planning

A plan is **not required** for:

- Single-file edits (bug fixes, adding a field)
- Formatting-only changes
- Adding entries to `.env.sample` as part of an already-approved plan

---

## Tool Usage Rules

### After Every Code Change

1. **Run the linter**: `npm run lint` — all changes must pass ESLint + Prettier before committing
2. **Run the typecheck**: `npm run typecheck` (`tsc --noEmit`)
3. **Verify imports**: Confirm all new imports use `src/` absolute paths (tsconfig `paths` + tsx/esbuild alias)

### Terminal Commands

| Action            | Command                         | Notes                                        |
| ----------------- | ------------------------------- | -------------------------------------------- |
| Install deps      | `npm install`                   | npm lockfile (package-lock.json gitignored)  |
| Invoke (one)      | `npm run invoke -- <queue_id>`  | Synthesize an SQS record for a real row      |
| Invoke (all)      | `npm run invoke -- --all`       | All pending `send_email` rows                |
| Dev HTTP          | `npm run dev:http -- --port 3001` | Local tracking endpoints + webhook         |
| Lint              | `npm run lint`                  | ESLint validation                            |
| Lint fix          | `npm run lint-fix`              | Auto-fix linting issues                      |
| Format            | `npm run format`                | Prettier format all files                    |
| Typecheck         | `npm run typecheck`             | `tsc --noEmit`                               |
| Build             | `npm run build`                 | esbuild bundle → `dist/index.js` (lambda)    |

### Database Operations

- Raw SQL is the **normal** data-access path here (the consumer is a pg utility layer) — but it must always be **parameterized** (`$1, $2, …`), never string-concatenated with user input.
- The durable `app_queue` row is the source of truth. Never send an email that isn't referenced by a `send_email` row.
- `claimQueueForProcessing` must stay **atomic** (conditional status update) so two lambda invocations can't double-claim.
- Keep the retry/backoff (`retry_count`/`delay_seconds`) and **org-scoped** hold-promotion semantics; `STALE_PROCESSING_MINUTES` reclaims crashed `processing` rows.

---

## Scope Limits

### NEVER Modify Without Explicit Permission

| File / Directory                          | Reason                                                              |
| ----------------------------------------- | ------------------------------------------------------------------- |
| `template.yaml`                           | SAM deployment definition — affects the lambda infrastructure       |
| `.env.sample`                             | Environment variable template — shared across the team              |
| `src/utils/database.ts`                   | pg Pool config — critical infrastructure                            |
| `src/utils/env.ts`                        | Env loading + helpers — used by every module                        |
| `src/utils/simple-email-service/index.ts` | SES send path + stub fallback — delivery critical                   |
| `package.json` (dependencies)             | Adding/removing packages requires discussion                        |
| `.eslintrc.json`                          | Linting rules affect entire codebase                                |
| `tsconfig.json`                           | Compiler options affect the whole project                           |

### Safe to Modify Autonomously

| File / Directory                           | Conditions                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| `src/modules/email/email.service.ts`       | Follow the send-flow pattern; keep claim/complete/fail + hold promotion           |
| `src/modules/email/email.helper.ts`        | Follow helper patterns; parameterized queries only                                |
| `src/modules/app-queue/app-queue.helper.ts`| Keep claim atomic; preserve retry/backoff + org-scoped hold chaining              |
| `src/modules/email-tracking/*.ts`          | Token/rewrite/event/analytic semantics must stay idempotent + fail-open           |
| `src/modules/handlers/**`                  | Keep handlers thin; delegate to services                                          |
| `.env.sample`                              | Only with explicit approval (listed above as NEVER without permission)            |

---

## New Feature Checklist

When adding a new capability (e.g., a new queue event, a new tracking event type), the agent MUST:

1. **Helper first** — add/update the data-access + shared builder in the relevant `*.helper.ts` (parameterized SQL, `src/` imports).
2. **Service** — add the business logic in the relevant `*.service.ts` (send flow, tracking event, webhook ingestion).
3. **Handler wiring** — route the new work in `src/modules/handlers/sqs/sqs.handler.ts` (queue events) or `src/modules/handlers/http/http.handler.ts` (HTTP routes).
4. **Env/docs** — update `.env.sample` for new env vars, `CLAUDE.md`, `.github/copilot-instructions.md`, and this file if a convention changed (see Self-Maintenance).
5. **Verify** — `npm run lint` + `npm run typecheck`; run `npm run invoke -- --all` or `dev:http` to smoke-test.

---

## Error Recovery

If a multi-file change causes lint or runtime errors:

1. **Do not revert all changes** — isolate the failure
2. Run `npm run lint` and `npm run typecheck` to identify the exact file and line
3. Fix the specific issue (usually missing imports, wrong alias path, or formatting)
4. Re-run both to confirm the fix
5. If the consumer ran, check the logs (`DEBUG=true`) for runtime errors

If a change to the send lifecycle breaks:

1. Confirm `claimQueueForProcessing` is atomic and the queue row is reachable
2. Verify `EMAIL_TRACKING_SECRET` matches the API server's `TRACKING_SECRET` (if tracking is involved)
3. Confirm `POSTGRES_URL` points at the same database as the API server
4. Check the `app_queue` row state (`ready`/`processing`/`completed`/`failed`/`hold`) and retry backoff

---

## Self-Maintenance — Keeping Instruction Files Current

<!-- LAST AUDITED: 2026-08-21 -->

Both this file (`.agents/instructions.md`) and `.github/copilot-instructions.md` are **living documents**. Agents MUST update them as part of any change that makes their content inaccurate.

### Triggers and Responsibilities

| Trigger                              | File to Update                    | Action                                                                  |
| ------------------------------------ | --------------------------------- | ----------------------------------------------------------------------- |
| **New module / capability added**    | `.github/copilot-instructions.md` | Update "Project Persona" and "Architecture Overview".                   |
| **Terminal command or script changed** | `.agents/instructions.md`         | Update the "Terminal Commands" table to match `package.json` scripts.  |
| **New convention or pattern introduced** | `.github/copilot-instructions.md` | Add to the relevant section.                                           |
| **New "DO NOT Refactor" rule**       | `.github/copilot-instructions.md` | Add a numbered item to the "Guardrails (PR review checklist)".         |
| **Queue/SQS envelope conventions changed** | `.github/copilot-instructions.md` | Update the envelope section (`{ event, queue_id, params }`).          |
| **Build/deploy infrastructure changed** | `.github/copilot-instructions.md` | Update "Architecture Overview" + `template.yaml` references.           |
| **Scope limits adjusted**             | `.agents/instructions.md`         | Update the tables directly.                                             |
| **Formatting/lint rules changed**     | `.github/copilot-instructions.md` | Update the formatting section to match the ESLint/Prettier config.      |

### Update Protocol

1. **Edit in place** — modify the specific section, table row, or example. Do not append a changelog.
2. **Update the `LAST AUDITED` date** in the HTML comment at the top of this section (and in `.github/copilot-instructions.md` if that file was also updated) to the current date.
3. **Commit instruction file changes alongside the code changes** that triggered them — never in a separate commit or PR.
4. **Run `npm run lint`** after editing.

---

## Model Selection & Cost Efficiency (Spawning Sub-Agents)

> Goal: **maximize token/cost efficiency without compromising output.** Default to the **cheapest model that can do the task correctly**, and escalate only when the task genuinely needs stronger reasoning. Never run a flagship model where a cheaper one returns the same result.

### Tier the work to the model

| Tier                | Model (current)     | Use for                                                                                                                              |
| ------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Cheap / scout**   | `claude-haiku-4-5`  | Exploration & file reading, locating code, grep/symbol search, gathering context, summarizing files, simple mechanical edits          |
| **Default / build** | `claude-sonnet-4-6` | Day-to-day implementation: send-flow/tracking/webhook changes, writing/editing services/helpers/handlers, lint fixing                 |
| **Strong / judge**  | `claude-opus-4-8`   | Only where it adds real value: cross-service architecture decisions, tricky multi-file debugging, delivery/security review, ambiguous trade-offs |

Always use the current model IDs above; do not hardcode older generations.

### The scout → build → judge pattern

1. **Scout (Haiku):** fan out cheap agents to read relevant files and return a **distilled** summary — paths, signatures, and the few facts that matter.
2. **Build (Sonnet):** hand that distilled context to a Sonnet agent to implement/edit.
3. **Judge (Opus, only if warranted):** escalate only for high-stakes verification — delivery integrity/security, or when Sonnet is uncertain.

### Rules

1. **Start cheap, escalate on signal** — pick the lowest tier that can plausibly succeed; never default to Opus.
2. **Parallelize cheap, serialize expensive** — run many Haiku scouts concurrently; use a single strong agent for final judgment.
3. **Pass distilled context, not raw files** — a scout's job is to shrink context for the next tier.
4. **Right-size — don't over-spawn** — a single-file lookup you can do inline needs no sub-agent.

### Periodic Audit Checks

During normal work, if an agent notices any inconsistencies, it MUST fix them immediately:

- Module/file counts in "Project Persona" or "Architecture Overview" that don't match `src/`
- "Terminal Commands" table entries that don't match `package.json` scripts
- "Scope Limits" entries for files that have been deleted, renamed, or moved
- Tech stack versions that differ from `package.json` dependencies