# ATAS daily gold context

Small authenticated HTTP adapter for n8n Cloud. No runtime dependencies or ATAS
account password. It obtains a temporary ATAS/dxFeed token, reads two DXLink
snapshots, validates the data, and closes the connection. Tokens are never logged
or returned. This is the currently observed ATAS web feed, not a guaranteed public
ATAS API contract; upstream changes fail visibly.

`GET /summary` with `Authorization: Bearer <ADAPTER_TOKEN>` returns the latest
completed gold session. Optional `?date=YYYY-MM-DD` selects a completed weekday.
Errors return 400 (date/query), 401 (authentication), 502 (invalid/incomplete feed),
or 504 (20-second deadline), with `Cache-Control: private, no-store`.

The instrument is continuous **GC futures**, `/GC:XCEC`, delayed 15 minutes.
It is neither gold options open interest nor the spot XAU/USD price. A session
ends at 17:00 America/New_York and starts at 18:00 the preceding day. DST is
handled explicitly. Full sessions require 46 closed 30-minute candles; shortened
holidays or missing profiles are rejected rather than silently substituted.

Each 30-minute price-level profile must total the corresponding candle volume.
POC is the highest-volume price, with a lower-price tie break. The contiguous
value area expands from POC toward the larger adjacent volume, lower side first
on ties, until it contains at least 70% of volume. These are derived statistics;
they need not match another platform's value-area algorithm exactly. Delta is
null whenever the feed cannot classify all volume as bid or ask.

## Local checks

Requires a recent Node with native WebSocket (the live probe used Node 23.6).

```powershell
node --test adapter/worker.test.mjs
node adapter/probe.mjs
node adapter/probe.mjs 2026-10-21
```

The probe is read-only and prints only the validated summary. No Telegram posts.

## Hosting later

The user deployed the adapter at
`https://mvision-atas.tibragimov83.workers.dev` and configured the daily n8n
workflow's Header Auth credential. The last hosted fetch failed with
`profile_volume_mismatch`; deployment is not yet verified for unattended use.
The deployed Worker source has not been compared against the local source.
Worker deployment configuration is in `wrangler.jsonc`.

After creating a Cloudflare account, from this directory:

```powershell
npx wrangler login
npx wrangler secret put ADAPTER_TOKEN
npx wrangler deploy
```

Generate a long random bearer value locally and enter it at the secret prompt.
Store the same value only in n8n Header Auth: header `Authorization`, value
`Bearer <value>`. Never put it in workflow JSON or `atas-config.json`. Local
`.dev.vars`, `.env`, and Wrangler state are ignored by Git.

The complete hosted path, its outbound WebSocket behavior, and the free plan's CPU
budget still need a successful hosted smoke test. Node tests exercise the upgrade
transport using a simulated external socket; the live probe uses Node's native
socket. Do not treat those as a completed Cloudflare deployment test.

## n8n setup

The three cloud drafts and a manual setup workflow now exist; the separate log
tab and channel connection were verified. See
`docs/superpowers/plans/2026-10-22-atas-signal-context-handoff.md` for URLs, tests and
remaining deployment work. They remain unpublished as last checked. File import does not preserve workflow
settings in this instance: explicitly select UTC and the error handler in the UI,
then verify a fresh export after saving.

1. In `workflow/atas-config.json`, the new channel is `-1003977702706`; configure
   `adapterUrl` and the existing shared `errorWorkflowId` after hosting. Identifiers
   are public configuration, not credentials. Rebuild with `node workflow/build.mjs`.
2. Create tab `signals_atas` in the configured spreadsheet with these headers:
   `ts_utc, price, signal_id, direction, score, conviction, entry, stop, target, rr,
   components, event_gate_min, session, consecutive, notified, outcome_24h`.
3. Import only the three new `gold-signals-atas-*.json` workflows as inactive.
   Select existing Twelve Data, Anthropic, Telegram, and Sheets credentials.
   Add `ATAS adapter bearer` Header Auth for the daily context workflow.
4. Confirm the shared error handler is selected and the bot can post to the new
   private channel. Perform a manual adapter fetch/formatter check, one channel
   delivery and Sheets write, tracker update, and an intentional adapter failure
   to verify the owner DM before activating schedules.

The new main uses minutes **02/32**, and its tracker runs **22:40 UTC** weekdays,
to avoid competing with the original workflows' Twelve Data calls. Daily ATAS
context runs **22:30 UTC** weekdays (**03:30 Tashkent the next day**). The regular
30-minute score is unchanged; the daily workflow posts futures volume context
separately, so an ATAS outage does not stop regular signals.

Missing configuration stops every new workflow before its first network call.
The original published workflows have not been changed. Local baseline exports
also contain the reliability fixes, ready for a separately reviewed rollout.
Closed-hour freshness intentionally suppresses signals after a weekend reopen
until a fresh closed hourly candle is available; it does not reuse Friday's
hourly indicators indefinitely.

Daily context records the last posted session only after Telegram succeeds.
Normal scheduled executions skip that session thereafter. n8n static data is
persisted only for successful active executions: manual tests do not prove
durable deduplication, and overlapping runs or an uncertain Telegram response
can still duplicate a post. Automatic Telegram retries are disabled.

Sheets logging runs after successful delivery, upserts by `ts_utc`, retries three
times, and fails the execution visibly if it still cannot write. Wire the shared
error handler when rolling out the baseline fixes too; importing an export alone
does not establish that alert route. The log retains only its 16 intended columns.
