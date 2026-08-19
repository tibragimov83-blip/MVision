# Gold Signal Bot — Setup Runbook

Everything needed to go from the files in this repo to a bot posting every 30 minutes.

Budget about 25 minutes. Nothing here costs money beyond the n8n plan you already have and roughly $1/month of Anthropic usage.

**How the steps are marked:**

| Marker | Meaning |
|---|---|
| 🧑 **You** | Involves a secret or an account only you can access. I cannot and should not do it. |
| 🤝 **Confirm → me** | I can do it, but I will ask first and wait for your go-ahead. |
| ⚠️ **Costs an execution** | Consumes n8n quota, or posts to your channel. |

## Where you are

| Part | | |
|---|---|---|
| **A** | Accounts, keys, channel, Sheet | ✅ done |
| **B** | Identifiers baked into the JSON | ✅ done |
| **C** | Four n8n credentials | ✅ all four exercised against live APIs |
| **D** | Import, wire credentials, timezone, error workflow | ✅ done — two separate workflows, handler published and assigned |
| **E0** | Dry run with outputs deactivated | ✅ done |
| **E1** | Live run into @mvisiontrade | ✅ done — messages posting, Sheet logging |
| **F** | Publish the main workflow | ⬜ **next** |

**Verified end to end on live data:** Twelve Data candles · ForexFactory calendar · the six-generator scorer · stop clamped to the 0.30% floor · R:R arithmetic · direction-correct percentage signs on shorts · `<code>` block alignment in Telegram · `parse_mode: HTML` · attribution suppression · notification policy by conviction band · Anthropic prose passing the digit whitelist · Google Sheets append · error-handler DM routing.

**Four things learned the hard way — all now fixed in the build:**

1. *Import from File* merges into the **currently open** workflow. Create a blank one per import.
2. On this n8n version an error workflow must be **Published**, not left inactive.
3. Google Sheets *Map Automatically* **creates** a column for every unmatched input field. Hence the `Log row` node.
4. `lmChatAnthropic`'s `model` must be a **resource-locator object**, not a string, or the node throws `Could not get parameter "model.value"` before calling the API.

**Outstanding:** the three API keys shared in chat are compromised and should be rotated — see the end of Part B.

---

## Part A — Accounts and keys (🧑 You) — ✅ complete

*Kept as a record, and for when you set up a second instance.*

### A1. Twelve Data API key

1. Sign up at **twelvedata.com** — free tier, no card required.
2. Copy the API key from the dashboard.

Free tier is 800 calls/day and 8/minute. The bot uses **192/day**, so there is comfortable headroom.

### A2. Anthropic API key

1. Go to **console.anthropic.com** → API Keys → Create Key.
2. Copy it. You will not be able to view it again.

Expect roughly **$1/month** on Claude Haiku 4.5 at this cadence.

### A3. Create the Telegram bot

1. In Telegram, message **@BotFather**.
2. Send `/newbot`.
3. Give it a display name (anything) and a username ending in `bot`.
4. BotFather returns a token like `8123456789:AAHx...`. **That token is the whole credential** — there is nothing to register on a website.

### A4. Create the channel and make the bot an admin

1. Create a new Telegram channel (private is fine — you can make it public later).
2. Channel Info → **Administrators** → **Add Admin** → search your bot's username.
3. Grant **Post Messages**.

> **Do not skip A4.2–A4.3.** Without admin rights every send fails with
> `403: bot is not a member of the channel chat`. This is the single most common
> setup failure.

### A5. Get the channel ID — ✅ done (`-1004334466444`)

| Channel type | ID to use | How |
|---|---|---|
| Public (has `@username`) | `@yourchannel` or the numeric id | You already know the handle |
| Private | `-1001234567890` | Post any message in the channel → forward it to **@JsonDumpBot** → read `forward_from_chat.id` |

Private channel IDs always start `-100`. If you get a short negative number or a positive one, that is a group or a user, not a channel.

The numeric form is used in the workflow rather than `@mvisiontrade`, because it keeps working if the channel is ever renamed or made private.

### A6. Enable error DMs — ✅ done (`7979212963`)

1. Open a private chat with your bot and send `/start`. **Bots cannot initiate conversations**, so without this the error DM silently fails.
2. Message **@userinfobot** to get your own numeric user ID.

### A7. Create the Google Sheet — ✅ done (tab `signals`, 16 headers confirmed)

1. New Google Sheet. Name it anything.
2. Rename the first tab to exactly **`signals`** (lowercase).
3. Paste this as **row 1**. The column names must match exactly — the log node maps by header name.

```
ts_utc	price	signal_id	direction	score	conviction	entry	stop	target	rr	components	event_gate_min	session	consecutive	notified	outcome_24h
```

*(That is tab-separated — paste it into A1 and Sheets will split it across columns. If it lands in one cell, use Data → Split text to columns.)*

4. Copy the **Sheet ID** from the URL:
   `docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`

`outcome_24h` stays empty for now. It exists from day one so the month of data you accumulate stays analysable without a schema change later.

---

## Part B — Identifiers (mostly done)

These live in `workflow/build.mjs` as named constants, not secrets:

| Constant in `build.mjs` | Value | Used by |
|---|---|---|
| `TELEGRAM_CHANNEL_ID` | `-1004334466444` (@mvisiontrade, public) | *Send to channel* — where signals post |
| `TELEGRAM_OWNER_ID` | `7979212963` | *DM the owner* — where failure alerts go |
| `GOOGLE_SHEET_ID` | `1AdbcG-_gpjtzoLZfKXeK8ZU8_XpVYQq1ce7AgQDRBgY` | *Log to Sheets* — tab `signals` |

All three are already baked into the generated JSON. **Nothing to fill in.**

To change any of them later: edit the constant at the top of `workflow/build.mjs`, run `node workflow/build.mjs`, and re-import.

> **No API key, bot token, or OAuth secret appears in any file in this repo, and
> none should.** They belong exclusively in n8n credentials. `build.mjs` has a
> leak check; if a secret ever turns up in a generated file, remove it and rotate
> the key immediately.

### If a key has been exposed

Any key that has passed through chat, email, a screenshot, or a commit is compromised. Rotate it:

| Key | Where |
|---|---|
| Anthropic | console.anthropic.com → API Keys → revoke → create new |
| Telegram bot token | @BotFather → `/revoke` |
| Twelve Data | dashboard → regenerate |

Then update the corresponding n8n credential. Nothing else in the workflow changes.

---

## Part C — n8n credentials (🧑 You)

Create four credentials in n8n (**Credentials → Add credential**). All four hold secrets, so all four are yours to enter.

| # | Credential type | Fields | Name it |
|---|---|---|---|
| 1 | **Query Auth** (under "Generic Credential Type") | Name: `apikey`  ·  Value: *your Twelve Data key* | `Twelve Data apikey` |
| 2 | **Anthropic** | API Key: *your Anthropic key* | `Anthropic account` |
| 3 | **Telegram** | Access Token: *the BotFather token* | `Telegram gold bot` |
| 4 | **Google Sheets OAuth2** | Sign in with Google, grant access | `Google Sheets account` |

> **Credential 1 is the one people get wrong.** It must be **Query Auth**, and the
> *Name* field must be literally `apikey` — that is the query parameter Twelve
> Data expects. Putting the key in the Value field with the wrong Name gives a
> `401` that looks like a bad key.

The names above match what the workflow JSON references. Using the same names means n8n links them automatically on import; different names just mean you pick from a dropdown in each node.

---

## Part D — Import (🧑 You, or 🤝 confirm → me)

Importing is a UI action. It is far more reliable for you to do it than for me to drive a browser, but I can walk through it with you if you prefer.

> ⚠️ **Create a blank workflow before each import.** n8n's **Import from File**
> imports into the workflow you currently have open — it does *not* create a new
> one. Importing the second file while the first is still open merges both node
> graphs into one workflow and overwrites its name. The symptom is confusing:
> the error workflow becomes unselectable in the dropdown (there is no separate
> workflow to select), and executing "the error workflow" runs the whole main
> chain. One blank workflow per import avoids it.

1. n8n → **Workflows** → **Create Workflow** (blank canvas).
2. ⋯ → **Import from File** → `workflow/gold-signals-error.json`. Save, then **Publish** (see the note in D6a — if your n8n shows a Publish button, an unpublished error workflow cannot be selected as a handler).
3. Return to **Workflows** → **Create Workflow** again (a second blank canvas).
4. ⋯ → **Import from File** → `workflow/gold-signals-main.json`. Save.

Confirm you now have **two** workflows in the list, not one.

### Already merged them?

Select **Error Trigger** and **DM the owner**, **Ctrl+C**, create a new blank workflow, **Ctrl+V** — configuration and credentials come across intact. Then delete those two nodes from the main workflow and rename it back to `Gold signals — XAU/USD 30min`. No need to rebuild anything by hand.
4. In each workflow, open any node showing a red credential warning and select the matching credential from the dropdown. Five nodes need one: *Fetch series*, *Anthropic Chat Model*, *Send to channel*, *Log to Sheets*, and *DM the owner* in the error workflow.
5. Open **Anthropic Chat Model** and confirm the model reads **`claude-haiku-4-5`**. If the field is blank, select it from the dropdown — model-parameter shapes differ slightly across n8n versions and this is the one field that may not survive import cleanly.

### D6. Instance timezone

**Settings → General → Timezone → UTC.**

The three cron rules and every timestamp in the message assume UTC. Setting a local timezone will shift the schedule and misalign the session labels.

### D6a. If the error workflow won't appear in the dropdown

**Check the merge case first** — it is by far the most common cause. Open the workflow list and confirm there are genuinely **two** workflows. If the error nodes ended up inside the main workflow, see *"Already merged them?"* in Part D above; that is a copy-paste fix, not a rebuild.

If you do have two separate workflows and it is still unselectable, n8n requires the handler to contain an **Error Trigger** node. Rebuild it by hand — it is only two nodes:

1. **New workflow**, named `Gold signals — error handler`
2. First node → **Error Trigger** (no configuration)
3. Second node → **Telegram → Send Message**
   - **Chat ID:** `7979212963`
   - **Text:** set the field to **Expression** mode, then paste:
     ```
     🔴 <b>Gold signal bot failed</b>

     Workflow: {{ $json.workflow.name }}
     Node: {{ $json.execution.lastNodeExecuted }}
     Error: {{ $json.execution.error.message }}

     {{ $json.execution.url }}
     ```
   - **Add Field** → Parse Mode → **HTML**
   - **Add Field** → Append n8n Attribution → **off**
   - Credential: your Telegram credential
4. Connect **Error Trigger → Telegram**
5. **Save**, then **Publish**.

> **Publish vs Active — version-dependent, and it matters here.** Older n8n used
> an Active/Inactive toggle, and the common advice "leave error workflows
> inactive" comes from that era. Newer n8n uses **draft / published** versions
> instead. In that model an error workflow **must be published**, because error
> workflows are invoked in production context and a draft-only workflow has no
> production version to call — it appears in the dropdown but greyed out with a
> ⚠. Publishing is safe: with only an Error Trigger there is no schedule or
> webhook, so it cannot fire on its own.
>
> If your n8n shows **Publish** in the top right, publish both workflows.

> **The Text field must be in Expression mode**, or the `{{ }}` placeholders post
> as literal text instead of being evaluated.

### D7. Assign the error workflow

In the **main** workflow: **⋯ menu → Settings → Error Workflow → "Gold signals — error handler"**.

This cannot be set in the JSON because it references the error workflow's ID, which only exists after import.

---

## Part E — First run (⚠️ 🤝 Confirm → me / you)

> **@mvisiontrade is public.** Anything posted there is visible to anyone who
> finds the channel. Do the dry run in E0 first — it costs one extra execution
> and means the first public message is not also the first message you have ever
> laid eyes on.

### E0. Dry run — everything except the outputs

1. In the main workflow, right-click **Send to channel** → **Deactivate**.
2. Same for **Log to Sheets**.
3. **Execute Workflow.**
4. Click the **Format message** node and read `messageHtml` in the output panel. That is the exact text that would have gone out, tags and all.

Check it reads correctly: prices sensible, stop on the right side of entry, percentage signs matching the levels, no stray `<b>` visible as literal text, disclaimer present.

When you are happy, right-click both nodes → **Activate**, and continue to E1.

### E1. Live run

1. **Execute Workflow.**
2. Expected: a message in @mvisiontrade within about 10 seconds, and a new row in the Sheet.

### What to check on the first run

| Where | What you should see |
|---|---|
| **Indicators** node | `price`, `atr1h`, `priorDayHigh` all populated. If output is empty, the market is closed — that is the staleness gate working, not a bug. |
| **Event gate** node | `calendarSource: "fetched"` on the first run |
| **Scorer** node | A `signal` object with a `conviction` band |
| **Format message** node | `_proseSource: "llm"` — if it says `template (…)`, the LLM's reply failed validation. The reason is in the node's console output. Not a failure; the message still posted correctly. |
| **Telegram** | A formatted message, prices bold/monospaced, no raw `<b>` tags visible |
| **Sheet** | One new row, all 16 columns filled except `outcome_24h` |

### Two expected oddities on manual runs

- **`consecutive` always reads 1.** `staticData` does not persist across manual canvas executions, only production runs. This is n8n behaviour, not a bug.
- **The heartbeat line may appear** on the first run after 08:00 UTC. It settles into once-daily once the workflow is active.

---

## Part F — Go live (⚠️ 🤝 Confirm → me / you)

Toggle **Active** on the main workflow — or, on newer n8n, click **Publish**. Whichever your instance shows, that is the action that puts the schedule into production; saving alone does not.

From that moment it posts every 30 minutes during gold market hours: Mon–Thu all day, Friday to 21:30 UTC, Sunday from 21:00 UTC. Weekends are not scheduled at all.

**Expected consumption: ~1,050 executions/month, 43% of your plan.** That leaves roughly 1,450 for development, test runs, and error handling.

Watch the first day, then check the Sheet after a week — that is when reweighting the scorer starts to be data-driven rather than guesswork.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `403: bot is not a member of the channel chat` | Bot is not a channel admin | Redo A4 |
| `400: chat not found` | Wrong channel ID, or missing the `-100` prefix | Redo A5 |
| `401` from Twelve Data | Query Auth *Name* field is not `apikey` | Redo C1 |
| `429` from Twelve Data | Daily call limit hit | Check for a runaway manual-run loop; 192/day is normal |
| Telegram `400: can't parse entities` | An unescaped `<` or `&` reached the message | Should be impossible — Format escapes everything. Send me the payload. |
| Sheet row appears but columns are blank | Header names do not match | Re-paste the header from A7 exactly |
| No message and no error | Staleness gate fired — market closed | Check the Indicators node output; `skipped` counter increments |
| Error DM never arrives | Never sent `/start` to the bot privately | Redo A6.1 |
| Error workflow greyed out (⚠) in the Error Workflow dropdown | It has a node issue — usually an unassigned credential on *DM the owner* — or it was never saved after import | Open it, assign the Telegram credential, **Ctrl+S**, then reopen the main workflow's settings. It does **not** need to be Active. Hover the ⚠ for n8n's own reason. |
| Prose always says `template (empty)` and *Anthropic Chat Model* has a red ✗ | Error reads `Could not get parameter "model.value"` — the model was stored as a plain string instead of a resource-locator object | Open the node, click the **Model** dropdown and re-select **Claude Haiku 4.5** even though it already appears selected. That rewrites the parameter in the right shape. Save and re-run. |
| Prose says `template (…)` with some other reason | LLM validation rejected the reply | The reason is in the parentheses and in the node log. Frequent rejections mean the digit whitelist is too strict — tell me. |

---

## Language

Messages post in **Russian** by default, with English available. One setting controls everything — message labels, setup notes, the disclaimer, and which language Claude writes its prose in.

**To switch:** edit one line at the top of `workflow/code/01-fetch-plan.js`:

```js
const LANG = 'ru';   // 'ru' | 'en'
```

Then `node workflow/build.mjs`, and paste the four changed Code nodes into n8n.

### What lives where

| Text | File |
|---|---|
| Asset display name (ЗОЛОТО / GOLD) | `01-fetch-plan.js` → `ASSETS[].label` |
| Setup notes and generator names | `04-scorer.js` → `STRINGS` |
| Message labels, sessions, disclaimer | `05-format.js` → `STRINGS` |
| Which language the LLM writes in | driven by `LANG`, passed through as `langName` |

### Adding a third language

1. Add a block to `STRINGS` in `04-scorer.js`
2. Add a block to `STRINGS` in `05-format.js`
3. Add the asset label to `ASSETS[].label` in `01-fetch-plan.js`
4. Set `LANG` to the new code

Nothing else changes — the LLM prompt reads the language name from the item, so it never needs editing.

### The disclaimer

The footer is the `disclaimer` string in each language block of `05-format.js`. Default is analytical framing:

- RU: «Аналитический сигнал · решения принимаете самостоятельно»
- EN: "Analytical signal · you make your own decisions"

Keep a disclaimer. For a Russian-speaking audience the content stays outside the regulated **«индивидуальная инвестиционная рекомендация» (ИИР)** category as long as it is broadcast to everyone (not individualised) **and** carries a disclaimer. A stronger legal alternative is «Не является индивидуальной инвестиционной рекомендацией» (the explicit «не ИИР» phrase). Removing it entirely moves the content into the regulated category — see the design spec's accepted-risks table before doing so.

### Two decisions worth knowing

**Prices stay in `1,234.56` format in every language.** Trading channels use that convention regardless of locale, and it keeps the LLM's decimals consistent with the signal block. Russian would normally write `4 357,91`.

**A comma decimal in the prose is rejected.** The number validator strips commas as thousands separators, so `4357,91` normalises to `435791`, matches nothing in the facts, and the reply is discarded in favour of the template. The prompt therefore instructs a period explicitly. If `_proseSource` starts frequently reading `template (invented number …)` after a language change, this is the first thing to check.

### Session names are full phrases, not templates

`сессия` is not glued onto an adjective — each session name is a complete phrase in the strings table. `лондон/нью-йорк сессия` is ungrammatical, and adjective agreement varies by name. Any new language gets the same freedom.

---

## Changing things later

| Want to | Do this | Cost |
|---|---|---|
| Add an asset (silver, oil, BTC) | Add an entry to `ASSETS` in `workflow/code/01-fetch-plan.js`, run `node workflow/build.mjs`, re-import | **Zero extra executions.** Data API is the limit: 5 assets max on the free tier |
| Add a signal | Add an entry to `GENERATORS` in `04-scorer.js` + a weights row, rebuild | Zero |
| Retune the scoring | Edit `WEIGHTS` in `04-scorer.js`, rebuild | Zero |
| Change cadence | Edit the cron rules in `build.mjs`, rebuild | Scales linearly — 15 min would be 84% of your plan |
| Enable the post-event penalty | Uncomment the block marked *OPTIONAL 10th TERM* in `04-scorer.js` | Zero. Note the date you changed it so the Sheet history stays comparable |
| Stop the notification suppression | Change `notified` in `05-format.js` | Zero, but your phone will buzz 48×/day |

**After editing any `code/*.js` file, always run:**

```bash
node workflow/test/selfcheck.mjs && node workflow/build.mjs
```

The self-check catches sign errors, stop-band violations, and R:R arithmetic breaks before they reach the channel. The build regenerates the JSON so it never drifts from the sources.

### Getting a code change into n8n — do NOT re-import

**Importing replaces the whole workflow and discards every credential assignment**, the error-workflow setting, and the active toggle. For a one-node change that is a bad trade.

Instead, for each Code node you changed:

1. Open the node in n8n.
2. Click into the code editor, select all (Ctrl+A), and paste the new contents of the corresponding `workflow/code/NN-*.js` file.
3. Save the workflow.

Credentials, settings, and the schedule all survive. The generated JSON stays useful as the canonical reference and for setting up a second instance.

Re-import only when the node *graph* changes — a node added, removed, or rewired — and expect to redo the credential assignments and Part D6–D7 afterwards.

---

## Before you make this public

Two items from the design spec are deliberately unresolved, and both matter before the channel has subscribers beyond you:

1. **Data redistribution licensing.** Most market-data free tiers permit internal use only. Publishing to a channel is republishing. Confirm Twelve Data's terms cover it, or move to a plan that does.
2. **Regulatory posture.** Every message carries a not-investment-advice footer and the LLM is barred from imperative buy/sell phrasing, but that mitigates rather than eliminates exposure. Get jurisdiction-specific advice before monetising.

Neither blocks you running this for yourself today.
