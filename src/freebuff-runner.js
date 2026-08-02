import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node-pty';
import xtermHeadless from '@xterm/headless';
import { finalText, terminalResponse } from './response.js';
import { resolveModel } from './models.js';

const { Terminal } = xtermHeadless;

const realHome = os.homedir();
const defaultConfigDir = path.join(realHome, '.config', 'manicode');
const defaultBinary = path.join(defaultConfigDir, 'freebuff');

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
    throw new Error(`Freebuff credentials were not found at ${credentialsSource}. Run \"freebuff login\" first.`);
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

async function readAgentProgress(configDir) {
  const files = await walkForChatFiles(path.join(configDir, 'projects'));
  for (const file of files) {
    let messages;
    try {
      messages = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(messages)) continue;
    const latestAi = [...messages]
      .reverse()
      .find((message) => message?.variant === 'ai');
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

function killPty(process) {
  try {
    process.kill('SIGTERM');
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
    screen.includes('Freebuff is already running')
  );
}

export class FreebuffRunner {
  constructor(options = {}) {
    this.binary = options.binary ?? process.env.FREEBUFF_BIN ?? defaultBinary;
    this.sourceConfigDir = options.sourceConfigDir ?? process.env.FREEBUFF_CONFIG_DIR ?? defaultConfigDir;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
    this.responseTimeoutMs = options.responseTimeoutMs ?? Number(process.env.FREEBUFF_TIMEOUT_MS ?? 300_000);
  }

  async run({ modelId, prompt, cwd, signal, onDelta }) {
    const requestedModel = resolveModel(modelId);
    if (!requestedModel) throw new Error(`Unsupported Freebuff model: ${modelId}`);
    const activePid = await activeSourceInstance(this.sourceConfigDir);
    if (activePid && process.env.FREEBUFF_TAKEOVER_ACTIVE !== '1') {
      throw new Error(
        `Freebuff is already running as PID ${activePid}. Close it first or set FREEBUFF_TAKEOVER_ACTIVE=1.`,
      );
    }
    await fs.access(this.binary, fs.constants?.X_OK);
    const { tempHome, configDir } = await prepareProfile(modelId, this.sourceConfigDir);
    const terminal = new Terminal({
      cols: 120,
      rows: 40,
      scrollback: 2_000,
      allowProposedApi: true,
    });
    let child;
    let childExit;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      if (child) killPty(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      child = spawn(this.binary, ['--cwd', cwd], {
        name: 'xterm-256color',
        cols: 120,
        rows: 40,
        cwd,
        env: {
          ...process.env,
          HOME: tempHome,
          XDG_CONFIG_HOME: path.join(tempHome, '.config'),
          TERM: 'xterm-256color',
          NO_UPDATE_NOTIFIER: '1',
        },
      });
      childExit = new Promise((resolve) => child.onExit(resolve));
      child.onData((data) => terminal.write(data));

      await waitForScreen(
        terminal,
        isStartupBoundary,
        this.startupTimeoutMs,
        'model picker',
      );
      if (aborted) throw new Error('Request aborted');

      let screen = terminalText(terminal);
      if (screen.includes('Freebuff is already running')) {
        // The backend can retain a stale instance after an ungraceful CLI exit.
        // "Take over" is the default action in this dialog.
        child.write('\r');
        screen = await waitForScreen(
          terminal,
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
        child.write('\r');
        await waitForScreen(
          terminal,
          (value) => value.includes('Enter a coding task'),
          this.startupTimeoutMs,
          'prompt',
        );
      }

      // Bracketed paste keeps the multi-line chat transcript inside the input
      // editor instead of treating its embedded newlines as Enter presses.
      child.write(`\u001b[200~${prompt}\u001b[201~`);
      await delay(50);
      child.write('\r');

      const deadline = Date.now() + this.responseTimeoutMs;
      const submittedAt = Date.now();
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
        const progress = await readAgentProgress(configDir);
        emitProgress(progress.text);
        if (progress.complete) return progress.text;
        const screen = terminalText(terminal);
        const promptPosition = screen.indexOf(prompt);
        const inputPosition = screen.lastIndexOf('Enter a coding task');
        if (
          Date.now() - submittedAt > 1_000 &&
          promptPosition >= 0 &&
          inputPosition > promptPosition + prompt.length &&
          !screen.includes('■ Esc')
        ) {
          const response = terminalResponse(screen, prompt);
          if (response) {
            emitProgress(response);
            return response;
          }
        }
        await delay(250);
      }
      const timeoutError = new Error(`Freebuff response timed out after ${this.responseTimeoutMs}ms`);
      timeoutError.terminalScreen = terminalText(terminal).replaceAll(prompt, '<prompt>');
      throw timeoutError;
    } catch (error) {
      if (error.terminalScreen) {
        console.error(`[freebuff-cli] ${error.message}\n${redactedScreen(error.terminalScreen)}`);
      }
      throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      if (child) {
        killPty(child);
        const stopped = await Promise.race([
          childExit.then(() => true),
          delay(1_000).then(() => false),
        ]);
        if (!stopped) {
          try {
            child.kill('SIGKILL');
          } catch {
            // It may have exited between the timeout and this call.
          }
          await Promise.race([childExit, delay(1_000)]);
        }
      }
      terminal.dispose();
      await fs.rm(tempHome, { recursive: true, force: true });
    }
  }
}
