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

function quoteSystemd(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
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
  await run('systemctl', ['--user', 'disable', '--now', 'freebuff-api.service'], { ignoreFailure: true });
  const servicePath = path.join(os.homedir(), '.config', 'systemd', 'user', 'freebuff-api.service');
  await fs.rm(servicePath, { force: true });
  await run('systemctl', ['--user', 'daemon-reload'], { ignoreFailure: true });
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
