import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const serverPath = path.join(projectRoot, 'server.js');

function run(command, args, { ignoreFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', windowsHide: true });
    child.on('error', (error) => {
      if (ignoreFailure) resolve();
      else reject(error);
    });
    child.on('exit', (code) => {
      if (code === 0 || ignoreFailure) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

function capture(command, args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let settled = false;
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.stdin.on('error', () => {});
    child.on('error', (error) => {
      settled = true;
      reject(error);
    });
    child.on('exit', (code) => {
      if (settled) return;
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
    child.stdin.end(input);
  });
}

async function succeeds(command, args) {
  try {
    await capture(command, args);
    return true;
  } catch {
    return false;
  }
}

function quoteSystemd(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function quoteShell(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const portableLinuxMarker = '# freebuff-local-api';

export function isEmptyCrontabError(message) {
  return /no crontab/i.test(message)
    || /(?:can't|cannot) open .+: no such file or directory/i.test(message);
}

async function stopPortableProcess(pidPath) {
  try {
    const pid = Number.parseInt(await fs.readFile(pidPath, 'utf8'), 10);
    if (!Number.isInteger(pid) || pid <= 0) return;
    const commandLine = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
    if (commandLine.includes(serverPath)) {
      process.kill(pid, 'SIGTERM');
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
  }
}

async function readCrontab() {
  try {
    return await capture('crontab', ['-l']);
  } catch (error) {
    if (isEmptyCrontabError(error.message)) return '';
    throw error;
  }
}

async function removePortableCronEntry() {
  if (!(await succeeds('sh', ['-c', 'command -v crontab >/dev/null 2>&1']))) return;
  const current = await readCrontab();
  const next = current
    .split(/\r?\n/)
    .filter((line) => line && !line.includes(portableLinuxMarker))
    .join('\n');
  await capture('crontab', ['-'], { input: next ? `${next}\n` : '' });
}

async function installPortableLinux() {
  const stateDirectory = path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
    'freebuff-api',
  );
  const launcherPath = path.join(stateDirectory, 'launch.sh');
  const pidPath = path.join(stateDirectory, 'service.pid');
  const stdoutPath = path.join(stateDirectory, 'stdout.log');
  const stderrPath = path.join(stateDirectory, 'stderr.log');
  const launcher = `#!/bin/sh
export HOST=127.0.0.1
export PORT=8787
exec ${quoteShell(process.execPath)} ${quoteShell(serverPath)} >>${quoteShell(stdoutPath)} 2>>${quoteShell(stderrPath)}
`;

  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(launcherPath, launcher, { mode: 0o700 });
  await removePortableCronEntry();
  if (await succeeds('sh', ['-c', 'command -v crontab >/dev/null 2>&1'])) {
    const current = await readCrontab();
    const cronLine = `@reboot ${quoteShell(launcherPath)} ${portableLinuxMarker}`;
    await capture('crontab', ['-'], { input: `${current.trim()}${current.trim() ? '\n' : ''}${cronLine}\n` });
  } else {
    console.warn(`crontab is unavailable; run ${launcherPath} after reboot to restart Freebuff API.`);
  }

  await stopPortableProcess(pidPath);

  const stdout = await fs.open(stdoutPath, 'a');
  const stderr = await fs.open(stderrPath, 'a');
  const child = spawn(process.execPath, [serverPath], {
    detached: true,
    env: { ...process.env, HOST: '127.0.0.1', PORT: '8787' },
    stdio: ['ignore', stdout.fd, stderr.fd],
  });
  child.unref();
  await fs.writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });
  await stdout.close();
  await stderr.close();
  return launcherPath;
}

async function uninstallPortableLinux() {
  const stateDirectory = path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), '.local', 'state'),
    'freebuff-api',
  );
  const pidPath = path.join(stateDirectory, 'service.pid');
  await stopPortableProcess(pidPath);
  await removePortableCronEntry();
  await fs.rm(path.join(stateDirectory, 'launch.sh'), { force: true });
  await fs.rm(pidPath, { force: true });
}

function xml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function quoteVbs(value) {
  return value.replaceAll('"', '""');
}

async function installLinux() {
  if (!(await succeeds('systemctl', ['--user', 'show-environment']))) {
    return installPortableLinux();
  }
  const serviceDirectory = path.join(os.homedir(), '.config', 'systemd', 'user');
  const servicePath = path.join(serviceDirectory, 'freebuff-api.service');
  const content = `[Unit]
Description=Freebuff local API
After=network-online.target

[Service]
Type=simple
ExecStart=${quoteSystemd(process.execPath)} ${quoteSystemd(serverPath)}
Restart=on-failure
RestartSec=3
Environment=HOST=127.0.0.1
Environment=PORT=8787

[Install]
WantedBy=default.target
`;
  await fs.mkdir(serviceDirectory, { recursive: true });
  await fs.writeFile(servicePath, content, { mode: 0o600 });
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', '--now', 'freebuff-api.service']);
  return servicePath;
}

async function uninstallLinux() {
  if (await succeeds('systemctl', ['--user', 'show-environment'])) {
    await run('systemctl', ['--user', 'disable', '--now', 'freebuff-api.service'], { ignoreFailure: true });
  }
  const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'freebuff-api.service');
  await fs.rm(servicePath, { force: true });
  if (await succeeds('systemctl', ['--user', 'show-environment'])) {
    await run('systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true });
  }
  await uninstallPortableLinux();
}

async function installMacos() {
  const agentDirectory = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const stateDirectory = path.join(os.homedir(), 'Library', 'Logs', 'FreebuffAPI');
  const agentPath = path.join(agentDirectory, 'com.freebuff.local-api.plist');
  const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.freebuff.local-api</string>
  <key>ProgramArguments</key>
  <array><string>${xml(process.execPath)}</string><string>${xml(serverPath)}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict><key>HOST</key><string>127.0.0.1</string><key>PORT</key><string>8787</string></dict>
  <key>StandardOutPath</key><string>${xml(path.join(stateDirectory, 'stdout.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(stateDirectory, 'stderr.log'))}</string>
</dict>
</plist>
`;
  await fs.mkdir(agentDirectory, { recursive: true });
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(agentPath, content, { mode: 0o600 });
  const domain = `gui/${process.getuid()}`;
  await run('launchctl', ['bootout', domain, agentPath], { ignoreFailure: true });
  await run('launchctl', ['bootstrap', domain, agentPath]);
  await run('launchctl', ['enable', `${domain}/com.freebuff.local-api`]);
  return agentPath;
}

async function uninstallMacos() {
  const agentPath = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.freebuff.local-api.plist');
  const domain = `gui/${process.getuid()}`;
  await run('launchctl', ['bootout', domain, agentPath], { ignoreFailure: true });
  await fs.rm(agentPath, { force: true });
}

async function installWindows() {
  const stateDirectory = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'FreebuffAPI');
  const launcherPath = path.join(stateDirectory, 'freebuff-api-launch.vbs');
  const command = `"${quoteVbs(process.execPath)}" "${quoteVbs(serverPath)}"`;
  const launcher = `CreateObject("Wscript.Shell").Run "${quoteVbs(command)}", 0, False\r\n`;
  await fs.mkdir(stateDirectory, { recursive: true });
  await fs.writeFile(launcherPath, launcher, 'utf8');
  await run('schtasks.exe', [
    '/Create', '/TN', 'Freebuff Local API', '/SC', 'ONLOGON',
    '/TR', `wscript.exe "${launcherPath}"`, '/F',
  ]);
  await run('schtasks.exe', ['/Run', '/TN', 'Freebuff Local API']);
  return launcherPath;
}

async function uninstallWindows() {
  await run('schtasks.exe', ['/Delete', '/TN', 'Freebuff Local API', '/F'], { ignoreFailure: true });
  const launcherPath = path.join(
    process.env.LOCALAPPDATA ?? os.homedir(),
    'FreebuffAPI',
    'freebuff-api-launch.vbs',
  );
  await fs.rm(launcherPath, { force: true });
}

export async function installService(platform = process.platform) {
  if (platform === 'linux') return installLinux();
  if (platform === 'darwin') return installMacos();
  if (platform === 'win32') return installWindows();
  throw new Error(`Unsupported operating system: ${platform}`);
}

export async function uninstallService(platform = process.platform) {
  if (platform === 'linux') return uninstallLinux();
  if (platform === 'darwin') return uninstallMacos();
  if (platform === 'win32') return uninstallWindows();
  throw new Error(`Unsupported operating system: ${platform}`);
}
