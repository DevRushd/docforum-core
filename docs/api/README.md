# API docs

Phase 1 endpoints are real and tested (see `backend/tests/`). Everything
else is still unimplemented — see `ROADMAP.md` for phase order. Keep this
file in sync with `backend/src/modules/*/routes` (AGENTS.md doc-update
rule).

Base URL: `http://localhost:4000` locally (`PORT` in `.env`). No OpenAPI
spec yet — TBD, tracked informally, not blocking Phase 1.

## Auth (`/auth`) — `backend/src/modules/auth`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /auth/signup` | none | `{ role: 'patient'\|'doctor', email, password, fullName }` | **`role` is restricted to `patient`/`doctor` server-side, not just in docforum-web's UI** — facility accounts are admin-invited only (PRD OQ-2). Returns `{ user, accessToken }`; sets an httpOnly refresh cookie. |
| `POST /auth/login` | none | `{ email, password }` | Same response shape as signup. **Throttled** (Phase 8, issue #35) — see below. |
| `POST /auth/refresh` | refresh cookie + `X-CSRF-Token` | — | Reads the httpOnly cookie (not the body). Returns a fresh `{ user, accessToken, csrfToken }` and rotates the cookie **and** the CSRF token. `403` if the CSRF token is missing/wrong or the `Origin` isn't allowlisted. |
| `POST /auth/logout` | `X-CSRF-Token` | — | Clears the refresh cookie. `204 No Content`; `403` without the CSRF header or from a disallowed `Origin`. |
| `POST /auth/verify-email` | none | `{ token }` | Redeems the token from the verification email. `200 { emailVerifiedAt }`. Errors are `400` with `code: 'INVALID_VERIFICATION_TOKEN'` (unknown / already used) or `code: 'VERIFICATION_TOKEN_EXPIRED'`. Single-use and atomic — two concurrent redemptions can't both succeed. |
| `POST /auth/verify-email/resend` | access token | — | Re-sends to the caller's own address. `200 { resendAfterSeconds }`. `409 EMAIL_ALREADY_VERIFIED` if already verified; `429 EMAIL_VERIFICATION_RATE_LIMITED` if a mail went out less than `EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS` ago (default 60). Authenticated and account-scoped on purpose — no email in the body, so it can't be used to enumerate accounts. |

### Email verification (Phase 8, issue #34)

`POST /auth/signup` creates the account **unverified** (`user.emailVerifiedAt`
is `null` in the response and in `GET`-style payloads). Unverified accounts
can log in, refresh, and browse; they get
`403 { message, code: 'EMAIL_NOT_VERIFIED' }` from mutating routes that
depend on a trustworthy contact address:

- `POST /appointments` (booking)
- `POST /payments/wallet-link`, `POST /payments/intents`,
  `POST /payments/intents/:id/{fund,release,refund}`

That guard reads the database rather than trusting a claim in the access
token, so verifying in one tab unblocks the caller immediately instead of
after the 15-minute token TTL.

**No email provider is integrated yet** (Phase 6, issue #17) —
`backend/src/modules/auth/services/email-dispatcher.ts` is the
provider-agnostic seam and currently drops the message (logging only the
subject and recipient, never the body/token). On a hosted deployment, an
operator can mark an address verified out-of-band with
`node backend/scripts/mark-email-verified.mjs <email>`; see
`scripts/README.md`. This is a documented interim, not the end state.

Env knobs: `EMAIL_VERIFICATION_TOKEN_TTL_MINUTES` (default 1440),
`EMAIL_VERIFICATION_RESEND_INTERVAL_SECONDS` (default 60),
`EMAIL_VERIFICATION_LANDING_URL` (where the emailed link points).

### CSRF (Phase 8, issue #37)

The refresh cookie is `SameSite=None; Secure` in production (docforum-web on
GitHub Pages and this API on Render are different sites), so **any** website
can cause a browser to send it to `/auth/refresh` / `/auth/logout`. Those two
routes are therefore protected by:

1. **A required `X-CSRF-Token` header** carrying the `csrfToken` from the
   login/signup/refresh response body. It's a claim inside the refresh JWT
   for that session, so it rotates together with the cookie and needs no
   server-side state. On `/auth/logout` there is no session token to match
   against, so the header's presence is required instead (the impact of a
   forged logout is a forced sign-out, not data loss).
2. **An `Origin` allowlist** — a request whose `Origin` is present and not on
   the CORS allowlist is rejected with `403 Origin not allowed.`
3. **An explicit per-environment CORS allowlist** — `CORS_ORIGINS`
   (comma-separated; `CORS_ORIGIN` still works as a single origin).
   Production defaults to `https://docforum.github.io`; local dev to
   `http://localhost:5173` and `http://127.0.0.1:5173`.

**Why not a double-submit cookie** (the usual default): a cookie set by this
API is a third-party cookie to `docforum.github.io`, so docforum-web's
JavaScript can never read it — the value therefore has to travel in the
response body instead. See `backend/src/middleware/csrf.ts`.

**Client requirements (docforum-web):**

- Store `csrfToken` from the signup/login/refresh response next to the access
  token (in memory), and replace it on every refresh response.
- Send it on the two cookie-authenticated calls:
  `fetch(url, { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrfToken } })`.
- A `403` there means re-login, not retry.

**Requests with no `Origin` header** (curl, server-to-server): allowed past
the Origin check, but the CSRF header is still required — an attacker's page
can't win by suppressing `Origin`. Sessions issued before this change carry
no `csrf` claim in their refresh token, so they are rejected with `403` and
need one re-login.

### Login throttling (Phase 8, issue #35)

`POST /auth/login` is rate-limited **per normalised email and per client
IP**, with state in Postgres (so it survives restarts and doesn't assume a
single instance). Bucket size is capped by the first limit reached:

| Phase | Response |
|---|---|
| Below `LOGIN_THROTTLE_BACKOFF_AFTER` failures (default 3) in the window | normal `401 { message: 'Invalid email or password.' }` |
| At/after it | `429` with a `Retry-After: <seconds>` header, growing exponentially (`LOGIN_THROTTLE_BACKOFF_BASE_SECONDS` × 2ⁿ, capped at `LOGIN_THROTTLE_BACKOFF_MAX_SECONDS`) |
| At `LOGIN_THROTTLE_LOCK_AFTER` failures (default 10) | `429` locked for `LOGIN_THROTTLE_LOCK_SECONDS` (default 15 min). The lock is set once per window and is not extended by further attempts |
| Window (`LOGIN_THROTTLE_WINDOW_SECONDS`, default 15 min) | New window restarts the count at 1 and clears the lock |

A successful login clears the **per-account** counter. The per-IP bucket is
left alone, so one valid login can't reset a shared-IP budget.

Clients should honour `Retry-After` and must **not** treat a `429` as
"account locked permanently". The response is identical for a real and a
non-existent address, and for a locked and a backing-off bucket — it
deliberately reveals nothing about whether the account exists (an absent
account also pays bcrypt's comparison cost, so timing doesn't leak either).

`POST /auth/login-attempts/clear` (admin-only) clears a lock a legitimate
user is stuck behind: body `{ email?, ip? }` (at least one), returns
`{ cleared }`. Clear **both** when a lock was taken out via the account's IP,
or the IP bucket will keep refusing them. It's logged to the server console
— it isn't wired into `AuditEvent` yet (issue #43 covered booking, doctor
verification and payments), so that's the interim record.

Under the hood this uses Express's `trust proxy` setting via the
`TRUST_PROXY` env var: `1` behind Render's single proxy hop, `false` (the
default) locally. See `ARCHITECTURE.md` §7 — the wrong value is a security
bug in either direction. A cleanup interval in `src/server.ts` prunes
buckets whose last failure is older than
`LOGIN_THROTTLE_PRUNE_AFTER_SECONDS` (default 24 h).

Access tokens: `Authorization: Bearer <token>`, 15-minute TTL, no
revocation list yet (see `ARCHITECTURE_ESSENTIALS.md` known gaps —
JWT refresh rotation without a revocation list). Refresh tokens: httpOnly
cookie, 30-day TTL, `SameSite=None; Secure` in production and
`Lax`/insecure locally — the attributes live in `config.cookie`
(`backend/src/config/index.ts`) so the refresh and CSRF cookies can never
drift apart. See `docs/adr/0003` for why production needs `SameSite=None`.

## Doctors (`/doctors`) — `backend/src/modules/doctors`

| Method & path | Auth | Notes |
|---|---|---|
| `GET /doctors/me` | doctor | Returns the caller's own `DoctorProfile`. |
| `PATCH /doctors/:doctorProfileId/verification` | admin | Body `{ status: 'pending'\|'verified'\|'rejected' }`. Manual, admin-gated per PRD FR-3 — there is no automated verification pipeline. |

## Availability (`/availability`) — `backend/src/modules/availability`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `GET /availability/doctors/:doctorProfileId/slots` | none | — | Lists that doctor's open, future slots. Public on purpose — a patient needs to see availability before signing in. |
| `POST /availability/doctors/:doctorProfileId/slots/generate` | doctor (self only) | `{ date: 'YYYY-MM-DD', startHour, endHour, slotLengthMinutes }` | Fixed-length, single-day generation — no recurrence engine (ARCHITECTURE.md §6.3.6 guardrail). Idempotent: re-running with an overlapping range skips slots that already exist rather than erroring or duplicating. |

## Appointments (`/appointments`) — `backend/src/modules/appointments`

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /appointments` | patient | `{ availabilitySlotId }` | **The concurrency-critical endpoint** — see `ARCHITECTURE.md` §5.1 and `backend/tests/integration/booking.test.mts`. `409` if the slot is no longer open. Honours `Idempotency-Key` (below). |
| `GET /appointments/mine` | patient | — | Caller's own appointments, most recent first. |

## Idempotency-Key (`POST` mutations) — `backend/src/middleware/idempotency.ts`

Phase 8, issue #48. A patient on a mobile connection loses signal mid-request,
sees a timeout and taps retry. Without this, the backend cannot tell that retry
from a deliberate second attempt, and the same tap books twice or funds twice —
and no amount of "check then write" fixes it, because two retries 20 ms apart
both pass the check. This is the same problem §5.1 solves for slots, one layer
up.

**Send `Idempotency-Key: <unique value>` on these routes:**

| Route |
|---|
| `POST /appointments` |
| `POST /payments/intents` |
| `POST /payments/intents/:id/fund` |
| `POST /payments/intents/:id/release` |
| `POST /payments/intents/:id/refund` |

The header is **optional** — a request without one behaves exactly as before,
so nothing breaks if a client doesn't send it. But any client that retries
should send one, and should generate a fresh value per *logical* operation
(a UUID, or `crypto.randomUUID()`), not per HTTP attempt.

What the header buys you:

| Situation | Response |
|---|---|
| Same key, **same** request, first attempt | The normal response (`201`/`200`), stored for 24 h |
| Same key, **same** request, retried within 24 h | The **stored** status and body, byte-for-byte, plus `Idempotency-Replayed: true`. The handler does not run again — no second booking, no second Stellar transaction |
| Same key, **different** body / route / target `:id` | `422` `{ message, code: 'IDEMPOTENCY_KEY_REUSED' }`. Nothing is executed |
| Same key, while the first request is **still running** | `409` `{ message, code: 'IN_PROGRESS' }` + `Retry-After: 1`. Retry shortly with the *same* key — it will then replay |
| Same key after the stored response is older than 24 h | Treated as a new request and executed |
| Malformed key (empty, whitespace, non-ASCII, > 255 chars) | `400` `{ message, code: 'INVALID_IDEMPOTENCY_KEY' }`. Nothing is executed |
| The attempt fails with **5xx** | Nothing is cached and no row is kept — **retry with the same key and the request runs again.** A server error is not a result; caching one would turn a transient failure into a permanent answer for that key |

`4xx` responses *are* cached: the request ran, and its answer is the answer, so
a retry gets the same `409` rather than a different outcome.

**Client requirements (docforum-web):**

- Generate the key when the user *initiates* the action (not inside the retry
  loop) and reuse it for every retry of that action.
- Treat `409 IN_PROGRESS` as "retry in `Retry-After` seconds", not as a
  failure — a concurrent duplicate of the same tap lands here.
- Treat `422 IDEMPOTENCY_KEY_REUSED` as a client bug: two different operations
  were sent under one key. Generate a new key for the second one.
- A replayed response is identical to the original, so a client must not
  expect a fresh object id.

**Why it isn't an in-memory lock:** ownership is decided by a unique constraint
on `(userId, key)` in Postgres (`IdempotencyKey`, `ARCHITECTURE.md` §4.12).
Whichever request wins the INSERT runs the handler; every other one reads the
row. A `Map` of pending keys would be correct on one instance and silently
wrong on two — and would be emptied by exactly the restart that a retry storm
follows. Keys are namespaced **per user**: one account can never replay, read
or shadow another account's stored response, because every lookup is filtered
by user id. An `Idempotency-Key` is a guessable string and is not a credential.

Env knobs: `IDEMPOTENCY_RECORD_TTL_HOURS` (default 24),
`IDEMPOTENCY_IN_PROGRESS_TIMEOUT_SECONDS` (default 300 — how long an attempt
abandoned by a crashed process stays stuck before an identical retry may take
it over), `IDEMPOTENCY_MAX_CACHED_BODY_BYTES` (default 256 KiB; a larger
response is executed but not cached, so a retry re-runs it),
`IDEMPOTENCY_PRUNE_INTERVAL_SECONDS` (cleanup interval in `src/server.ts`).

Stored responses are not patient data today and are not part of the
patient-export bundle; see `ARCHITECTURE.md` §6.2.6 for the condition that
would change that.

## Payments (`/payments`) — `backend/src/modules/payments`

Custodial v1 (`docs/adr/0004-custodial-payments-v1.md`): this repo holds the
platform payer/releaser identities and calls `docforum-escrow`'s SDK. Every
intent route requires a verified address, and the intent routes are
admin-triggered in v1 because Phase 4/5 order issuance doesn't exist yet to
trigger them.

| Method & path | Auth | Body | Notes |
|---|---|---|---|
| `POST /payments/wallet-link` | facility | `{ stellarPublicKey }` | Links the **facility's** payout wallet (the on-chain payee — never the patient's). |
| `GET /payments/wallet-link` | facility | — | The caller's own link, or `404`. |
| `POST /payments/intents` | admin | `{ orderType, orderId, patientProfileId, facilityId, amountStroops }` | `amountStroops` is a positive integer **string** (a JSON number can't carry bigint precision). `orderType`/`orderId` are opaque — `Prescription`/`LabOrder` don't exist yet (Phase 4). Honours `Idempotency-Key`. |
| `GET /payments/intents/:id` | admin | — | Single intent; `404` if unknown. |
| `POST /payments/intents/:id/fund` | admin | — | `created` → `escrowed`, moves funds from the platform payer. `409` if the intent isn't `created`, or its facility has no linked wallet. Honours `Idempotency-Key`. |
| `POST /payments/intents/:id/release` | admin | — | `escrowed` → `released`, pays the facility. Honours `Idempotency-Key`. |
| `POST /payments/intents/:id/refund` | admin | — | `escrowed` → `refunded`. Honours `Idempotency-Key`. |

A retried fund/release/refund replays its first response instead of pushing a
second Stellar transaction. That is the belt to §4.10's braces, not a
replacement for them: two *different* keys racing the same transition still
resolve through the conditional status write, and the loser gets `409`.

## Audit trail (`/admin/audit-events`) — `backend/src/modules/audit`

Phase 8, issue #43. Every response carries an `X-Request-Id` header: a
well-formed inbound `X-Request-Id` (8–128 chars of `[A-Za-z0-9._:-]`) is
kept, anything else is replaced with a UUID. Audit events store it, so an
event can be traced to the request (and logs) that caused it.

| Method & path | Auth | Notes |
|---|---|---|
| `GET /admin/audit-events` | admin | Newest first. Query: `entityType`, `entityId` (requires `entityType`), `actorUserId`, `from` / `to` (ISO-8601 date or date-time, inclusive), `limit` (1–200, default 50), `cursor`. Unknown parameters are `400`. Returns `{ items, nextCursor }`; pass `nextCursor` back as `cursor` for the next page (`null` = last page). |

Item shape: `{ id, actorUserId, actorRole, entityType, entityId, action,
fromState, toState, requestId, metadata, createdAt }`. `metadata` is a small
flat map of ids/codes (never personal data). Ordering is
`(createdAt DESC, id DESC)` and the cursor is a keyset position on that
pair, so paging never skips or repeats an event; events written after a scan
started appear at the front of a new scan, not mid-way through the old one.
`400 INVALID_CURSOR` for a malformed cursor; `400` if `from` is after `to`.

Recorded today: `appointment.booked`, `doctor.verification_status_changed`,
`payment_intent.{funded,released,refunded}` — see ARCHITECTURE.md §4.10.
There is no write or delete endpoint, and the table rejects UPDATE/DELETE
in the database.

Payment actions (`POST /payments/intents/:id/{fund,release,refund}`) now
return `409` when the intent changed state concurrently between the check
and the write (previously the second write silently overwrote the first).
## Patients (`/patients`) — `backend/src/modules/patients`

### Data export — right of access (Phase 8, issue #40)

| Method & path | Auth | Notes |
|---|---|---|
| `POST /patients/me/export` | patient | Starts an export of the **caller's own** data. `202` with the export status object and a `Location: /patients/me/export/:id` header. If one is already `pending`/`processing`, returns that one instead of queuing a second. No body is read — there is no way to name another patient. |
| `GET /patients/me/export/:id` | patient (owner) | Status object (below). `404` for an id that isn't the caller's — the same response as one that doesn't exist. |
| `GET /patients/me/export/:id/download` | patient (owner) | Streams the bundle as `application/json` (`Content-Disposition: attachment`, `Cache-Control: no-store`). `409 EXPORT_NOT_READY` while pending/processing/failed; `410 EXPORT_EXPIRED` at or after `expiresAt`, even before the cleanup job has run. |

Doctors and admins get `403` on all three — there is no on-behalf-of export.

Status object:

```json
{
  "id": "uuid",
  "status": "pending | processing | ready | failed | expired",
  "schemaVersion": 1,
  "createdAt": "…", "startedAt": "…", "generatedAt": "…", "expiresAt": "…",
  "sizeBytes": 12345,
  "failure": null,
  "downloadUrl": "/patients/me/export/<id>/download"
}
```

`downloadUrl` and `sizeBytes` are non-null only while `ready`. A failed
export reports `failure: { code: 'SECTION_FAILED', section: '<name>' }` (or
`GENERATION_FAILED` / `GENERATION_TIMEOUT`, with `section: null`) — request a
new export to retry. Generation is asynchronous; poll the status object.

Bundle (`schemaVersion` 1):

```json
{
  "format": "docforum.patient-export",
  "schemaVersion": 1,
  "exportId": "uuid",
  "generatedAt": "ISO-8601",
  "sections": {
    "account":      { "version": 1, "items": [{ "id", "email", "phone", "role", "emailVerifiedAt", "createdAt", "updatedAt" }] },
    "appointments": { "version": 1, "items": [{ "id", "status", "origin", "slot": { "startTime", "endTime" }, "doctor": { "id", "fullName" }, "createdAt", "updatedAt" }] },
    "payments":     { "version": 1, "items": [{ "id", "orderType", "orderId", "status", "amountStroops", "facility": { "id", "name" }, "escrowId", "stellarTxHash", "sorobanContractId", "createdAt", "updatedAt" }] },
    "profile":      { "version": 1, "items": [{ "id", "fullName", "dateOfBirth", "createdAt", "updatedAt" }] }
  }
}
```

Sections are sorted by name; new modules add sections (ARCHITECTURE.md §3.1)
without changing the envelope. `amountStroops`/`escrowId` are strings
(bigint). No password hash, tokens, throttle state or platform secrets are
ever included.

Exports stay downloadable for `PATIENT_EXPORT_TTL_HOURS` (default 24), then
the cleanup job deletes the stored bundle. Other knobs: `PATIENT_EXPORT_PAGE_SIZE`,
`PATIENT_EXPORT_CHUNK_BYTES`, `PATIENT_EXPORT_WORKER_INTERVAL_SECONDS`,
`PATIENT_EXPORT_CLEANUP_INTERVAL_SECONDS`, `PATIENT_EXPORT_STALE_AFTER_SECONDS`,
`PATIENT_EXPORT_MAX_ATTEMPTS` — see `backend/src/config/index.ts` and
`backend/src/jobs/README.md`.

## Not yet implemented

Everything else in `ARCHITECTURE.md` §3's module list (`facilities`,
`consultations`, `referrals`, `prescriptions`, `lab-orders`,
`pharmacy-orders`, `notifications`) has no routes yet — Phase
2 onward, see `ROADMAP.md`. (`payments` *does* have routes — see its section
above; Phase 5.5 shipped it ahead of the order modules it will eventually be
triggered by.)
