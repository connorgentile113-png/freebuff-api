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

const runner = new FreebuffRunner();
const server = createApiServer({ runner });
server.listen(port, host, () => {
  console.log(`Freebuff local API listening at http://${host}:${port}`);
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  const forcedExit = setTimeout(() => process.exit(1), 3_000);
  forcedExit.unref();
  await runner.close();
  await new Promise((resolve) => server.close(resolve));
  clearTimeout(forcedExit);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
