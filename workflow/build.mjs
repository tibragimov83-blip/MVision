/* ============================================================================
 * BUILD — generates the importable n8n workflow JSON from the code/ sources
 * ----------------------------------------------------------------------------
 *   node workflow/build.mjs
 *
 * The files in code/ are the SINGLE SOURCE OF TRUTH. This script inlines them
 * into the workflow JSON, so editing a Code node never leaves the JSON stale.
 * Re-run it after any change to code/*.js, then re-import.
 *
 * Emits:
 *   workflow/gold-signals-main.json
 *   workflow/gold-signals-error.json
 *
 * IDENTIFIERS (not secrets — safe to keep in this file):
 *   TELEGRAM_CHANNEL_ID   @mvisiontrade
 *   GOOGLE_SHEET_ID       the id from the Sheet's URL
 *
 *   TELEGRAM_OWNER_ID     numeric user id that receives failure DMs
 *
 * NO SECRETS LIVE HERE. The Twelve Data key, Anthropic key and Telegram bot
 * token belong in n8n credentials only. If you ever find one in this file,
 * something has gone wrong — remove it and rotate the key.
 * ==========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODE = path.join(HERE, 'code');

// --- identifiers, not credentials -------------------------------------------
// @mvisiontrade is public, so either form works. The numeric id is used because
// it keeps working if the channel is ever made private or renamed.
const TELEGRAM_CHANNEL_ID = '-1004334466444';
const GOOGLE_SHEET_ID = '1AdbcG-_gpjtzoLZfKXeK8ZU8_XpVYQq1ce7AgQDRBgY';
const TELEGRAM_OWNER_ID = '7979212963'; // error DMs go here

const js = (f) => fs.readFileSync(path.join(CODE, f), 'utf8');

// --------------------------------------------------------------- prompt -----

const LLM_PROMPT = [
  'You write one or two short sentences describing gold market conditions for a Telegram signal channel.',
  '',
  'RULES — these are absolute:',
  // Language is driven by LANG in code/01-fetch-plan.js and arrives as langName
  // from the Scorer, so the setting has exactly one home.
  '- Write in this language: {{ $json.langName }}. Use the natural trading vocabulary of that language, as a market analyst would write it — not a literal translation.',
  '- Write numbers with a PERIOD as the decimal separator (4357.91), never a comma. A comma decimal fails the number check downstream and your text is discarded.',
  '- Two sentences maximum. Under 200 characters in total.',
  '- State ONLY numbers that appear in the FACTS below. Never introduce a price, level or percentage that is not listed there.',
  '- Never use imperative buy/sell language ("buy", "sell", "go long", "enter here"). Describe what the market is doing, not what the reader should do.',
  '- No greeting, no preamble, no disclaimer, no emoji, no hashtags.',
  '- Plain text only. No markdown and no HTML tags.',
  '',
  'The FACTS are given in English (event names may already be in the target language). Read them and write your response in the language named above.',
  '',
  'FACTS:',
  '{{ $json.llmFacts }}',
].join('\n');

// ----------------------------------------------------------------- nodes ----

const codeNode = (name, file, x, y, notes) => ({
  parameters: {
    mode: 'runOnceForAllItems',
    jsCode: js(file),
  },
  id: `code-${file.slice(0, 2)}`,
  name,
  type: 'n8n-nodes-base.code',
  typeVersion: 2,
  position: [x, y],
  notes,
  notesInFlow: false,
});

const mainNodes = [
  {
    parameters: {
      rule: {
        interval: [
          // Mon–Thu, all day. Gold trades ~23h/day.
          { field: 'cronExpression', expression: '*/30 * * * 1-4' },
          // Friday until 21:30 UTC — the market closes 21:00/22:00 depending on DST.
          { field: 'cronExpression', expression: '*/30 0-21 * * 5' },
          // Sunday reopen, bracketing both DST cases. The staleness gate in
          // Indicators suppresses posts during whichever hour is still closed.
          { field: 'cronExpression', expression: '*/30 21-23 * * 0' },
        ],
      },
    },
    id: 'trigger-schedule',
    name: 'Schedule Trigger',
    type: 'n8n-nodes-base.scheduleTrigger',
    typeVersion: 1.2,
    position: [-200, 300],
    notes:
      'Weekends are not scheduled at all, so no execution is spent while the market is shut. ~1,050 executions/month.',
  },

  codeNode(
    'Build fetch plan',
    '01-fetch-plan.js',
    20,
    300,
    'EXTENSION SEAM: add an asset here. 5 assets max on the Twelve Data free tier.',
  ),

  {
    parameters: {
      url: 'https://api.twelvedata.com/time_series',
      authentication: 'genericCredentialType',
      genericAuthType: 'httpQueryAuth',
      sendQuery: true,
      queryParameters: {
        parameters: [
          { name: 'symbol', value: '={{ $json.symbol }}' },
          { name: 'interval', value: '={{ $json.interval }}' },
          { name: 'outputsize', value: '={{ $json.outputsize }}' },
          // Explicit UTC so bar timestamps are unambiguous. The Indicators node
          // appends 'Z' when parsing and relies on this.
          { name: 'timezone', value: 'UTC' },
        ],
      },
      options: { response: { response: { neverError: true } } },
    },
    id: 'http-twelvedata',
    name: 'Fetch series',
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position: [240, 300],
    // Runs once per input item automatically -> 4 calls, still 1 execution.
    retryOnFail: true,
    maxTries: 3,
    waitBetweenTries: 3000,
    notes:
      'Runs once per item from the fetch plan. API key lives in a Query Auth credential (name=apikey), never in this JSON.',
    credentials: {
      httpQueryAuth: { name: 'Twelve Data apikey' },
    },
  },

  codeNode('Indicators', '02-indicators.js', 460, 300, 'Also holds the staleness gate: stale data ends the run with no post.'),
  codeNode('Event gate', '03-event-gate.js', 680, 300, 'Calendar cached 6h in staticData. Degrades to stale cache, then to a precautionary penalty.'),
  codeNode('Scorer', '04-scorer.js', 900, 300, 'EXTENSION SEAM: add a signal to GENERATORS. CALIBRATION KNOB: WEIGHTS.'),

  {
    parameters: {
      promptType: 'define',
      text: `=${LLM_PROMPT}`,
    },
    id: 'llm-chain',
    name: 'Write prose',
    type: '@n8n/n8n-nodes-langchain.chainLlm',
    typeVersion: 1.5,
    position: [1120, 300],
    // If the LLM fails, the run continues and Format falls back to the template.
    onError: 'continueRegularOutput',
    notes:
      'Prose only. Numbers are validated against llmFacts in Format; anything invented is discarded in favour of the template.',
  },

  {
    parameters: {
      // MUST be a resource-locator object, not a plain string. Passing
      // "claude-haiku-4-5" directly imports without complaint and the dropdown
      // even renders the right label, but the node throws
      //   Could not get parameter "model.value"
      // at run time because it reads model.value and there is no such property.
      model: {
        __rl: true,
        mode: 'list',
        value: 'claude-haiku-4-5',
        cachedResultName: 'Claude Haiku 4.5',
      },
      options: {
        temperature: 0.4,
        maxTokensToSample: 300,
      },
    },
    id: 'llm-model',
    name: 'Anthropic Chat Model',
    type: '@n8n/n8n-nodes-langchain.lmChatAnthropic',
    typeVersion: 1.3,
    position: [1120, 500],
    notes:
      'Haiku 4.5 is ample for two sentences from supplied numbers (~$1/month). If it errors with Could not get parameter "model.value", re-select the model from the dropdown to rewrite it as a resource locator.',
    credentials: {
      anthropicApi: { name: 'Anthropic account' },
    },
  },

  codeNode('Format message', '05-format.js', 1340, 300, 'Reads the Scorer by node reference because the LLM chain replaces the item json.'),
  codeNode(
    'Log row',
    '06-log-row.js',
    1560, 400,
    'Emits only the 16 sheet columns. Google Sheets autoMap CREATES a column for any unmatched input field, so Format must not feed it directly.',
  ),

  {
    parameters: {
      chatId: TELEGRAM_CHANNEL_ID,
      text: '={{ $json.messageHtml }}',
      additionalFields: {
        parse_mode: 'HTML',
        // Notify only on HIGH/MEDIUM. This is what keeps 48 posts/day tolerable.
        disable_notification: '={{ $json.disableNotification }}',
        // Suppress n8n's "sent automatically with n8n" footer.
        appendAttribution: false,
      },
    },
    id: 'telegram-send',
    name: 'Send to channel',
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [1560, 200],
    notes: 'HTML parse mode, not MarkdownV2 — MarkdownV2 400s on any unescaped . or - and every price has both.',
    credentials: {
      telegramApi: { name: 'Telegram gold bot' },
    },
  },

  {
    parameters: {
      operation: 'append',
      documentId: { __rl: true, mode: 'id', value: GOOGLE_SHEET_ID },
      sheetName: { __rl: true, mode: 'name', value: 'signals' },
      columns: {
        mappingMode: 'autoMapInputData',
        matchingColumns: [],
        schema: [],
      },
      options: {},
    },
    id: 'sheets-log',
    name: 'Log to Sheets',
    type: 'n8n-nodes-base.googleSheets',
    typeVersion: 4.5,
    position: [1780, 400],
    // Logging must never block the post.
    onError: 'continueRegularOutput',
    notes:
      'autoMapInputData matches the 16 header columns by name; extra fields (messageHtml, _diagnostics) are ignored.',
    credentials: {
      googleSheetsOAuth2Api: { name: 'Google Sheets account' },
    },
  },
];

const mainConnections = {
  'Schedule Trigger': { main: [[{ node: 'Build fetch plan', type: 'main', index: 0 }]] },
  'Build fetch plan': { main: [[{ node: 'Fetch series', type: 'main', index: 0 }]] },
  'Fetch series': { main: [[{ node: 'Indicators', type: 'main', index: 0 }]] },
  Indicators: { main: [[{ node: 'Event gate', type: 'main', index: 0 }]] },
  'Event gate': { main: [[{ node: 'Scorer', type: 'main', index: 0 }]] },
  Scorer: { main: [[{ node: 'Write prose', type: 'main', index: 0 }]] },
  'Write prose': { main: [[{ node: 'Format message', type: 'main', index: 0 }]] },
  'Format message': {
    main: [
      [
        { node: 'Send to channel', type: 'main', index: 0 },
        { node: 'Log row', type: 'main', index: 0 },
      ],
    ],
  },
  'Log row': { main: [[{ node: 'Log to Sheets', type: 'main', index: 0 }]] },
  // Sub-node attaches on the ai_languageModel port, not main.
  'Anthropic Chat Model': {
    ai_languageModel: [[{ node: 'Write prose', type: 'ai_languageModel', index: 0 }]],
  },
};

const mainWorkflow = {
  name: 'Gold signals — XAU/USD 30min',
  nodes: mainNodes,
  connections: mainConnections,
  settings: {
    executionOrder: 'v1',
    // Set this in the UI after importing the error workflow (it needs its ID).
    // Workflow settings -> Error workflow -> "Gold signals — error handler".
    saveDataErrorExecution: 'all',
    saveDataSuccessExecution: 'all',
    saveExecutionProgress: false,
    timezone: 'UTC',
  },
  pinData: {},
};

// ------------------------------------------------------- error workflow -----

const errorNodes = [
  {
    parameters: {},
    id: 'error-trigger',
    name: 'Error Trigger',
    type: 'n8n-nodes-base.errorTrigger',
    typeVersion: 1,
    position: [0, 300],
  },
  {
    parameters: {
      chatId: TELEGRAM_OWNER_ID,
      text: [
        '=\u{1F534} <b>Gold signal bot failed</b>',
        '',
        'Workflow: {{ $json.workflow.name }}',
        'Node: {{ $json.execution.lastNodeExecuted }}',
        'Error: {{ $json.execution.error.message }}',
        '',
        '{{ $json.execution.url }}',
      ].join('\n'),
      additionalFields: {
        parse_mode: 'HTML',
        appendAttribution: false,
      },
    },
    id: 'error-telegram',
    name: 'DM the owner',
    type: 'n8n-nodes-base.telegram',
    typeVersion: 1.2,
    position: [220, 300],
    notes: 'You must /start a private chat with the bot first — bots cannot initiate conversations.',
    credentials: {
      telegramApi: { name: 'Telegram gold bot' },
    },
  },
];

const errorWorkflow = {
  name: 'Gold signals — error handler',
  nodes: errorNodes,
  connections: {
    'Error Trigger': { main: [[{ node: 'DM the owner', type: 'main', index: 0 }]] },
  },
  settings: { executionOrder: 'v1', timezone: 'UTC' },
  pinData: {},
};

// ----------------------------------------------------------------- write ----

const out = (name, obj) => {
  const p = path.join(HERE, name);
  fs.writeFileSync(p, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  const kb = (fs.statSync(p).size / 1024).toFixed(1);
  console.log(`  ${name}  (${kb} kB)`);
};

console.log('Building workflow JSON from code/ sources:');
out('gold-signals-main.json', mainWorkflow);
out('gold-signals-error.json', errorWorkflow);

// Also emit the prompt as plain text. The Write prose node's Text field is the
// one thing you cannot update by pasting a code/*.js file, so this makes it
// copy-pasteable and keeps it in sync with the build.
const promptPath = path.join(CODE, 'write-prose-prompt.txt');
fs.writeFileSync(promptPath, `${LLM_PROMPT}\n`, 'utf8');
console.log('  code/write-prose-prompt.txt  (paste into the Write prose node)');

// Sanity: every Code node must carry non-empty code, and every connection must
// point at a node that exists. A silent typo here becomes a broken import.
const names = new Set(mainNodes.map((n) => n.name));
let problems = 0;
for (const n of mainNodes) {
  if (n.type === 'n8n-nodes-base.code' && !n.parameters.jsCode.trim()) {
    console.log(`  ! ${n.name} has empty jsCode`);
    problems++;
  }
}
for (const [from, ports] of Object.entries(mainConnections)) {
  if (!names.has(from)) {
    console.log(`  ! connection source "${from}" is not a node`);
    problems++;
  }
  for (const conns of Object.values(ports)) {
    for (const group of conns) {
      for (const c of group) {
        if (!names.has(c.node)) {
          console.log(`  ! connection target "${c.node}" is not a node`);
          problems++;
        }
      }
    }
  }
}
console.log(problems === 0 ? 'Structure OK.' : `${problems} structural problem(s).`);
if (problems > 0) process.exit(1);
