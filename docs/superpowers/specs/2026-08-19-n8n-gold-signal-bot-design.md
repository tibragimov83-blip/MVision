# n8n Gold Signal Bot — Design

**Date:** 2026-08-19
**Status:** Approved, ready for implementation planning
**Platform:** n8n Cloud, Starter plan (€20/mo, 2,500 executions, unlimited active workflows, 5 concurrent)

---

## 1. Purpose

A scheduled n8n workflow that, every 30 minutes during gold market hours, evaluates a fixed set of intraday trade setups on XAU/USD, ranks them, and posts the highest-conviction one to a private Telegram channel.

Phase 1 is deliberately one asset, one channel, one workflow. The structure exists so that adding assets, signals, and channels later is a data change rather than a rebuild.

### Design principles

1. **Numbers come from code, prose comes from the LLM.** Every price, level, and ratio in a published message is computed in a Code node. The LLM only writes descriptive sentences from numbers it is given. It can never introduce a level.
2. **Always post, never manufacture confidence.** A message goes out every run, as required. When no setup clears the conviction floor, the message says so explicitly and states why, rather than presenting a weak setup as a trade.
3. **One execution per run.** No sub-workflows in the hot path — each sub-workflow call would consume a second execution against the plan quota.
4. **Every published signal carries an invalidation level.** No exceptions, in any conviction band that names a direction.

### Non-goals for phase 1

No backtest engine, no automated outcome scoring, no news or sentiment analysis, no position sizing, no broker or order integration, no subscriber management, no payments, no dashboard, no multi-language support, no chart images.

---

## 2. Hard constraints

### 2.1 ATAS cannot be a data source

ATAS is a Windows desktop order-flow platform. Its API is a C# SDK for authoring indicators and strategies *inside* the application; there is no cloud REST endpoint an n8n Cloud instance can call. The alternative — a custom C# ATAS indicator POSTing to an n8n webhook — requires a permanently-running Windows machine and is out of scope. Phase 1 uses a market-data API instead.

### 2.2 Execution budget

n8n Cloud counts one execution per workflow run regardless of node count. Sub-workflow invocations count separately. Manual runs from the canvas count. Error-workflow runs count.

| Cadence | Executions/month | % of 2,500 |
|---|---|---|
| 60 min | 522 | 21% |
| **30 min (chosen)** | **~1,050** | **43%** |
| 15 min | 2,088 | 84% |
| 5 min | 6,264 | over plan |

Development implication: build against pinned test data in the n8n canvas rather than re-running live fetches, since every canvas run consumes quota.

---

## 3. Data sources

| Purpose | Source | Endpoint / detail | Cost |
|---|---|---|---|
| XAU/USD candles | Twelve Data | `GET https://api.twelvedata.com/time_series?symbol=XAU/USD&interval={15min\|1h\|1day}&outputsize={100\|200\|60}&apikey=…` | Free tier: 800 calls/day, 8/min |
| Dollar-direction proxy | Twelve Data | Same endpoint, `symbol=EUR/USD&interval=1h&outputsize=20` | Same key |
| Event-risk gate | ForexFactory weekly JSON | `GET https://nfs.faireconomy.media/ff_calendar_thisweek.json` — filter `country == "USD"` and `impact == "High"` | Free, no key |
| Real yields (phase 2) | FRED | Series `DFII10`, `DGS10`, `DTWEXBGS` | Free key, redistribution-friendly licence |

**Call budget:** 4 calls per run (3 gold intervals + 1 EUR/USD) × ~48 runs/day = **192 calls/day**, 24% of the free tier. The calendar is fetched at most once per 6 hours and cached, so it is negligible.

**Symbol encoding:** the `/` in `XAU/USD` must be URL-encoded (`XAU%2FUSD`). n8n's HTTP Request node handles this when the value is supplied as a query parameter rather than concatenated into the URL string. Supply it as a parameter.

**Data-source ceiling:** the free tier supports up to 5 assets at this cadence (768 calls/day). A sixth asset requires a paid data plan (~$29/mo). This ceiling is on the data API, not on n8n executions.

### 3.1 Redistribution licensing

Most market-data free tiers permit internal use only and prohibit republishing raw data to third parties. Publishing to a Telegram channel is republishing. Before the channel has subscribers beyond the owner, confirm the chosen provider's terms permit it, or move to a plan that does. This is a commercial blocker, not a technical one, and it must be resolved before any public or paid launch.

### 3.2 Regulatory posture

Public market commentary can be construed as investment advice in many jurisdictions. The product targets a Russian-speaking (CIS) audience, where the regulated category is the **«индивидуальная инвестиционная рекомендация» (ИИР)** under the Bank of Russia framework — giving *individualised* recommendations requires being on the register of investment advisers. Two properties keep the channel outside that regime:

1. Content is **broadcast to all subscribers**, never tailored to an individual.
2. Every message carries a disclaimer footer. The default is analytical framing — «Аналитический сигнал · решения принимаете самостоятельно» (RU) / "Analytical signal · you make your own decisions" (EN) — set via the `disclaimer` string in `05-format.js`. A stronger, legally-loaded alternative is the explicit «не ИИР» phrasing («Не является индивидуальной инвестиционной рекомендацией»).

The LLM is additionally instructed not to use imperative buy/sell phrasing, which keeps output on the analysis side of the line. This reduces but does not eliminate exposure; jurisdiction-specific legal review is required before monetisation, and **removing the disclaimer entirely would move the content into the regulated ИИР category** — a deliberate decision, not a default.

---

## 4. Architecture

One production workflow (10 nodes, plus one attached model sub-node) and one error workflow (2 nodes).

```
Schedule Trigger  (n8n-nodes-base.scheduleTrigger)
  │  three custom cron rules — see §4.1
  ▼
Code: Build fetch plan  (n8n-nodes-base.code)
  │  emits one item per (symbol, interval) from a config array
  │  ── EXTENSION SEAM: add an asset by adding array entries
  ▼
HTTP Request  (n8n-nodes-base.httpRequest)
  │  executes once per input item; retryOnFail: 2, waitBetweenTries: 3000
  │  credential: Twelve Data API key as query auth
  ▼
Code: Indicators  (n8n-nodes-base.code)
  │  normalises candles, computes indicator set (§4.2)
  │  STALENESS GATE: newest 15m candle older than 60 min
  │    → increment `skipped` counter, end run, post nothing
  ▼
Code: Event gate  (n8n-nodes-base.code)
  │  reads calendar from staticData; refetches via this.helpers.httpRequest
  │  only if cache older than 6h; computes minutesToNextHighImpactUSD
  ▼
Code: Scorer  (n8n-nodes-base.code)
  │  six candidate generators → scores → winner + conviction band (§5)
  ▼
Basic LLM Chain  (@n8n/n8n-nodes-langchain.chainLlm)
  │  + Anthropic Chat Model  (@n8n/n8n-nodes-langchain.lmChatAnthropic)
  │  model: claude-haiku-4-5 · onError: continueRegularOutput
  ▼
Code: Format  (n8n-nodes-base.code)
  │  builds HTML message; validates + escapes LLM text (§6.2)
  │  falls back to template if LLM errored or failed validation
  │  writes lastSignal / consecutiveCount / counters to staticData
  ├────────────► Telegram  (n8n-nodes-base.telegram)
  │                sendMessage · parse_mode: HTML · disable_notification per band
  └────────────► Google Sheets  (n8n-nodes-base.googleSheets)
                   appendRow · onError: continueRegularOutput

── separate workflow ──
Error Trigger  (n8n-nodes-base.errorTrigger)  ──►  Telegram (DM to owner)
```

**Why `chainLlm` and not the AI Agent node.** An AI Agent exists to let a model decide what to do next using tools. Here the schedule decides when, the config decides which symbols, and the scorer decides which signal — there is no decision left to delegate. A chain is one call, cheaper, deterministic in structure, and cannot wander. The AI Agent node becomes appropriate in phase 2, for the open-ended news/narrative branch.

### 4.1 Schedule

Gold trades from Sunday 21:00/22:00 UTC to Friday 21:00/22:00 UTC, with the exact hour shifting by one across US daylight-saving transitions. Rather than track DST in cron, the schedule brackets the wider window and the staleness gate suppresses posts during the dead hours.

| Cron rule | Window | Runs/week |
|---|---|---|
| `*/30 * * * 1-4` | Mon–Thu, all day | 192 |
| `*/30 0-21 * * 5` | Fri 00:00–21:30 | 44 |
| `*/30 21-23 * * 0` | Sun 21:00–23:30 | 6 |

242 runs/week ≈ **1,052 executions/month**. Weekend runs are not scheduled at all, so no execution is spent while the market is shut. The DST-straddling hours cost at most 2 suppressed runs per week.

Set the n8n instance timezone explicitly in instance settings. All timestamps displayed in messages are UTC, to avoid DST ambiguity for readers.

### 4.2 Indicator set

Computed in the Indicators node from the fetched candles:

| Series | Values |
|---|---|
| Daily (60 bars) | prior-day high, prior-day low, prior-day close, ATR(14), position within 5-day range |
| 1h (200 bars) | EMA 20 / 50 / 200, EMA stack direction, ATR(14), most recent swing high and low |
| 15m (100 bars) | last close, 24h change %, last-8-bar range, compression ratio (8-bar range ÷ 1h ATR), current session range |
| EUR/USD 1h (20 bars) | slope across the last 4 bars, as a dollar-direction proxy |
| Derived | active session — Asia 00:00–07:00, London 07:00–13:00, NY overlap 13:00–17:00, NY afternoon 17:00–21:00 (UTC) |

### 4.3 State

| Store | Contents | Mechanism |
|---|---|---|
| Hot state | `lastSignal` (id + direction), `consecutiveCount`, `calendarCache` + `calendarFetchedAt`, run counters (`ok`, `skipped`, `errors`) | `$getWorkflowStaticData('global')` |
| Cold log | one row per published run | Google Sheets append |

`staticData` does **not** persist across manual canvas executions — only production runs. During development, `consecutiveCount` will appear stuck at 1. This is expected and not a bug.

### 4.4 Failure posture

| Failure | Behaviour |
|---|---|
| Data fetch fails after retries | Workflow errors → error workflow DMs the owner. No message posted. |
| LLM call fails or returns invalid text | Format node uses the deterministic template. Message still posts. |
| Google Sheets fails | Logging is skipped; the Telegram post is unaffected. |
| Telegram send fails | Workflow errors → error workflow DMs the owner. |
| Market closed / stale data | Run ends silently, nothing posted, `skipped` incremented. |

**Heartbeat:** the 08:00 UTC run appends `· 47/48 runs OK (24h)` to its message footer, derived from the `staticData` counters. This costs no additional execution.

---

## 5. The scorer

### 5.1 Candidate generators

Six functions, held in an array. Each returns `null` when its pattern is absent, or a signal object when present.

| id | Fires when | Direction |
|---|---|---|
| `trend_continuation` | 1h EMA stack aligned (20 > 50 > 200 or inverse), price pulled back to EMA20 and holding | With trend |
| `pdh_pdl_break` | A 15m bar closes beyond the prior-day high or low, and the following bar holds beyond it | With the break |
| `range_squeeze` | 15m 8-bar range < 0.6 × 1h ATR (compression) | None — breakout pending |
| `mean_reversion` | Price more than 2.0 × 1h ATR from the 1h EMA20 | Counter-trend |
| `session_open_break` | Break of the first-hour range of the London or NY session | With the break |
| `liquidity_sweep` | Price wicked beyond prior-day high/low, then closed back inside | Reversal |

**Extension seam:** adding a seventh generator is one array entry plus one row of weights. No other node changes.

### 5.2 Scoring

Each surviving candidate starts at a pattern-strength base of 30–50, then:

| Term | Adjustment |
|---|---|
| 1h EMA stack agrees with signal direction | +15 |
| EUR/USD slope agrees (i.e. dollar direction supports the trade) | +12 |
| Volatility regime suits the signal type | +10 |
| Active session suits the signal type | +8 |
| Room to target gives R:R ≥ 2 | +10 |
| High-impact USD event within 60 minutes | −40 |
| High-impact USD event within 120 minutes | −20 |
| Daily trend conflicts with signal direction | −12 |
| Breakout signal during the Asia session | −10 |

Scores are clamped to 0–100. The highest-scoring candidate wins. Ties break toward the higher R:R; where R:R is undefined (a directionless candidate), they break toward the earlier position in the generator array.

**Directionless candidates.** `range_squeeze` reports compression without a directional bias, so it has no entry, stop, or R:R. It is therefore **capped at the LOW band regardless of score**, and publishes the compression range boundaries plus a statement that direction is unresolved until one boundary breaks. This preserves the rule that every directional message carries an invalidation level: a signal with no direction never claims one.

**These weights are a v1 hypothesis, not a validated model.** They are the primary thing the signal log exists to calibrate. After 2–3 weeks (~600 logged signals) the `components` column supports reweighting against observed outcomes.

### 5.3 Conviction bands

| Score | Band | Message content | Telegram notification |
|---|---|---|---|
| ≥ 70 | HIGH | Full signal with entry, stop, target, R:R | on |
| 50–69 | MEDIUM | Full signal with entry, stop, target, R:R | on |
| 30–49 | LOW | Signal shown, marked low conviction | **off** (`disable_notification: true`) |
| < 30, or no candidate fires | NO EDGE | Best candidate's score and the reason nothing qualified | **off** |

The notification flag is how a 48-message-per-day feed stays tolerable: the channel carries everything, but a subscriber's phone only alerts on HIGH and MEDIUM.

### 5.4 Invalidation and target

Computed structurally in code, never inferred:

```
stop = clamp(
  structuralLevel ∓ 0.15 × atr1h,   // just beyond the level defining the setup
  0.30% of price,                    // floor   (~7 pts at 2,400)
  0.80% of price                     // ceiling (~19 pts at 2,400)
)

target = nearest opposing structural level,
         or entry ± 2 × |entry − stop| when no level is in range

rr = |target − entry| / |entry − stop|
```

`structuralLevel` is signal-specific: the broken prior-day high/low for `pdh_pdl_break`, the EMA20 for `trend_continuation`, the swept wick extreme for `liquidity_sweep`, and so on.

### 5.5 Repeat detection

The scorer compares `winner.id + winner.direction` against `lastSignal` in `staticData`. On a match, `consecutiveCount` increments; otherwise it resets to 1. Counts above 1 surface in the message as a repeat marker.

---

## 6. Message format

Telegram `sendMessage`, `parse_mode: HTML`. Typical length ~400 characters against the 4,096 cap.

### 6.1 Templates

**HIGH / MEDIUM:**

```
🟡 <b>GOLD · XAU/USD</b>   2,412.30
▲ +0.84% (24h) · London session

<b>LONG</b> · conviction 72/100
Entry    2,412  (market)
Stop     2,398  (−0.6%)
Target   2,441  (+1.2%)  ·  R:R 2.1

{{ two LLM sentences }}

Next high-impact USD event: 19h (CPI)
<i>Аналитический сигнал · решения принимаете самостоятельно</i>
```

**LOW / NO EDGE:**

```
🟡 <b>GOLD · XAU/USD</b>   2,408.10
▬ −0.09% (24h) · Asia session

<b>NO EDGE</b> · stand aside
Best candidate scored 24/100 — compression
without direction. Nothing worth acting on.

⚠ US CPI in 34 min
<i>Аналитический сигнал · решения принимаете самостоятельно</i>
```

When `consecutiveCount > 1`, one additional line is inserted above the footer: `↻ {{n}}th consecutive run — unchanged`.

`parse_mode: HTML` is used rather than MarkdownV2 because MarkdownV2 requires escaping roughly eighteen characters and returns a 400 on any unescaped `.` or `-` — both of which appear in every price.

### 6.2 LLM constraints and validation

The chain's system prompt permits exactly two sentences describing what the supplied numbers already say. It forbids stating any number not present in the input, and forbids imperative buy/sell phrasing.

The Format node validates before inserting:

1. Length ≤ 200 characters.
2. Every digit sequence in the output appears in the input payload.
3. HTML-escape `&`, `<`, `>` in the accepted text.

Any validation failure, or an LLM node error, causes the Format node to substitute a deterministic template sentence. The message always posts.

---

## 7. Signal log

One Google Sheets row appended per published run. The schema is fixed now so it never requires migration.

| Column | Contents |
|---|---|
| `ts_utc` | ISO 8601 timestamp of the run |
| `price` | XAU/USD at post time |
| `signal_id` | Winning generator id, or `none` |
| `direction` | `long` / `short` / `none` |
| `score` | 0–100 |
| `conviction` | `HIGH` / `MEDIUM` / `LOW` / `NO_EDGE` |
| `entry` | Entry level, blank for NO_EDGE |
| `stop` | Invalidation level, blank for NO_EDGE |
| `target` | Target level, blank for NO_EDGE |
| `rr` | Reward:risk ratio, blank for NO_EDGE |
| `components` | JSON of which scoring terms fired and their values |
| `event_gate_min` | Minutes to next high-impact USD event |
| `session` | Active session name |
| `consecutive` | Repeat count for this signal id + direction |
| `notified` | Boolean — whether the Telegram notification was enabled |
| `outcome_24h` | **Left empty in phase 1.** Filled manually at first; a phase-2 workflow can backfill it. |

`components` is the column that makes reweighting possible. `outcome_24h` exists from day one so that a month of accumulated rows remains analysable without a schema change.

---

## 8. Credentials and setup

### 8.1 Required credentials

| # | Credential | Obtain from | n8n credential type |
|---|---|---|---|
| 1 | Twelve Data API key | twelvedata.com — free signup, no card | Generic query-auth / header |
| 2 | Anthropic API key | console.anthropic.com | Anthropic account |
| 3 | Telegram bot token | @BotFather in Telegram | Telegram API |
| 4 | Telegram channel ID | see §8.2 | (workflow parameter) |
| 5 | Telegram owner user ID | @userinfobot, for error DMs | (workflow parameter) |
| 6 | Google account | n8n OAuth flow | Google Sheets OAuth2 |

### 8.2 Telegram setup

1. **Create the bot.** Message @BotFather → `/newbot` → supply a display name and a username ending in `bot`. It returns a token of the form `8123456789:AAH…`. That token is the entire credential.
2. **Make the bot a channel admin.** Channel Info → Administrators → Add Admin → the bot's username → grant **Post Messages**. Omitting this step causes every send to fail with `403: bot is not a member of the channel chat`.
3. **Obtain the channel ID.** For a public channel, use `@channelusername`. For a private channel, post any message in it, forward that message to @JsonDumpBot, and read `forward_from_chat.id`. Private channel IDs always begin `-100`.
4. **Enable error DMs.** Send `/start` to the bot in a private chat (bots cannot initiate conversations), then obtain your numeric user ID from @userinfobot.

### 8.3 Model selection and cost

At ~1,050 runs/month with roughly 600 input and 80 output tokens per run:

| Model | Input $/MTok | Output $/MTok | Approx. cost/month |
|---|---|---|---|
| `claude-haiku-4-5` (**chosen**) | $1.00 | $5.00 | ~$1.05 |
| `claude-sonnet-5` | $3.00 | $15.00 | ~$3.15 |
| `claude-opus-5` | $5.00 | $25.00 | ~$5.20 |

Haiku 4.5 is sufficient for two sentences generated from supplied numbers. At these magnitudes the choice is an output-quality judgement, not a budget one; move up only if the prose reads mechanical.

### 8.4 Environment configuration

- Instance timezone set explicitly in n8n settings.
- Three cron rules on the Schedule Trigger per §4.1.
- HTTP Request node: `retryOnFail: 2`, `waitBetweenTries: 3000`.
- LLM chain node: `onError: continueRegularOutput`.
- Google Sheets node: `onError: continueRegularOutput`.
- Error workflow assigned as this workflow's error workflow in workflow settings.

---

## 9. Extensibility

### 9.1 Config-level changes — no new nodes, no additional executions

| Extension | What changes | Execution cost |
|---|---|---|
| Add an asset | Entries in the fetch-plan config array; one extra Telegram send within the same run | **zero** |
| Add a signal generator | One array entry, one weights row | zero |
| Add a second channel | One more Telegram node, or loop the existing one over a channel array | zero |
| Retune scoring weights | Edit the weights object | zero |
| Change cadence | Cron expressions | scales linearly (§2.2) |
| Add real yields (FRED) | One daily cached call, one new scoring component | ~30/month |
| Add news / AI-Agent narrative layer | Parallel branch supplying the scorer a `macro_context` string | zero |
| Automated outcome labelling | Second workflow, once daily, backfilling `outcome_24h` | ~30/month |

**Multi-asset scaling.** Executions do not increase with asset count, because fan-out happens inside a single run. The binding constraint is the data API:

| Assets | Twelve Data calls/day | Free tier (800/day) | Executions/month |
|---|---|---|---|
| 1 | 192 | 24% | ~1,050 |
| 2 | 336 | 42% | ~1,050 |
| 3 | 480 | 60% | ~1,050 |
| 5 | 768 | 96% — at the limit | ~1,050 |
| 6+ | 912 | exceeds free tier | ~1,050 |

This is the reason not to decompose assets into sub-workflows: each sub-workflow call would multiply executions while saving nothing.

### 9.2 Rebuild boundaries

- **Per-subscriber personalisation.** Executions scale with subscriber count — ten personalised feeds would need ~10,500 executions/month against a 2,500 limit. This is the point at which self-hosting becomes necessary, and it is the largest architectural fork in the roadmap.
- **Paid tiers with entitlements.** Requires a subscriber database, payment webhooks, and access control — none of which belongs in n8n.
- **Sub-15-minute cadence or real-time alerts.** Schedule-driven polling stops being the correct shape; a webhook or streaming feed is required.
- **Chart images.** `sendPhoto` with a rendered chart requires chart rendering, image hosting, and binary-data handling. A genuine phase-2 project, and likely the highest-value visual upgrade.

---

## 10. Accepted risks

| Risk | Status |
|---|---|
| Scoring weights are unvalidated | Accepted for v1. The signal log is the calibration mechanism. |
| 48 messages/day may fatigue subscribers | Mitigated by notification suppression on LOW and NO_EDGE, and the repeat marker. Cadence is the owner's explicit decision. |
| Free-tier data licensing may prohibit republishing | **Must be resolved before any launch beyond the owner's own channel.** |
| Regulatory exposure from public market commentary | Partially mitigated by broadcast-only delivery, an analytical-framing disclaimer, and the no-imperative-phrasing constraint. The «не ИИР» carve-out is the intended posture. Requires jurisdiction-specific legal review before monetisation; dropping the disclaimer is an explicit escalation into the regulated ИИР category. |
| `staticData` does not persist on manual runs | Accepted. Affects development experience only. |
| Signal quality is unmeasured | Accepted. The log makes it measurable; phase 2 makes it automatic. |

---

## 11. Phase 1 definition of done

- One production workflow, 10 nodes plus an attached model sub-node, and a 2-node error workflow.
- Posting to the owner's Telegram channel every 30 minutes during gold market hours.
- Six signal generators scoring and ranking, with an explicit NO EDGE state.
- Every directional message carrying an invalidation level.
- Every run appending a row to the Google Sheets log.
- Error workflow DMing the owner on failure; daily heartbeat in the 08:00 UTC message.
- Monthly execution consumption at or below ~1,100 of 2,500.
