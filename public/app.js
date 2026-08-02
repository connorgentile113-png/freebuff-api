const elements = {
  statusLight: document.querySelector('#statusLight'),
  statusText: document.querySelector('#statusText'),
  refreshStatus: document.querySelector('#refreshStatus'),
  modelList: document.querySelector('#modelList'),
  activeModel: document.querySelector('#activeModel'),
  cwd: document.querySelector('#cwdInput'),
  key: document.querySelector('#keyInput'),
  transcript: document.querySelector('#transcript'),
  welcome: document.querySelector('#welcomeCard'),
  form: document.querySelector('#chatForm'),
  prompt: document.querySelector('#promptInput'),
  send: document.querySelector('#sendButton'),
  timer: document.querySelector('#requestTimer'),
  clear: document.querySelector('#clearChat'),
  template: document.querySelector('#messageTemplate'),
};

const state = {
  models: [],
  model: localStorage.getItem('freebuff-model') || 'deepseek/deepseek-v4-flash',
  messages: [],
  busy: false,
  startedAt: 0,
  timerId: null,
};

function headers() {
  const value = elements.key.value.trim();
  return {
    'Content-Type': 'application/json',
    ...(value ? { Authorization: `Bearer ${value}` } : {}),
  };
}

function friendlyModel(id) {
  const tail = id.split('/').at(-1) || id;
  return tail.split('-').map((part) => part === 'v4' ? 'V4' : part === 'v2.5' ? '2.5' : part[0].toUpperCase() + part.slice(1)).join(' ');
}

async function checkHealth() {
  elements.statusText.textContent = 'Checking signal…';
  try {
    const response = await fetch('/health', { headers: headers() });
    if (!response.ok) throw new Error(response.status === 401 ? 'API key required' : 'Bridge unavailable');
    elements.statusLight.classList.add('online');
    elements.statusText.textContent = 'Online · CLI ready';
  } catch (error) {
    elements.statusLight.classList.remove('online');
    elements.statusText.textContent = error.message;
  }
}

function renderModels() {
  elements.modelList.replaceChildren();
  for (const model of state.models) {
    const button = document.createElement('button');
    const provider = model.id.split('/')[0];
    button.type = 'button';
    button.className = `model-button${model.id === state.model ? ' active' : ''}`;
    button.dataset.model = model.id;
    button.innerHTML = `<span><span class="model-name">${friendlyModel(model.id)}</span><br><span class="model-provider">${provider}</span></span><span class="model-check">●</span>`;
    button.addEventListener('click', () => selectModel(model.id));
    elements.modelList.append(button);
  }
  updateActiveModel();
}

function selectModel(id) {
  state.model = id;
  localStorage.setItem('freebuff-model', id);
  document.querySelectorAll('.model-button').forEach((button) => button.classList.toggle('active', button.dataset.model === id));
  updateActiveModel();
}

function updateActiveModel() {
  elements.activeModel.textContent = state.models.some((model) => model.id === state.model) ? friendlyModel(state.model) : 'Choose a model';
}

async function loadModels() {
  try {
    const response = await fetch('/v1/models', { headers: headers() });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Could not load models');
    state.models = data.data;
    if (!state.models.some((model) => model.id === state.model)) state.model = state.models[0]?.id;
    renderModels();
  } catch (error) {
    elements.modelList.innerHTML = `<p class="model-provider">${error.message}</p>`;
  }
}

function addMessage(role, content, isError = false) {
  elements.welcome?.remove();
  const node = elements.template.content.firstElementChild.cloneNode(true);
  node.classList.add(role, ...(isError ? ['error'] : []));
  node.querySelector('.message-role').textContent = role === 'user' ? 'You / outgoing' : isError ? 'Relay error' : 'Freebuff / incoming';
  node.querySelector('time').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const body = node.querySelector('.message-body');
  body.textContent = content;
  node.querySelector('.copy-button').addEventListener('click', async (event) => {
    await navigator.clipboard.writeText(body.textContent);
    event.currentTarget.textContent = 'Copied';
    setTimeout(() => { event.currentTarget.textContent = 'Copy'; }, 1200);
  });
  elements.transcript.append(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return node;
}

async function readSse(response, onContent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  while (!done) {
    const result = await reader.read();
    buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';

    for (const event of events) {
      for (const line of event.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          done = true;
          break;
        }
        const payload = JSON.parse(data);
        if (payload.error) throw new Error(payload.error.message || 'Streaming request failed');
        const content = payload.choices?.[0]?.delta?.content;
        if (content) onContent(content);
      }
      if (done) break;
    }
    if (result.done) done = true;
  }
}

function addThinking() {
  const node = document.createElement('div');
  node.className = 'thinking';
  node.id = 'thinking';
  node.innerHTML = '<span class="thinking-bars"><i></i><i></i><i></i></span><span>Agent signal in progress</span>';
  elements.transcript.append(node);
  node.scrollIntoView({ behavior: 'smooth', block: 'end' });
}

function setBusy(value) {
  state.busy = value;
  elements.send.disabled = value;
  elements.prompt.disabled = value;
  elements.send.querySelector('span').textContent = value ? 'Receiving' : 'Transmit';
  elements.timer.classList.toggle('busy', value);
  clearInterval(state.timerId);
  if (!value) {
    elements.timer.textContent = 'READY';
    return;
  }
  state.startedAt = Date.now();
  const tick = () => { elements.timer.textContent = `LIVE / ${Math.floor((Date.now() - state.startedAt) / 1000)}S`; };
  tick();
  state.timerId = setInterval(tick, 1000);
}

async function sendPrompt(prompt) {
  if (state.busy || !prompt.trim()) return;
  if (!state.model) {
    addMessage('assistant', 'Choose a model before transmitting.', true);
    return;
  }

  const content = prompt.trim();
  state.messages.push({ role: 'user', content });
  addMessage('user', content);
  elements.prompt.value = '';
  setBusy(true);
  addThinking();
  let responseNode;

  try {
    const cwd = elements.cwd.value.trim();
    const response = await fetch('/v1/chat/completions', {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ model: state.model, messages: state.messages, stream: true, ...(cwd ? { cwd } : {}) }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error?.message || `Request failed (${response.status})`);
    }

    let answer = '';
    await readSse(response, (delta) => {
      answer += delta;
      if (!responseNode) {
        document.querySelector('#thinking')?.remove();
        responseNode = addMessage('assistant', '');
        responseNode.classList.add('streaming');
      }
      responseNode.querySelector('.message-body').textContent = answer;
      responseNode.scrollIntoView({ behavior: 'smooth', block: 'end' });
    });
    answer ||= '(No text returned)';
    if (!responseNode) {
      document.querySelector('#thinking')?.remove();
      responseNode = addMessage('assistant', answer);
    }
    responseNode.classList.remove('streaming');
    state.messages.push({ role: 'assistant', content: answer });
  } catch (error) {
    responseNode?.classList.remove('streaming');
    document.querySelector('#thinking')?.remove();
    addMessage('assistant', error.message, true);
  } finally {
    setBusy(false);
    elements.prompt.focus();
  }
}

elements.form.addEventListener('submit', (event) => {
  event.preventDefault();
  sendPrompt(elements.prompt.value);
});
elements.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});
elements.refreshStatus.addEventListener('click', () => Promise.all([checkHealth(), loadModels()]));
elements.key.addEventListener('change', () => Promise.all([checkHealth(), loadModels()]));
elements.clear.addEventListener('click', () => {
  state.messages = [];
  elements.transcript.querySelectorAll('.message, .thinking').forEach((node) => node.remove());
  if (!document.body.contains(elements.welcome)) elements.transcript.prepend(elements.welcome);
});
document.querySelectorAll('.starter').forEach((button) => button.addEventListener('click', () => {
  elements.prompt.value = button.dataset.prompt;
  elements.prompt.focus();
}));

await Promise.all([checkHealth(), loadModels()]);
