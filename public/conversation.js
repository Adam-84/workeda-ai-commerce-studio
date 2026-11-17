// Messages enregistrés seulement : aucune réponse de modèle n'est simulée.
const drafts = new Map();
const node = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  el.append(...children.flat());
  return el;
};

export function createConversation({ agent, agents, get, send, announce }) {
  if (!drafts.has(agent.id)) drafts.set(agent.id, { text: '', busy: false, error: '', saved: false, listeners: new Set() });
  const draft = drafts.get(agent.id);
  const endpoint = `/api/agents/${encodeURIComponent(agent.id)}/conversation`;
  let disposed = false, loading = false, nextCursor = null, loaded = false, historyError = '';
  const messages = new Map();
  const name = (id) => agents.find((a) => a.id === id)?.name ?? 'Agent';
  const list = node('ol', { class: 'chat-list', 'aria-label': `Messages avec ${agent.name}` });
  const scroll = node('div', { class: 'chat-scroll', tabindex: '0', 'aria-label': 'Historique de la discussion' });
  const historyStatus = node('p', { class: 'chat-history-status', role: 'status' });
  const older = node('button', { class: 'chat-older', type: 'button', onclick: () => load() }, 'Messages précédents');
  older.hidden = true;
  scroll.append(older, historyStatus, list);
  const input = node('textarea', {
    rows: '3', placeholder: `Écrire à ${agent.name}…`, 'aria-label': `Votre message pour ${agent.name}`,
    'aria-describedby': `chat-note-${agent.id}`,
    oninput: () => { draft.text = input.value; draft.saved = false; sync(); },
    onkeydown: (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
    }
  });
  const status = node('p', { class: 'chat-send-status', role: 'status' });
  const button = node('button', { type: 'submit', class: 'primary' }, 'Envoyer');
  const form = node('form', { class: 'chat-composer', onsubmit: submit }, input,
    node('div', { class: 'chat-composer-actions' }, node('span', { class: 'chat-key-hint' }, 'Entrée pour envoyer · Maj+Entrée pour une nouvelle ligne'), button), status);
  const el = node('div', { class: 'conversation' },
    node('p', { class: 'chat-note', id: `chat-note-${agent.id}` }, 'Messages enregistrés dans ce Studio. Les réponses IA ne sont pas encore connectées.'), scroll, form);

  function sync(message) {
    if (disposed) return;
    if (input.value !== draft.text) input.value = draft.text;
    button.disabled = draft.busy || !draft.text.trim();
    button.textContent = draft.busy ? 'Enregistrement…' : 'Envoyer';
    status.classList.toggle('err', Boolean(draft.error));
    status.textContent = draft.error || (draft.saved ? 'Enregistré dans ce Studio.' : '');
    if (message) { messages.set(message.id, message); render(); scroll.scrollTop = scroll.scrollHeight; }
  }
  function notify(message) { for (const listener of draft.listeners) listener(message); }

  function render() {
    const ordered = [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id, 'en'));
    const elements = [];
    let day = '';
    for (const message of ordered) {
      const date = new Date(message.created_at);
      const label = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      if (label !== day) { elements.push(node('li', { class: 'chat-day' }, label)); day = label; }
      const own = message.senderType === 'user';
      const author = own ? 'Vous' : `${name(message.fromAgentId)} → ${name(message.toAgentId)}`;
      elements.push(node('li', { class: `chat-message ${own ? 'chat-own' : 'chat-agent'}` },
        node('div', { class: 'chat-bubble' }, node('span', { class: 'chat-author' }, author), node('p', {}, message.body),
          node('time', { datetime: message.created_at, title: date.toLocaleString('fr-FR') }, date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })))));
    }
    list.replaceChildren(...elements);
    historyStatus.textContent = historyError || (loaded && !messages.size ? `Votre discussion avec ${agent.name} commence ici. Écrivez votre premier message.` : '');
    older.hidden = loaded && !nextCursor && !historyError;
    older.textContent = historyError ? 'Réessayer le chargement' : loaded ? 'Messages précédents' : 'Charger l’historique';
  }

  async function load() {
    if (loading || disposed) return;
    loading = true; older.disabled = true;
    const first = !loaded, height = scroll.scrollHeight, top = scroll.scrollTop;
    historyStatus.textContent = 'Chargement des messages…';
    try {
      const page = await get(endpoint + (nextCursor ? `?before=${encodeURIComponent(nextCursor)}` : ''));
      if (disposed) return;
      for (const message of page.items) messages.set(message.id, message);
      nextCursor = page.nextCursor; loaded = true; historyError = ''; render();
      scroll.scrollTop = first ? scroll.scrollHeight : top + scroll.scrollHeight - height;
    } catch (error) {
      if (disposed) return;
      historyError = `Messages indisponibles : ${error.message}`;
      render();
    } finally {
      loading = false;
      if (!disposed) older.disabled = false;
    }
  }

  async function submit(event) {
    event.preventDefault();
    if (draft.busy || !draft.text.trim()) return;
    const text = draft.text;
    draft.busy = true; draft.error = ''; draft.saved = false; notify();
    try {
      const message = await send('POST', endpoint, { body: text });
      if (draft.text === text) draft.text = '';
      draft.saved = true; notify(message); announce('Message enregistré.');
    } catch (error) { draft.error = `${error.message} Votre texte est conservé ; vous pouvez réessayer.`; }
    finally { draft.busy = false; notify(); if (!disposed) input.focus(); }
  }

  draft.listeners.add(sync); sync(); load();
  return { el, destroy() { disposed = true; draft.listeners.delete(sync); } };
}
