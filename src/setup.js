import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const onboardingDirectory = fileURLToPath(new URL('../onboarding/', import.meta.url));
const configDirectory = process.env.FREEBUFF_CONFIG_DIR
  ?? path.join(os.homedir(), '.config', 'manicode');
const credentialsPath = path.join(configDirectory, 'credentials.json');
const cliBootstrapDirectory = path.join(configDirectory, 'freebuff-api-cli');
const execFileAsync = promisify(execFile);
const freebuffInstallCommand = 'npm install --global freebuff';
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/setup.css', ['setup.css', 'text/css; charset=utf-8']],
  ['/setup.js', ['setup.js', 'text/javascript; charset=utf-8']],
]);

export function findLoginUrl(value) {
  const plainText = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  return plainText.match(/https?:\/\/[^\s<>"')\]]+/)?.[0] ?? null;
}

async function isAuthenticated() {
  try {
    const credentials = JSON.parse(await fs.readFile(credentialsPath, 'utf8'));
    return typeof credentials?.default?.authToken === 'string'
      && credentials.default.authToken.length > 0;
  } catch {
    return false;
  }
}

async function findFreebuffCommand() {
  if (process.env.FREEBUFF_BIN) return process.env.FREEBUFF_BIN;
  const executable = process.platform === 'win32' ? 'freebuff.exe' : 'freebuff';
  const privateBinary = path.join(configDirectory, executable);
  const bootstrapBinary = process.platform === 'win32'
    ? path.join(cliBootstrapDirectory, 'node_modules', '.bin', 'freebuff.cmd')
    : path.join(cliBootstrapDirectory, 'node_modules', '.bin', 'freebuff');
  for (const candidate of [privateBinary, bootstrapBinary]) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Keep looking for an installed CLI.
    }
  }
  try {
    const locator = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(locator, ['freebuff'], { windowsHide: true });
    return stdout.trim().split(/\r?\n/, 1)[0] || null;
  } catch {
    return null;
  }
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: os.homedir(),
      env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let errorOutput = '';
    child.stderr.on('data', (chunk) => {
      errorOutput = `${errorOutput}${chunk.toString('utf8')}`.slice(-8_192);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorOutput.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function installFreebuff() {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await fs.mkdir(cliBootstrapDirectory, { recursive: true });
  await runCommand(npmCommand, ['install', '--prefix', cliBootstrapDirectory, 'freebuff']);
  const command = await findFreebuffCommand();
  if (!command) throw new Error('Freebuff installed, but its command is not on PATH.');
  return command;
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd.exe', ['/d', '/s', '/c', 'start', '', url]]
      : ['xdg-open', [url]];
  const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
  child.on('error', () => {
    console.log(`Open this address to finish setup: ${url}`);
  });
  child.unref();
}

function json(response, status, body) {
  const content = `${JSON.stringify(body)}\n`;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
  });
  response.end(content);
}

async function serveStatic(response, pathname) {
  const [filename, contentType] = staticFiles.get(pathname);
  const body = await fs.readFile(path.join(onboardingDirectory, filename));
  response.writeHead(200, {
    'content-type': contentType,
    'content-length': body.length,
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

export async function runSetup({ open = openBrowser } = {}) {
  const state = {
    phase: await isAuthenticated() ? 'connected' : 'waiting',
    loginUrl: null,
    error: null,
    child: null,
    operation: null,
  };
  let finishTimer = null;
  let resolveFinished;
  const finished = new Promise((resolve) => { resolveFinished = resolve; });

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    try {
      if (request.method === 'GET' && staticFiles.has(url.pathname)) {
        await serveStatic(response, url.pathname);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        if (await isAuthenticated()) state.phase = 'connected';
        json(response, 200, {
          phase: state.phase,
          login_url: state.loginUrl,
          error: state.error,
          install_command: state.phase === 'error' ? freebuffInstallCommand : null,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/login') {
        if (await isAuthenticated()) {
          state.phase = 'connected';
          json(response, 200, { phase: state.phase, login_url: null });
          return;
        }
        if (!state.child && !state.operation) {
          state.phase = 'starting';
          state.error = null;
          state.loginUrl = null;
          state.operation = (async () => {
            let command = await findFreebuffCommand();
            if (!command) {
              state.phase = 'installing';
              command = await installFreebuff();
              state.phase = 'starting';
            }
            const child = spawn(command, ['login'], {
              cwd: os.homedir(),
              env: { ...process.env, NO_UPDATE_NOTIFIER: '1' },
              stdio: ['ignore', 'pipe', 'pipe'],
              windowsHide: true,
            });
            state.child = child;
            let loginOutput = '';
            const consume = (chunk) => {
              loginOutput = `${loginOutput}${chunk.toString('utf8')}`.slice(-32_768);
              const loginUrl = findLoginUrl(loginOutput);
              if (loginUrl && !state.loginUrl) {
                state.loginUrl = loginUrl;
                state.phase = 'browser';
              }
            };
            child.stdout.on('data', consume);
            child.stderr.on('data', consume);
            child.on('error', (error) => {
              state.error = error.message;
              state.phase = 'error';
              state.child = null;
            });
            child.on('exit', async (code) => {
              state.child = null;
              if (await isAuthenticated()) {
                state.phase = 'connected';
              } else if (code !== 0) {
                state.phase = 'error';
                state.error = `Freebuff login exited with code ${code}.`;
              }
            });
          })().catch((error) => {
            state.phase = 'error';
            state.error = `Could not install Freebuff automatically: ${error.message}`;
          }).finally(() => {
            state.operation = null;
          });
        }

        const deadline = Date.now() + 15_000;
        while (
          !state.loginUrl
          && state.phase !== 'error'
          && state.phase !== 'connected'
          && Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        json(response, state.phase === 'error' ? 502 : 200, {
          phase: state.phase,
          login_url: state.loginUrl,
          error: state.error,
          install_command: state.phase === 'error' ? freebuffInstallCommand : null,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/api/finish') {
        if (!(await isAuthenticated())) {
          json(response, 409, { error: 'Freebuff login is not complete.' });
          return;
        }
        state.phase = 'connected';
        json(response, 200, { ok: true });
        if (!finishTimer) {
          finishTimer = setTimeout(() => server.close(resolveFinished), 350);
        }
        return;
      }
      json(response, 404, { error: 'Not found' });
    } catch (error) {
      json(response, 500, { error: error.message });
    }
  });

  server.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  const setupUrl = `http://127.0.0.1:${address.port}`;
  console.log(`Freebuff API setup: ${setupUrl}`);
  open(setupUrl);
  await finished;
  state.child?.kill();
}
