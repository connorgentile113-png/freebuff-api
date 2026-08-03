const button = document.querySelector('#connect');
const statusLabel = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const detail = document.querySelector('#detail');
const recovery = document.querySelector('#recovery');
const installCommand = document.querySelector('#install-command');
const copyCommand = document.querySelector('#copy-command');
let loginWindow = null;
let openedLoginUrl = null;

function openLogin(state) {
  if (!state.login_url || state.login_url === openedLoginUrl) return;
  openedLoginUrl = state.login_url;
  if (loginWindow && !loginWindow.closed) loginWindow.location.replace(state.login_url);
  else loginWindow = window.open(state.login_url, 'freebuff-login', 'noopener');
}

function render(state) {
  statusDot.className = 'status-dot';
  recovery.hidden = !state.install_command;
  if (state.install_command) installCommand.textContent = state.install_command;
  if (state.phase === 'connected') {
    statusDot.classList.add('done');
    statusLabel.textContent = 'Connected';
    detail.textContent = 'Freebuff is ready. Starting the local API service…';
    button.disabled = true;
    button.querySelector('span').textContent = 'Connection complete';
    finish();
  } else if (state.phase === 'installing' || state.phase === 'starting' || state.phase === 'browser') {
    statusDot.classList.add('busy');
    statusLabel.textContent = state.phase === 'installing'
      ? 'Installing Freebuff CLI'
      : state.phase === 'browser' ? 'Waiting for sign-in' : 'Starting Freebuff';
    detail.textContent = state.phase === 'installing'
      ? 'Freebuff was not found, so setup is installing it automatically with npm…'
      : 'Complete the Freebuff sign-in in the other browser tab. This page will notice when you are done.';
    button.disabled = true;
  } else if (state.phase === 'error') {
    statusDot.classList.add('error');
    statusLabel.textContent = 'Setup needs attention';
    detail.textContent = state.error || 'Freebuff login did not finish. Try again.';
    button.disabled = false;
    button.querySelector('span').textContent = 'Try again';
  }
}

async function status() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  const state = await response.json();
  openLogin(state);
  render(state);
  return state;
}

async function finish() {
  try {
    await fetch('/api/finish', { method: 'POST' });
  } finally {
    setTimeout(() => window.close(), 250);
  }
}

button.addEventListener('click', async () => {
  button.disabled = true;
  statusDot.classList.add('busy');
  statusLabel.textContent = 'Starting Freebuff';
  detail.textContent = 'Preparing the secure Freebuff sign-in…';
  loginWindow = window.open('about:blank', 'freebuff-login');
  try {
    const response = await fetch('/api/login', { method: 'POST' });
    const state = await response.json();
    openLogin(state);
    if (!state.login_url && (state.phase === 'error' || state.phase === 'connected') && loginWindow) {
      loginWindow.close();
    }
    render(state);
  } catch (error) {
    if (loginWindow) loginWindow.close();
    render({ phase: 'error', error: error.message });
  }
});

copyCommand.addEventListener('click', async () => {
  const command = installCommand.textContent.trim();
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(installCommand);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
  copyCommand.textContent = 'Copied';
  setTimeout(() => { copyCommand.textContent = 'Copy'; }, 1_500);
});

status().catch((error) => render({ phase: 'error', error: error.message }));
setInterval(() => status().catch(() => {}), 1_000);
