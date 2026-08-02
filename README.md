# Freebuff local API bridge

This exposes the installed Freebuff CLI as a small, loopback-only, OpenAI-style HTTP API. It uses your existing Freebuff login without placing the auth token in requests or this project.

## Start

```bash
npm install
npm start
```

The server listens on `http://127.0.0.1:8787`. Check it with:

```bash
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/v1/models
```

Open `http://127.0.0.1:8787/` in a browser for the built-in chat console.

Call a model:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "minimax/minimax-m3",
    "messages": [
      {"role": "user", "content": "Reply with a one-sentence greeting."}
    ]
  }'
```

Stream an answer using OpenAI-compatible server-sent events:

```bash
curl -N http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek",
    "stream": true,
    "messages": [{"role": "user", "content": "Explain closures briefly."}]
  }'
```

Short aliases also work: `minimax`, `deepseek` (Flash), `deepseek-pro`, `deepseek-flash`, and `mimo`.

## Options

- `PORT=8787` and `HOST=127.0.0.1` set the listener. Non-loopback binding is refused unless `FREEBUFF_ALLOW_REMOTE=1` is also set.
- `FREEBUFF_API_KEY=secret` requires `Authorization: Bearer secret` on every request.
- `FREEBUFF_TIMEOUT_MS=300000` sets the model timeout.
- `FREEBUFF_CWD=/absolute/path` sets the agent's default working directory. A request can override it with a top-level `cwd` field.
- `FREEBUFF_BIN` and `FREEBUFF_CONFIG_DIR` override Freebuff discovery if it is installed somewhere unusual.
- `FREEBUFF_TAKEOVER_ACTIVE=1` allows API calls to take over from a currently running interactive Freebuff process. By default the bridge refuses and asks you to close it.

Requests are serialized because the underlying program is an interactive agent. Each request gets a temporary Freebuff profile containing a private copy of the existing credential and the requested model setting; the profile is deleted afterward. Your main Freebuff settings are not changed.

## Important limitations

- This is a CLI bridge, not a direct provider API, so responses can take longer than ordinary inference APIs.
- Streaming emits final-answer text only; Freebuff reasoning and tool traces are intentionally omitted.
- Freebuff is a coding agent. It can use tools and modify the selected `cwd` when prompted. The default working directory is `/tmp/freebuff-api-workspace` to reduce accidental changes.
- Freebuff account limits and model availability still apply.
