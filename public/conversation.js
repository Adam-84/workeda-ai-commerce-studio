// Messages enregistrés ; les réponses viennent uniquement de Claude Code côté serveur, jamais simulées ici.
const drafts = new Map();
export const readReply = async (url, onEvent, data) => {
  let res;
  try { res = await fetch(url, data === undefined ? { method: 'POST' } : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }); } catch { throw new Error('Le Studio est injoignable : vérifiez qu’il tourne toujours.'); }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Erreur ${res.status}.`);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    let chunk;
    try { chunk = await reader.read(); } catch { throw new Error('La connexion au Studio a été coupée pendant la réponse.'); }
    if (chunk.done) return;
    buffer += chunk.value;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line.trim()) onEvent(JSON.parse(line)); }
  }
};
const node = (tag, props = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  el.append(...children.flat());
  return el;
};

export function createConversation({ agent, agents, get, send, announce, replies = false }) {
  if (!drafts.has(agent.id)) drafts.set(agent.id, { text: '', busy: false, error: '', saved: false, listeners: new Set(), reply: { busy: false, text: '', error: '' } });
  const draft = drafts.get(agent.id), reply = draft.reply;
  const endpoint = `/api/agents/${encodeURIComponent(agent.id)}/conversation`;
  let pendingText = null, shownPending = false;
  const retry = node('button', { type: 'button', class: 'chat-retry', onclick: () => askReply() }, `Demander la réponse de ${agent.name}`);
  retry.hidden = true;
  let disposed = false, loading = false, nextCursor = null, loaded = false, historyError = '';
  // fresh : id → moment d'arrivée (panneau ouvert). L'apparition continue là où elle en est si la liste est reconstruite.
  const messages = new Map(), fresh = new Map();
  let pendingSince = 0;
  const appear = (t) => { const age = performance.now() - t; return age < 300 ? { cls: ' chat-in', style: `--age:${-Math.round(age)}ms` } : { cls: '' }; };
  const name = (id) => agents.find((a) => a.id === id)?.name ?? 'Agent';
  const list = node('ol', { class: 'chat-list', 'aria-label': `Messages avec ${agent.name}` });
  const scroll = node('div', { class: 'chat-scroll', tabindex: '0', 'aria-label': 'Historique de la discussion' });
  const historyStatus = node('p', { class: 'chat-history-status', role: 'status' });
  const older = node('button', { class: 'chat-older', type: 'button', onclick: () => load() }, 'Messages précédents');
  older.hidden = true;
  scroll.append(older, historyStatus, list, retry);
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
    node('p', { class: 'chat-note', id: `chat-note-${agent.id}` }, replies
      ? `Messages enregistrés dans ce Studio. ${agent.name} répond avec Claude Code, sans outil ni accès aux fichiers ou à Shopify, en s’appuyant sur ses missions et leur mémoire enregistrées ici.`
      : 'Messages enregistrés dans ce Studio. Sans fiche dans .claude/agents, cet agent ne répond pas : vos messages sont seulement conservés.'), scroll, form);

  function sync(message) {
    if (disposed) return;
    if (input.value !== draft.text) input.value = draft.text;
    button.disabled = draft.busy || reply.busy || !draft.text.trim();
    button.textContent = draft.busy ? 'Enregistrement…' : reply.busy ? `${agent.name} répond…` : 'Envoyer';
    const error = draft.error || reply.error;
    status.classList.toggle('err', Boolean(error));
    status.textContent = error || (reply.busy ? `${agent.name} rédige sa réponse…` : draft.saved ? 'Enregistré dans ce Studio.' : '');
    const bottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 60;
    // la réponse finale remplace la bulle « en cours » déjà visible : pas de seconde apparition
    if (message && !messages.has(message.id) && !(shownPending && message.senderType === 'assistant')) fresh.set(message.id, performance.now());
    if (message) messages.set(message.id, message);
    if (message || shownPending !== reply.busy) render();
    else if (pendingText) { pendingText.textContent = reply.text; pendingText.parentElement.classList.toggle('chat-typing', !reply.text); }
    showRetry();
    if (message || bottom) scroll.scrollTop = scroll.scrollHeight;
  }
  const showRetry = () => { retry.hidden = !replies || reply.busy || draft.busy || !loaded || [...messages.values()].sort(order).at(-1)?.senderType !== 'user'; };
  const order = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id, 'en');
  function notify(message) { for (const listener of draft.listeners) listener(message); }

  function render() {
    const ordered = [...messages.values()].sort(order);
    const elements = [];
    let day = '';
    for (const message of ordered) {
      const date = new Date(message.created_at);
      const label = date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
      if (label !== day) { elements.push(node('li', { class: 'chat-day' }, label)); day = label; }
      const own = message.senderType === 'user';
      const author = own ? 'Vous' : message.senderType === 'assistant' ? agent.name : `${name(message.fromAgentId)} → ${name(message.toAgentId)}`;
      const a = fresh.has(message.id) ? appear(fresh.get(message.id)) : { cls: '' };
      elements.push(node('li', { class: `chat-message ${own ? 'chat-own' : 'chat-agent'}${a.cls}`, ...(a.style && { style: a.style }) },
        node('div', { class: 'chat-bubble' }, node('span', { class: 'chat-author' }, author), node('p', {}, message.body),
          node('time', { datetime: message.created_at, title: date.toLocaleString('fr-FR') }, date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })))));
    }
    if (reply.busy && !shownPending) pendingSince = performance.now();
    pendingText = null; shownPending = reply.busy;
    if (reply.busy) {
      pendingText = node('p', {}, reply.text);
      const a = appear(pendingSince);
      elements.push(node('li', { class: `chat-message chat-agent${a.cls}`, ...(a.style && { style: a.style }), 'aria-busy': 'true' },
        node('div', { class: `chat-bubble chat-pending${reply.text ? '' : ' chat-typing'}` },
          node('span', { class: 'chat-author' }, agent.name),
          node('span', { class: 'chat-dots', role: 'img', 'aria-label': `${agent.name} écrit` }, node('i'), node('i'), node('i')), pendingText)));
    }
    list.replaceChildren(...elements); showRetry();
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
    draft.busy = true; draft.error = ''; reply.error = ''; draft.saved = false; notify();
    try {
      const message = await send('POST', endpoint, { body: text });
      if (draft.text === text) draft.text = '';
      draft.saved = true; notify(message); announce('Message enregistré.');
    } catch (error) { draft.error = `${error.message} Votre texte est conservé ; vous pouvez réessayer.`; }
    finally { draft.busy = false; notify(); if (!disposed) input.focus(); }
    if (replies && draft.saved) askReply();
  }

  // Diffuse la réponse réelle de Claude ; l'état vit dans le brouillon pour survivre à la fermeture du panneau.
  async function askReply() {
    if (reply.busy) return;
    reply.busy = true; reply.text = ''; reply.error = ''; draft.saved = false; notify();
    let final = null, warning = '';
    try {
      await readReply(`/api/agents/${encodeURIComponent(agent.id)}/reply`, (event) => {
        if (event.type === 'text') { reply.text += event.text; notify(); }
        else if (event.type === 'done') { final = event.message; warning = event.warning ?? ''; }
        else if (event.type === 'error') throw new Error(event.error);
      });
      if (!final) throw new Error('La réponse s’est interrompue avant la fin.');
      reply.busy = false; reply.text = ''; reply.error = warning; notify(final); announce(warning || `Réponse de ${agent.name} reçue.`);
    } catch (error) {
      reply.error = `${agent.name} n’a pas pu répondre. ${error.message} Votre message reste enregistré.`;
      announce(reply.error);
    } finally { reply.busy = false; reply.text = ''; notify(); }
  }

  draft.listeners.add(sync); sync(); load();
  return { el, destroy() { disposed = true; draft.listeners.delete(sync); } };
}
