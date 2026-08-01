import { FreebuffRunner } from './src/freebuff-runner.js';
import { createApiServer } from './src/http-api.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer from 1 to 65535');
}
if (host !== '127.0.0.1' && host !== '::1' && process.env.FREEBUFF_ALLOW_REMOTE !== '1') {
  throw new Error('Refusing a non-loopback HOST unless FREEBUFF_ALLOW_REMOTE=1 is set');
}

const server = createApiServer({ runner: new FreebuffRunner() });
server.listen(port, host, () => {
  console.log(`Freebuff local API listening at http://${host}:${port}`);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeAllConnections?.();
  setTimeout(() => process.exit(1), 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
