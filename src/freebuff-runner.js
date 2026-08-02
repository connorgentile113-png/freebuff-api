import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { finalText } from './response.js';
import { resolveModel } from './models.js';

const { Terminal } = xtermHeadless;

const realHome = os.homedir();
const defaultConfigDir = path.join(realHome, '.config', 'manicode');
const defaultBinary = path.join(defaultConfigDir, 'freebuff');
const FIFTEEN_MINUTES = 15 * 60 * 1_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function terminalText(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let index = 0; index < buffer.length; index += 1) {
    lines.push(buffer.getLine(index)?.translateToString(true) ?? '');
  }
  return lines.join('\n');
}

async function copyIfPresent(source, destination, mode) {
  try {
    await fs.copyFile(source, destination);
    if (mode) await fs.chmod(destination, mode);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function prepareProfile(modelId, sourceConfigDir) {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'freebuff-api-'));
  const configDir = path.join(tempHome, '.config', 'manicode');
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });

  const credentialsSource = path.join(sourceConfigDir, 'credentials.json');
  try {
    await fs.access(credentialsSource);
  } catch {
    await fs.rm(tempHome, { recursive: true, force: true });
    throw new Error(`Freebuff credentials were not found at ${credentialsSource}. Run "freebuff login" first.`);
  }

  await copyIfPresent(credentialsSource, path.join(configDir, 'credentials.json'), 0o600);
  await copyIfPresent(
    path.join(sourceConfigDir, 'analytics-id.json'),
    path.join(configDir, 'analytics-id.json'),
    0o600,
  );

  let settings = {};
  try {
    settings = JSON.parse(await fs.readFile(path.join(sourceConfigDir, 'settings.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  settings.freebuffModel = modelId;
  settings.hasSubmittedFirstPrompt = true;
  await fs.writeFile(
    path.join(configDir, 'settings.json'),
    `${JSON.stringify(settings, null, 2)}\n`,
    { mode: 0o600 },
  );

  return { tempHome, configDir };
}

async function activeSourceInstance(sourceConfigDir) {
  try {
    const owner = JSON.parse(
      await fs.readFile(path.join(sourceConfigDir, 'freebuff-instance-owner.json'), 'utf8'),
    );
    if (!Number.isInteger(owner.pid) || owner.pid <= 0) return null;
    try {
      process.kill(owner.pid, 0);
      return owner.pid;
    } catch (error) {
      if (error.code === 'EPERM') return owner.pid;
      if (error.code === 'ESRCH') return null;
      throw error;
    }
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
    throw error;
  }
}

async function walkForChatFiles(directory, output = []) {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return output;
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkForChatFiles(fullPath, output);
    else if (entry.name === 'chat-messages.json') output.push(fullPath);
  }
  return output;
}

async function chatFileSnapshot(configDir) {
  return new Set(await walkForChatFiles(path.join(configDir, 'projects')));
}

async function readAgentProgress(configDir, filesBeforeRequest, submittedAt) {
  const files = await walkForChatFiles(path.join(configDir, 'projects'));
  const candidates = [];
  for (const file of files) {
    try {
      const stats = await fs.stat(file);
      if (!filesBeforeRequest.has(file) || stats.mtimeMs >= submittedAt - 250) {
        candidates.push({ file, mtimeMs: stats.mtimeMs });
      }
    } catch {
      // A chat can move while Freebuff rotates sessions.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);

  for (const { file } of candidates) {
    let messages;
    try {
      messages = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(messages)) continue;
    const latestAi = [...messages].reverse().find((message) => message?.variant === 'ai');
    if (!latestAi) continue;

    let runFinished = false;
    try {
      const runState = JSON.parse(
        await fs.readFile(path.join(path.dirname(file), 'run-state.json'), 'utf8'),
      );
      runFinished = runState?.output?.type === 'lastMessage';
    } catch {
      // A run-state file is optional; isComplete remains the primary signal.
    }
    const text = finalText(latestAi);
    const complete = latestAi.isComplete === true || runFinished;
    if (complete && !text) {
      throw new Error('Freebuff completed without returning a final text response');
    }
    return { text, complete };
  }
  return { text: '', complete: false };
}

async function waitForScreen(terminal, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const screen = terminalText(terminal);
    if (predicate(screen)) return screen;
    await delay(100);
  }
  const error = new Error(`Timed out waiting for Freebuff ${label}`);
  error.terminalScreen = terminalText(terminal);
  throw error;
}

function redactedScreen(value) {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replaceAll(realHome, '~')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(-20)
    .join('\n');
}

function killPty(process, signal = 'SIGTERM') {
  try {
    process.kill(signal);
  } catch {
    // It may already have exited.
  }
}

function isModelPicker(screen) {
  return (
    screen.includes('Start coding for free') ||
    (screen.includes('Press Enter') &&
      (screen.includes('DeepSeek') || screen.includes('MiniMax') || screen.includes('MiMo')))
  );
}

function isStartupBoundary(screen) {
  return (
    screen.includes('Enter a coding task') ||
    isModelPicker(screen) ||
    screen.includes('Freebuff is already running') ||
    isTransientStartupFailure(screen)
  );
}

function isTransientStartupFailure(screen) {
  return (
    screen.includes('service_overloaded') ||
    screen.includes('session service is busy') ||
    screen.includes('The operation timed out')
  );
}

export class FreebuffSession {
  constructor({ binary, sourceConfigDir, startupTimeoutMs, responseTimeoutMs, modelId, cwd }) {
    this.binary = binary;
    this.sourceConfigDir = sourceConfigDir;
    this.startupTimeoutMs = startupTimeoutMs;
    this.responseTimeoutMs = responseTimeoutMs;
    this.modelId = modelId;
    this.cwd = cwd;
    this.child = null;
    this.childExit = null;
    this.exitInfo = null;
    this.terminal = null;
    this.tempHome = null;
    this.configDir = null;
    this.requestCount = 0;
  }

  async start() {
    const requestedModel = resolveModel(this.modelId);
    if (!requestedModel) throw new Error(`Unsupported Freebuff model: ${this.modelId}`);
    const activePid = await activeSourceInstance(this.sourceConfigDir);
    if (activePid && process.env.FREEBUFF_TAKEOVER_ACTIVE !== '1') {
      throw new Error(
        `Freebuff is already running as PID ${activePid}. Close it first or set FREEBUFF_TAKEOVER_ACTIVE=1.`,
      );
    }
    await fs.access(this.binary);
    const profile = await prepareProfile(this.modelId, this.sourceConfigDir);
    this.tempHome = profile.tempHome;
    this.configDir = profile.configDir;
    this.terminal = new Terminal({
      cols: 120,
      rows: 40,
      scrollback: 2_000,
      allowProposedApi: true,
    });

    try {
      this.child = spawn(this.binary, ['--cwd', this.cwd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd: this.cwd,
        env: {
          ...process.env,
          HOME: this.tempHome,
          XDG_CONFIG_HOME: path.join(this.tempHome, '.config'),
          TERM: 'xterm-256color',
          NO_UPDATE_NOTIFIER: '1',
        },
      });
      this.childExit = new Promise((resolve) => {
        this.child.onExit((info) => {
          this.exitInfo = info;
          resolve(info);
        });
      });
      this.child.onData((data) => this.terminal.write(data));

      await waitForScreen(this.terminal, isStartupBoundary, this.startupTimeoutMs, 'startup');
      let screen = terminalText(this.terminal);
      if (isTransientStartupFailure(screen)) {
        const error = new Error('Freebuff session service is temporarily busy');
        error.retryable = true;
        error.terminalScreen = screen;
        throw error;
      }
      if (screen.includes('Freebuff is already running')) {
        this.child.write('\r');
        screen = await waitForScreen(
          this.terminal,
          (value) => value.includes('Enter a coding task') || isModelPicker(value),
          this.startupTimeoutMs,
          'takeover',
        );
      }
      if (isModelPicker(screen) && !screen.includes(requestedModel.name)) {
        throw new Error(
          `Freebuff did not select ${requestedModel.name}; refusing to run a different model`,
        );
      }
      if (!screen.includes('Enter a coding task')) {
        this.child.write('\r');
        await waitForScreen(
          this.terminal,
          (value) => value.includes('Enter a coding task'),
          this.startupTimeoutMs,
          'prompt',
        );
      }
    } catch (error) {
      if (error.terminalScreen) {
        console.error(`[freebuff-cli] ${error.message}\n${redactedScreen(error.terminalScreen)}`);
      }
      await this.stop();
      throw error;
    }
  }

  async run({ prompt, signal, onDelta }) {
    if (!this.child || this.exitInfo) throw new Error('Freebuff session is not running');
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      killPty(this.child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      if (this.requestCount > 0) {
        this.terminal.reset();
        this.child.write('/new');
        await delay(50);
        this.child.write('\r');
        // Slash commands first accept the highlighted completion, then run it.
        await delay(100);
        this.child.write('\r');
        await waitForScreen(
          this.terminal,
          (screen) => screen.includes('Enter a coding task'),
          this.startupTimeoutMs,
          'new conversation',
        );
      }
      if (aborted) throw new Error('Request aborted');
      const filesBeforeRequest = await chatFileSnapshot(this.configDir);
      this.terminal.reset();
      this.child.write(`\u001b[200~${prompt}\u001b[201~`);
      await delay(50);
      this.child.write('\r');
      this.requestCount += 1;

      const submittedAt = Date.now();
      const deadline = submittedAt + this.responseTimeoutMs;
      let emittedText = '';
      const emitProgress = (text) => {
        if (!text || !onDelta) return;
        if (text.startsWith(emittedText)) {
          const delta = text.slice(emittedText.length);
          if (delta) onDelta(delta);
          emittedText = text;
        }
      };

      while (Date.now() < deadline) {
        if (aborted) throw new Error('Request aborted');
        if (this.exitInfo) {
          throw new Error(`Freebuff exited unexpectedly with code ${this.exitInfo.exitCode}`);
        }
        const progress = await readAgentProgress(
          this.configDir,
          filesBeforeRequest,
          submittedAt,
        );
        emitProgress(progress.text);
        if (progress.complete) return progress.text;

        await delay(250);
      }
      const timeoutError = new Error(`Freebuff response timed out after ${this.responseTimeoutMs}ms`);
      timeoutError.terminalScreen = terminalText(this.terminal).replaceAll(prompt, '<prompt>');
      throw timeoutError;
    } catch (error) {
      if (error.terminalScreen) {
        console.error(`[freebuff-cli] ${error.message}\n${redactedScreen(error.terminalScreen)}`);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async stop() {
    const child = this.child;
    const childExit = this.childExit;
    this.child = null;
    if (child) {
      // Let the interactive client tell Freebuff's backend it is leaving before
      // escalating to process signals. This prevents a short-lived stale lease.
      child.write('\u0003');
      let stopped = await Promise.race([
        childExit.then(() => true),
        delay(750).then(() => false),
      ]);
      if (!stopped) {
        child.write('\u0003');
        stopped = await Promise.race([
          childExit.then(() => true),
          delay(750).then(() => false),
        ]);
      }
      if (!stopped) {
        killPty(child);
        stopped = await Promise.race([
          childExit.then(() => true),
          delay(1_000).then(() => false),
        ]);
      }
      if (!stopped) {
        killPty(child, 'SIGKILL');
        await Promise.race([childExit, delay(500)]);
      }
    }
    this.terminal?.dispose();
    this.terminal = null;
    if (this.tempHome) {
      await fs.rm(this.tempHome, { recursive: true, force: true });
      this.tempHome = null;
    }
  }
}

export class FreebuffRunner {
  constructor(options = {}) {
    this.binary = options.binary ?? process.env.FREEBUFF_BIN ?? defaultBinary;
    this.sourceConfigDir = options.sourceConfigDir ?? process.env.FREEBUFF_CONFIG_DIR ?? defaultConfigDir;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? Number(process.env.FREEBUFF_TIMEOUT_MS ?? 300_000);
    this.idleTimeoutMs = options.idleTimeoutMs ?? Number(process.env.FREEBUFF_IDLE_TIMEOUT_MS ?? FIFTEEN_MINUTES);
    this.startupAttempts = options.startupAttempts ?? Number(process.env.FREEBUFF_STARTUP_ATTEMPTS ?? 3);
    this.startupRetryMs = options.startupRetryMs ?? Number(process.env.FREEBUFF_STARTUP_RETRY_MS ?? 10_000);
    this.sessionFactory = options.sessionFactory ?? ((sessionOptions) => new FreebuffSession(sessionOptions));
    this.session = null;
    this.idleTimer = null;
    this.state = 'stopped';
    this.startedAt = null;
    this.lastUsedAt = null;
    this.expiresAt = null;
  }

  status() {
    return {
      state: this.state,
      idle_timeout_ms: this.idleTimeoutMs,
      model: this.session?.modelId ?? null,
      cwd: this.session?.cwd ?? null,
      started_at: this.startedAt,
      last_used_at: this.lastUsedAt,
      expires_at: this.expiresAt,
      request_count: this.session?.requestCount ?? 0,
    };
  }

  clearIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.expiresAt = null;
  }

  scheduleIdleStop() {
    this.clearIdleTimer();
    this.expiresAt = new Date(Date.now() + this.idleTimeoutMs).toISOString();
    this.idleTimer = setTimeout(() => {
      this.stop().catch((error) => console.error(`[freebuff-cli] idle shutdown failed: ${error.message}`));
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }

  async ensureSession(modelId, cwd) {
    if (this.session && (this.session.modelId !== modelId || this.session.cwd !== cwd)) {
      await this.stop();
    }
    if (this.session) return;
    this.state = 'starting';
    for (let attempt = 1; attempt <= this.startupAttempts; attempt += 1) {
      const session = this.sessionFactory({
        binary: this.binary,
        sourceConfigDir: this.sourceConfigDir,
        startupTimeoutMs: this.startupTimeoutMs,
        responseTimeoutMs: this.responseTimeoutMs,
        modelId,
        cwd,
      });
      try {
        await session.start();
        this.session = session;
        this.startedAt = new Date().toISOString();
        this.state = 'ready';
        return;
      } catch (error) {
        if (!error.retryable || attempt === this.startupAttempts) {
          this.state = 'stopped';
          throw error;
        }
        await delay(this.startupRetryMs);
      }
    }
  }

  async run({ modelId, prompt, cwd, signal, onDelta }) {
    const model = resolveModel(modelId);
    if (!model) throw new Error(`Unsupported Freebuff model: ${modelId}`);
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs < 1) {
      throw new Error('FREEBUFF_IDLE_TIMEOUT_MS must be a positive number');
    }
    if (!Number.isInteger(this.startupAttempts) || this.startupAttempts < 1) {
      throw new Error('FREEBUFF_STARTUP_ATTEMPTS must be a positive integer');
    }
    this.clearIdleTimer();
    await this.ensureSession(model.id, cwd);
    this.state = 'busy';
    this.lastUsedAt = new Date().toISOString();
    try {
      const content = await this.session.run({ prompt, signal, onDelta });
      this.state = 'ready';
      this.lastUsedAt = new Date().toISOString();
      this.scheduleIdleStop();
      return content;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    this.clearIdleTimer();
    const session = this.session;
    this.session = null;
    this.state = 'stopped';
    this.startedAt = null;
    this.lastUsedAt = null;
    if (session) await session.stop();
  }

  async close() {
    await this.stop();
  }
}
