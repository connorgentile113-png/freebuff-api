const button = document.querySelector('#connect');
const statusLabel = document.querySelector('#status');
const statusDot = document.querySelector('#status-dot');
const detail = document.querySelector('#detail');
let loginWindow = null;

function render(state) {
  statusDot.className = 'status-dot';
  if (state.phase === 'connected') {
    statusDot.classList.add('done');
    statusLabel.textContent = 'Connected';
    detail.textContent = 'Freebuff is ready. Starting the local API service…';
    button.disabled = true;
    button.querySelector('span').textContent = 'Connection complete';
    finish();
  } else if (state.phase === 'starting' || state.phase === 'browser') {
    statusDot.classList.add('busy');
    statusLabel.textContent = state.phase === 'browser' ? 'Waiting for sign-in' : 'Starting Freebuff';
    detail.textContent = 'Complete the Freebuff sign-in in the other browser tab. This page will notice when you are done.';
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
    if (state.login_url) {
      if (loginWindow) loginWindow.location.replace(state.login_url);
      else window.open(state.login_url, '_blank', 'noopener');
    } else if (loginWindow) {
      loginWindow.close();
    }
    render(state);
  } catch (error) {
    if (loginWindow) loginWindow.close();
    render({ phase: 'error', error: error.message });
  }
});

status().catch((error) => render({ phase: 'error', error: error.message }));
setInterval(() => status().catch(() => {}), 1_000);
