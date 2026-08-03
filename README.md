# Freebuff local API

An installable, API-only bridge to the genuine Freebuff CLI. It provides an OpenAI-compatible endpoint at a fixed loopback address:

```text
http://127.0.0.1:8787/v1
```

The small HTTP daemon starts when you sign in to your computer. The actual Freebuff process starts only when a completion request arrives, is reused for compatible requests, and stops after 15 minutes without a request.

## Install

Download or clone this repository, then run the installer for your operating system. If Node.js 20+ or npm is missing, the installer installs the current Node.js LTS (which includes npm) before continuing.

### Linux

```bash
./installers/linux/install.sh
```

This installs a user-level systemd service. It does not require root.

### macOS

Double-click `installers/macos/install.command`, or run:

```bash
./installers/macos/install.command
```

This installs a per-user LaunchAgent.

### Windows

Double-click `installers\windows\install.cmd`, or right-click `install.ps1` and choose **Run with PowerShell**.

This installs a per-user Scheduled Task with a hidden console window.

The installer installs project dependencies, installs the official `freebuff` npm package if it is missing, and immediately opens a temporary local setup page. Press **Sign in with Freebuff** there. If the CLI is still missing, the page installs it automatically; if that fails, it shows a copyable `npm install --global freebuff` command. The page then runs the genuine `freebuff login` flow, opens the Freebuff URL in a browser tab, detects successful login without returning the token to the page, closes, and starts the background API service.

The sign-in page is only used during setup. The service at port 8787 serves JSON/SSE endpoints and no chat UI.
The package is copied into a stable per-user application directory, so the downloaded folder can be deleted after installation.

## Use it from Node.js

Node applications do not enforce browser CORS, so Tool AI and other local Node clients can call the loopback endpoint directly:

```js
const response = await fetch('http://127.0.0.1:8787/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'deepseek',
    messages: [{ role: 'user', content: 'Reply in one sentence.' }],
  }),
});

const completion = await response.json();
console.log(completion.choices[0].message.content);
```

For libraries that accept an OpenAI-compatible server, use:

```text
baseURL: http://127.0.0.1:8787/v1
apiKey:  any non-empty placeholder, unless FREEBUFF_API_KEY is configured
```

### Streaming

Set `stream: true` to receive OpenAI-style server-sent events:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "minimax",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain closures briefly."}]
  }'
```

Streaming includes final-answer text only. Freebuff reasoning and tool traces are intentionally omitted.

## Endpoints

- `GET /` — API discovery JSON
- `GET /health` — daemon and cached Freebuff process state
- `GET /v1/models` — available Freebuff models
- `POST /v1/chat/completions` — JSON or SSE chat completion

Model IDs and aliases:

- `deepseek` or `deepseek/deepseek-v4-flash`
- `deepseek-pro` or `deepseek/deepseek-v4-pro`
- `minimax` or `minimax/minimax-m3`
- `mimo` or `mimo/mimo-v2.5`

Requests are serialized because Freebuff is an interactive agent. A cached CLI session is reused only when its model and `cwd` match the next request; changing either safely starts a new session.

## Configuration

- `FREEBUFF_IDLE_TIMEOUT_MS=900000` controls how long Freebuff stays warm after a request.
- `FREEBUFF_TIMEOUT_MS=300000` controls the response timeout.
- `FREEBUFF_STARTUP_ATTEMPTS=3` and `FREEBUFF_STARTUP_RETRY_MS=10000` control automatic retries when Freebuff's session service reports that it is temporarily busy.
- `FREEBUFF_CWD=/absolute/path` sets the default agent working directory. A request can supply a top-level `cwd` override.
- `FREEBUFF_API_KEY=secret` requires `Authorization: Bearer secret`.
- `FREEBUFF_CORS_ORIGINS=http://localhost:3000` explicitly allows browser origins. Comma-separate multiple origins. No browser CORS access is allowed by default; Node clients are unaffected.
- `FREEBUFF_BIN` and `FREEBUFF_CONFIG_DIR` override Freebuff discovery.
- `HOST=127.0.0.1` and `PORT=8787` set the listener. A non-loopback host is refused unless `FREEBUFF_ALLOW_REMOTE=1` is also set.
- `FREEBUFF_TAKEOVER_ACTIVE=1` permits the API to take over from an existing interactive Freebuff instance. By default it refuses to disrupt one.

Service environment variables can be added to the generated service definition after installation. Restart the service after changing them.

## Manual commands

```bash
npm install
npm run setup
npm start
```

Reopen the login setup at any time with `npm run setup`.

Uninstall the autostart service with the matching file:

```text
installers/linux/uninstall.sh
installers/macos/uninstall.command
installers/windows/uninstall.ps1
```

Uninstalling the service does not remove Freebuff or its login.

## Security and limitations

- The service binds to loopback only. It does not expose Freebuff to the network by default.
- Credentials remain in Freebuff's own config directory. Each warm CLI session uses a private temporary copy that is removed when the session stops.
- This is a CLI bridge, not a provider API, so startup and responses can be slower than direct inference APIs.
- Freebuff is a coding agent and can use tools or modify files in the selected `cwd`. The default workspace is an isolated temporary directory.
- Freebuff account limits and model availability still apply.
