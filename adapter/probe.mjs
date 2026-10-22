// Read-only live probe. No Telegram, deployment, account login, or saved tokens.
import { fetchSummary, selectSession } from './worker.mjs';

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 20_000);
try {
  const openSocket = (url, signal) => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const cleanup = () => {
      signal.removeEventListener('abort', abort);
      ws.removeEventListener('error', fail);
      ws.removeEventListener('open', ready);
    };
    const abort = () => { cleanup(); ws.close(); reject(new Error('upstream_timeout')); };
    const fail = () => { cleanup(); reject(new Error('upstream_connection_failed')); };
    const ready = () => { cleanup(); resolve(ws); };
    ws.addEventListener('open', ready, { once: true });
    ws.addEventListener('error', fail, { once: true });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  const now = Date.now();
  const session = selectSession(process.argv[2], now);
  const summary = await fetchSummary(session, { openSocket, signal: controller.signal, now });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  console.error(controller.signal.aborted ? 'upstream_timeout' : error?.status ? error.message : 'upstream_connection_failed');
  process.exitCode = 1;
} finally { clearTimeout(timer); }
