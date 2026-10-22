# ATAS Signal Context Implementation Plan and Session Handoff

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The user requested implementation in a new session, not during this handoff task.

**Goal:** Add reliable, clearly labelled daily GC volume context to the new 30-minute XAU/USD workflow, initially without changing its trading decisions.

**Architecture:** The daily workflow stores a validated profile in an n8n Data Table. The new 30-minute workflow reads that profile and a delayed, timestamped GC observation, computes deterministic context, and annotates/logs it. Missing or invalid ATAS data falls back to existing signal behavior.

**Tech Stack:** Dependency-free JavaScript, Node, Cloudflare Workers, n8n Cloud, native Data Table nodes, existing Telegram and Google Sheets credentials.

**Spec:** The agreed design brief below records the user's accepted analysis and scope. Older September options/OI specifications are reference material, not this implementation's requirements.

## Global Constraints

- Repository: `https://github.com/tibragimov83-blip/MVision`; workspace: `C:\_DOWNLOADS\MVision`.
- Continue on `codex/atas-integration`. Code baseline: `57f105b3b447ef3541a66456dca0171d1ed9c9cf` (`Add ATAS workflows and reliability fixes`).
- GitHub `main` remained `f2cf787ebdf457237c4d8c73b83db0b327e4246e` when this handoff was prepared. Do not merge or push to `main`.
- Keep the existing published workflows, original channel, and original `signals` sheet unchanged. Work on the new ATAS workflow copies only.
- No large historical-data collection, options/OI harness, model tuning project, new database server, or new runtime dependencies.
- Never put credentials in source, workflow parameters, exports, test output, or this document. Keep bearer authentication in n8n credentials and the Cloudflare secret.
- Use Ponytail full and concise Caveman responses. Use CodeGraph first only if `.codegraph/` exists; it did not exist at handoff.
- Publishing, production deployment, and additional Telegram test posts are separate actions: do not infer that this handoff request asks to perform them.

## Agreed Design Brief

The current 30-minute engine uses trend continuation, session opening breakouts, mean reversion, and range compression. Its EMA, EUR/USD dollar proxy, volatility, session, event-risk, daily-trend, and R:R logic remains the baseline.

ATAS adds volume-at-price information: POC and the 70% value-area boundaries, VAH/VAL. These are structural references, not independent buy/sell signals or probabilities. Daily OHLC and total volume alone are not a new directional edge. Do not interpret missing Bid/Ask delta as zero; exclude delta from decisions while classification is incomplete.

Possible future hypotheses are breakout acceptance outside prior value, rejection back into prior value, and context for an existing mean-reversion setup. First display and log these assessments without changing score, winner, conviction, notifications, entry, stop, target, or R:R. A later small conflict penalty requires observations and a separate explicit decision about its rule and size. Do not invent a weight now.

GC futures and spot XAU/USD have different prices. Never compare spot directly with raw GC POC/VAH/VAL, and never use those raw levels as spot stops/targets. For ongoing context compare a recent GC observation with a GC profile from the same feed, verifying compatible contract/continuous-series identity and rollover behavior. GC data is delayed 15 minutes, so this is lagged context, not immediate order-flow confirmation. Any eventual spot projection needs a separately validated time-aligned basis method.

## Current State and Important Limits

- The new main is a copy of the baseline engine. Its Indicators, Event gate, Scorer, and Format message sources were verified identical to the local baseline exports. It does not yet fetch ATAS or read shared context.
- The daily workflow fetches `/summary`, formats/posts it, and marks the session posted only after Telegram succeeds. It does not yet store the profile for other workflows.
- `adapter/worker.mjs` derives the summary from two snapshots for continuous `/GC:XCEC`: 46 closed 30-minute candles and matching price-level data. Each candle's profile total must match its candle volume. Keep these checks.
- Current `/summary` contains completed-session OHLC, volume, POC/VAH/VAL, optional delta, session boundaries, generation time and quality metadata. It does not return a current GC observation or identify the underlying expiry.
- Public URL: `https://mvision-atas.tibragimov83.workers.dev`. The user deployed a Worker and configured the daily workflow's Header Auth credential. The deployed Worker source has not been compared with the local source.
- Last hosted `/summary` request through n8n failed with HTTP 502 and `profile_volume_mismatch`. Do not describe the unattended hosted path as working until reproduced, diagnosed and successfully retested.
- Styled Telegram preview: `https://t.me/mvisiontrading2/8`. It used the previously validated October 21 session data through temporary formatter pinning. It was not proof of a successful hosted fetch. Pins were removed, both upstream steps re-enabled, and restored settings/wiring verified.
- Main manual delivery and Sheets upsert succeeded. Tracker read/select succeeded with a fresh row correctly pending. A matured live outcome update, scheduled persistent dedupe and production error delivery remain unverified.
- The scorer's existing `score >= 90` crowding rule demotes a candidate to LOW. Blindly adding ATAS points could downgrade a supported setup. Preserve baseline banding during the annotation phase.
- Shared sources and baseline JSON exports on this branch contain the reliability fixes too. Importing those baseline exports would change production behavior; committing them does not deploy them.

### Cloud Workflow Inventory (status as last checked, not a promise of current live state)

All three new scheduled workflows were unpublished; timezone `Etc/UTC`, error workflow `gvC1exIlYQfsFXid`.

| Workflow | ID / URL | Schedule in Tashkent (UTC+5) |
|---|---|---|
| Gold signals — XAU/USD 30min + ATAS | https://mvisiontrading.app.n8n.cloud/workflow/ve8hapvJwUH5reW2 | :02/:32 during configured trading window; freshness guards can skip runs |
| Gold signals + ATAS — daily futures context | https://mvisiontrading.app.n8n.cloud/workflow/9kf0CIyvzIZ1jPUN | 03:30 Tuesday–Saturday |
| Gold signals + ATAS — outcome tracker | https://mvisiontrading.app.n8n.cloud/workflow/te9L0HBpFFHNbHfz | 03:40 Tuesday–Saturday |
| ATAS — setup and connection test (manual only) | https://mvisiontrading.app.n8n.cloud/workflow/GYOgQfkdv2mHI5qt | Manual only; do not publish |
| ATAS compatibility test | https://mvisiontrading.app.n8n.cloud/workflow/ksYelg0QBvL6BO81 | Manual investigation only; do not publish |

New channel: `-1003977702706` (MVision 2); new log tab: `signals_atas`. Spreadsheet and adapter URL are public configuration in `workflow/atas-config.json`; tokens are not.

Protected original published IDs: main `PiKpVFBA2k5viAjO`, tracker `nejJ4KQielhnjeea`, shared error handler `gvC1exIlYQfsFXid`. Original channel: `-1004334466444`; original log tab: `signals`.

n8n JSON file import previously dropped timezone/error-workflow settings. Before editing, export fresh cloud copies and preserve credentials, settings, connections and active status. After saving, export again and compare. Local generated files contain credential names, while cloud exports contain instance credential IDs. Do not overwrite cloud-only bindings with local placeholders. No n8n MCP tools were available in the previous session; check availability again, using the relevant skills before operating.

## Review Focus

1. Partial/incorrect profile snapshots must fail validation rather than silently become trading context.
2. Missing, stale, future-dated or incompatible GC observations must yield unavailable context while the baseline signal still runs.
3. Weekend, holiday, DST, rollover and normal daily-refresh gaps must not present an old profile as the latest available session.
4. Data Table read/write failures and LLM item replacement must not erase baseline signal fields or let a prose model decide the assessment.
5. Annotation must leave baseline scores, ranking, levels, notification flags and existing outcome tracking unchanged, including scores near 90.

## Task 1: Establish a Reliable Hosted Adapter Baseline

**Files:** `adapter/worker.mjs`, `adapter/worker.test.mjs`, `adapter/probe.mjs`, `adapter/README.md`.

**Interface:** Keep authenticated `GET /summary[?date=YYYY-MM-DD]` schemaVersion 1 and existing public fields compatible.

- [ ] Re-read current branch, worktree status and this document; inspect live workflow publication state without changing it. Preserve unrelated local files.
- [ ] Compare deployed Worker source with branch source. Reproduce the reported mismatch using read-only probes against the same completed session. Collect redacted per-bar totals/snapshot-completion evidence, not tokens or raw redistributed market-data dumps.
- [ ] Identify whether snapshot handling, duplicates/removals, source revisions or actual incomplete data explain the mismatch. Do not loosen equality or quality checks without proving why.
- [ ] Add a focused failing regression in `adapter/worker.test.mjs`, make the minimum evidenced fix, and run `node --test adapter/worker.test.mjs`.
- [ ] With deployment explicitly requested, deploy the reviewed source and verify authenticated hosted success, unauthorized rejection, bounded failures and the applicable free-plan runtime limit. Separate Telegram posting from read-only endpoint tests.
- [ ] Commit the isolated fix on this branch; record what the hosted test actually proved. If unavailable data is genuine, retain rejection and fallback behavior instead of manufacturing a successful profile.

## Task 2: Share Validated Daily Profiles

**Files:** `workflow/build.mjs`, `workflow/code/atas-format.js` (reuse validation), `workflow/test/atas-workflow-selfcheck.mjs`, `workflow/test/workflow-build-selfcheck.mjs`; add only the minimal profile-validation source if reuse requires it.

**Interface:** One project Data Table named `atas_gold_context`, with `key` string (`/GC:XCEC|YYYY-MM-DD`), `sessionDate` string, `payload` string containing validated schemaVersion-1 summary JSON, and `validatedAt` datetime. The new main reads rows using a Data Table node; workflow static data is not cross-workflow storage.

- [ ] Verify Data Table availability and node schema on the actual n8n version before constructing parameters. Bind the table in workflow configuration after creation; do not add credentials to code.
- [ ] Add failing checks: valid profiles upsert by symbol/session; invalid profiles never write; Telegram dedupe does not prevent refreshing structured context.
- [ ] Separate validation from Telegram's already-posted check as narrowly as needed. Validate then upsert the profile before the Telegram-only dedupe/send path. Do not make successful Telegram delivery a prerequisite for making valid data available to the main workflow.
- [ ] Define selection using the latest completed eligible New York session, not a blanket 24-hour TTL. Friday can remain valid across a weekend. Missing expected rows or shortened/missing holiday sessions mean unavailable context, not silent substitution. The interval before the fixed daily refresh can legitimately have unavailable context.
- [ ] Test a table outage independently of Telegram delivery. Give storage failures an explicit alert route and preserve valid baseline signals on main-flow reads.
- [ ] Run the two named workflow selfchecks, rebuild exports, inspect wires/settings, and commit this task independently.

## Task 3: Add a Comparable GC Observation and Deterministic Assessment

**Files:** `adapter/worker.mjs`, `adapter/worker.test.mjs`; add `workflow/code/atas-context.js` and `workflow/test/atas-context-selfcheck.mjs` only when implementing this task.

**Interfaces:** Preserve `/summary`; add authenticated `GET /observation` for a recent delivered closed GC 30-minute candle. Return `schemaVersion`, `symbol`, `generatedAt`, `openTime`, `closeTime`, `close`, and `marketDataDelayMinutes`. The client normalizes any missing/incompatible input to `atasContext: { status: 'unavailable', reason }`; valid context includes `sessionDate`, `observedAt`, `region: 'above_value'|'inside_value'|'below_value'`, and GC-labelled levels.

- [ ] Establish the continuous-series contract/rollover semantics from the feed before relying on cross-session comparisons. If compatibility cannot be established, keep raw daily display only; do not pretend the symbols alone prove compatibility.
- [ ] Add failing tests for a forming candle, future timestamps, a candle not yet released by the 15-minute delay, and a closed observation older than 45 minutes. Read only the recent candle needed; do not rebuild the whole prior-day profile every 30 minutes.
- [ ] Add boundary tests: above VAH, below VAL, both boundaries included inside value, missing/invalid profile, stale observation, weekend profile, rollover uncertainty and failed adapter request. All unsupported cases yield unavailable context.
- [ ] Implement region classification in GC price space, never from the spot price. A single above/below observation is location context, not evidence of holding/rejection; do not label it as confirmation.
- [ ] Keep support/conflict judgement and breakout acceptance/rejection unavailable until an exact closed-bar rule and enough comparable observations are specified. Do not invent two-close thresholds or price tolerances during this handoff.
- [ ] Run `node --test adapter/worker.test.mjs` and `node workflow/test/atas-context-selfcheck.mjs`, then commit independently.

## Task 4: Annotate and Observe the New Main Workflow

**Files:** `workflow/build.mjs`, `workflow/code/atas-context.js`, `workflow/code/04-scorer.js` only if needed to carry metadata, `workflow/code/05-format.js`, `workflow/code/06-log-row.js` only if adding explicit log columns, and the focused selfchecks. Regenerate the three ATAS JSON exports.

**Interface:** The scorer receives optional `atasContext`; its baseline output remains identical apart from added context metadata. The message labels GC levels, source-session date and observation delay. Log the context with the baseline decision; the existing `components` JSON can carry metadata if all consumers tolerate it, otherwise explicitly add matching headers/mappings rather than letting Sheets create columns.

- [ ] Add parity tests using identical inputs: ATAS present, absent and failed must preserve candidate winner, score, conviction, entry/stop/target/R:R and notification flag. Include baseline scores 89, 90 and 91.
- [ ] Wire table read and observation fetch into the new main only, with error/empty-result paths returning exactly one original baseline item plus unavailable context. Preserve fields across nodes and the LLM chain, which replaces item JSON.
- [ ] Add a short deterministic context block to the new channel's regular messages. Preserve the original formatter's output for the original workflow. The LLM may describe supplied facts but cannot decide context or modify levels/scores.
- [ ] Log enough information to inspect when future ATAS rules would have changed a decision: baseline decision, profile session, GC observation time/region, quality/fallback reason and rule version. Use existing Sheets/outcome tracking; no historical-data project.
- [ ] Re-run all offline checks below. For cloud validation, export before/after, compare original workflows, verify a permitted preview and fallback, then verify a matured tracker update and the error route before proposing publication.
- [ ] Commit the annotation phase independently. Observe distinct setups rather than treating repeated half-hour updates as independent evidence. A short observation period verifies behavior and suggests hypotheses; it does not prove profitability.

## Later Decision: Optional Conflict Penalty

Do not implement in Tasks 1–4. Review observed cases first, then agree on a precise setup-specific support/conflict rule and a bounded penalty. Keep event/staleness protections and baseline risk limits. Version and log the change; explicitly resolve interaction with the 90-point crowding ceiling. No automatic ATAS-only trade generation or raw GC stop/target projection is authorized by the annotation phase.

## Verification Recorded for the Code Baseline

Fresh local results on 2026-10-22: **166 passing checks**, six reproducible JSON exports, 21 Code node bodies parsed, and staged whitespace checks passed. A scan for common credential-token/private-key patterns found none; this is not proof that the hosted runtime works.

```powershell
node --test adapter/worker.test.mjs
node workflow/test/selfcheck.mjs
node workflow/test/tracker-selfcheck.mjs
node --test workflow/test/market-guards-selfcheck.mjs
node workflow/test/outcome-selfcheck.mjs
node workflow/test/atas-workflow-selfcheck.mjs
node workflow/backtest/replay.mjs --selfcheck
node workflow/test/workflow-build-selfcheck.mjs
```

The last command rebuilds all six exports, including baseline exports. Inspect the diff; do not import baseline exports into production as part of this work. Local-only scratch exports in `tmp/atas-cloud-deployment/` are not committed or authoritative live state. Older local runbooks/reports, images, `db_cost.py`, `output/` and `workflow/backtest-options/` were deliberately excluded from the ATAS baseline commit.

## Suggested Next-Session Prompt

> Continue on codex/atas-integration. Read docs/superpowers/plans/2026-10-22-atas-signal-context-handoff.md and inspect current branch/live state. Start with Task 1: investigate profile_volume_mismatch without weakening validation. Keep original published workflows unchanged. Work task by task; implement context annotation before any score changes. No large backtest/data-analysis project. Do not publish workflows or post tests without a specific request.
