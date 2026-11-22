// Interface de communication : Comms Center (fils, délégations, notifications, activité) et onglet « Comms » de la fiche agent.
// Réutilise les briques de app.js (h, get, send, tabset, field) et les classes existantes (bulles de discussion, lignes de liste, pastilles).
// Rien n'est affiché qui ne vienne du serveur : pas de réponse inventée, pas d'activité simulée.
import {
  groupThreads, filterThreads, threadTitle, threadKindLabel, messageKindLabel, deliveryLabel, taskStateLabel, taskActions, taskTree, isOpen,
  dateFr, dueLabel, attemptsLabel, sourceLine, verificationLine, costLine, activeText, runLine, side, NOTIFICATION
} from './comm-view.js';

const enc = encodeURIComponent;
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
const short = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const WEB = ['WebSearch', 'WebFetch'];

// ---------- Comms Center ----------
export function commCenter({ ui, agents = [], departments = [], missions = [], profiles = new Map(), openMemory = () => {}, setLeave = () => {}, initial = null }) {
  const { h, get, send, announce, tabset } = ui;
  const nameOf = (id) => agents.find((a) => a.id === id)?.name ?? 'Agent';
  const canReply = (id) => profiles.has(id);
  const withFiche = agents.filter((a) => profiles.has(a.id) && a.enabled);
  const box = { threads: h('div'), tasks: h('div'), notes: h('div'), activity: h('div') };
  let tabs = null, reload = () => {}, openThreadId = null, draft = '', localDevice = null;
  // Actualisation automatique : jamais pendant que vous écrivez dans un formulaire (le brouillon d'un message est de toute façon conservé).
  const typing = (el) => { const a = document.activeElement; return Boolean(a && el.contains(a) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(a.tagName) && a.type !== 'search') || Boolean(el.querySelector('details[open]')); };
  const onChange = () => {
    if (typing(box.tasks) || (openThreadId === null && typing(box.threads))) return;
    if (openThreadId !== null && draft && box.threads.contains(document.activeElement)) return; // message en cours de rédaction
    reload();
  };
  addEventListener('comm:changed', onChange);
  setLeave(() => removeEventListener('comm:changed', onChange));

  const chip = (text, cls = '') => h('span', { class: `chip soft ${cls}`.trim() }, text);
  const errBox = () => h('p', { class: 'err', role: 'alert' });
  const fail = (el, x) => { el.textContent = x.message; };
  const stateChip = (t) => h('span', { class: `chip comm-state comm-s-${t.state}` }, taskStateLabel(t.state));
  const confirmBtn = (label, sure, fn, cls = '') => {
    let armed = false, timer = null;
    const b = h('button', { type: 'button', class: cls, onclick: async () => {
      if (!armed) { armed = true; b.textContent = sure; timer = setTimeout(() => { armed = false; b.textContent = label; }, 5000); return; }
      clearTimeout(timer); armed = false; b.disabled = true;
      try { await fn(); } catch { b.disabled = false; b.textContent = label; }
    } }, label);
    return b;
  };
  const goThread = (id) => { tabs.select(0, true); showThread(id); };
  const goTask = (id) => { tabs.select(1, true); reload = loadTasks; loadTasks().then(() => document.querySelector(`[data-task="${id}"] .comm-detail-btn`)?.click()); };

  // --- fils ---
  const filters = { query: '', agentId: '' };
  async function showList() {
    openThreadId = null; reload = showList;
    put(box.threads, h('p', { class: 'note', role: 'status' }, 'Chargement des fils…'));
    try {
      const threads = await get('/api/comm/threads');
      const search = h('input', { type: 'search', 'aria-label': 'Rechercher un fil', placeholder: 'Rechercher un fil, un agent, un message…', value: filters.query, oninput: (e) => { filters.query = e.target.value; draw(); } });
      const who = h('select', { 'aria-label': 'Filtrer par agent', onchange: (e) => { filters.agentId = e.target.value; draw(); } }, h('option', { value: '' }, 'Tous les agents'), ...agents.filter((a) => canReply(a.id)).map((a) => h('option', { value: a.id, selected: a.id === filters.agentId }, a.name)));
      const list = h('div');
      const draw = () => {
        const shown = filterThreads(threads, filters, nameOf), groups = groupThreads(shown);
        put(list, groups.length ? groups.map((g) => [h('h3', {}, `${g.label} (${g.threads.length})`), h('ul', { class: 'skill-list' }, g.threads.map((t) => h('li', { class: 'skill-row', 'data-thread': t.id }, h('div', {},
          h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => showThread(t.id) }, threadTitle(t, nameOf)), chip(threadKindLabel(t.kind)), chip(`${t.messageCount} message${t.messageCount > 1 ? 's' : ''}`)),
          h('p', { class: 'note' }, `Participants : ${t.members.map(nameOf).join(', ')}`),
          t.lastMessage && h('p', { class: 'memory-excerpt' }, `${t.lastMessage.senderType === 'user' ? 'Vous' : t.lastMessage.senderType === 'system' ? 'Studio' : 'Agent'} : ${t.lastMessage.body}`)))))])
          : h('p', {}, threads.length ? 'Aucun fil ne correspond.' : 'Aucun fil pour le moment. Créez-en un ci-dessous, ou déléguez une tâche : son fil de mission est créé automatiquement.'));
      };
      put(box.threads, h('p', { class: 'note' }, 'Échanges entre vous et les agents, et entre agents. Un message simple n’appelle aucune IA : un agent ne répond que si vous le lui demandez, ou s’il travaille sur une tâche approuvée.'),
        h('div', { class: 'skill-filters' }, search, who), list, newThreadForm());
      draw();
    } catch (x) { put(box.threads, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  function newThreadForm() {
    const err = errBox(), kind = h('select', { name: 'kind', 'aria-label': 'Type de fil' }, h('option', { value: 'group' }, 'Groupe d’agents'), h('option', { value: 'direct' }, 'Privé (un ou deux agents)'), h('option', { value: 'department' }, 'Département'), h('option', { value: 'mission' }, 'Mission'));
    const dept = h('select', { name: 'department', 'aria-label': 'Département' }, departments.map((d) => h('option', { value: d }, d)));
    const mission = h('select', { name: 'missionId', 'aria-label': 'Mission' }, missions.map((m) => h('option', { value: m.id }, m.title)));
    const title = h('input', { name: 'title', maxlength: 120, placeholder: 'Titre (facultatif)' });
    const boxes = h('fieldset', { class: 'comm-members' }, h('legend', {}, 'Participants'), withFiche.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'member', value: a.id }), ` ${a.name} — ${a.role}`)));
    const sync = () => { const k = kind.value; dept.hidden = k !== 'department'; mission.hidden = k !== 'mission'; boxes.hidden = k === 'department' || k === 'mission'; };
    kind.addEventListener('change', sync);
    const f = h('form', { class: 'memory-form', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const body = { kind: kind.value, title: title.value };
      if (kind.value === 'department') body.department = dept.value; else if (kind.value === 'mission') body.missionId = mission.value; else body.members = [...f.querySelectorAll('input[name=member]:checked')].map((i) => i.value);
      try { const t = await send('POST', '/api/comm/threads', body); announce('Fil prêt'); showThread(t.id); } catch (x) { fail(err, x); }
    } }, h('label', {}, 'Type', kind), dept, mission, boxes, h('label', {}, 'Titre', title), h('button', { type: 'submit', class: 'primary' }, 'Créer ou ouvrir le fil'), err);
    sync();
    return h('details', {}, h('summary', {}, 'Nouveau fil'), f);
  }

  async function showThread(id) {
    const previous = box.threads.querySelector('.comm-scroll'), wasBottom = !previous || previous.scrollHeight - previous.scrollTop - previous.clientHeight < 60, sameThread = openThreadId === id;
    if (!sameThread) draft = '';
    openThreadId = id; reload = () => showThread(id);
    if (!sameThread) put(box.threads, h('p', { class: 'note', role: 'status' }, 'Chargement du fil…'));
    try {
      const [thread, page, act] = await Promise.all([get(`/api/comm/threads/${enc(id)}`), get(`/api/comm/threads/${enc(id)}/messages?limit=50`), get('/api/comm/activity').catch(() => ({ active: [] }))]);
      let items = page.items, cursor = page.nextCursor;
      const list = h('ul', { class: 'chat-list' }), older = h('button', { type: 'button', class: 'chat-older', hidden: !cursor }, 'Messages précédents');
      const draw = () => put(list, items.map(bubble));
      older.addEventListener('click', async () => { older.disabled = true; try { const p = await get(`/api/comm/threads/${enc(id)}/messages?limit=50&before=${enc(cursor)}`); items = [...p.items, ...items]; cursor = p.nextCursor; older.hidden = !cursor; draw(); } catch (x) { announce(x.message); } older.disabled = false; });
      draw();
      const working = new Set(act.active.map((a) => a.agentId));
      const status = h('p', { class: 'chat-send-status', role: 'status' }), err = errBox();
      const input = h('textarea', { name: 'body', 'aria-label': 'Votre message', maxlength: 16000, placeholder: 'Votre message… (Entrée pour envoyer, Maj+Entrée pour un retour à la ligne)' });
      input.value = draft; input.addEventListener('input', () => { draft = input.value; });
      const sendBtn = h('button', { type: 'submit', class: 'primary' }, 'Envoyer');
      const form = h('form', { class: 'chat-composer', onsubmit: async (e) => {
        e.preventDefault(); if (!input.value.trim()) return;
        sendBtn.disabled = true; err.textContent = '';
        try { await send('POST', `/api/comm/threads/${enc(id)}/messages`, { body: input.value }); input.value = ''; draft = ''; status.textContent = 'Enregistré. Aucune IA n’a été sollicitée.'; await showThread(id); announce('Message enregistré'); } catch (x) { fail(err, x); sendBtn.disabled = false; }
      } }, input, h('div', { class: 'chat-composer-actions' }, h('span', { class: 'chat-key-hint' }, 'Entrée : envoyer'), sendBtn), status, err);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
      const replyRow = h('div', { class: 'skill-chips comm-reply' }, h('span', { class: 'note' }, 'Faire répondre :'), thread.members.map((m) => h('button', { type: 'button', disabled: !canReply(m) || working.has(m), title: canReply(m) ? '' : 'Sans fiche dans .claude/agents, cet agent ne peut pas répondre.', onclick: async (e) => {
        e.target.disabled = true; err.textContent = '';
        try { await send('POST', `/api/comm/threads/${enc(id)}/reply`, { agentId: m }); announce(`${nameOf(m)} travaille sur sa réponse`); status.textContent = `${nameOf(m)} répond avec Claude Code (sans outil)…`; ui.pollComm?.(); } catch (x) { fail(err, x); e.target.disabled = false; }
      } }, working.has(m) ? `${nameOf(m)} au travail…` : nameOf(m))));
      put(box.threads, h('button', { type: 'button', onclick: showList }, '← Tous les fils'),
        h('h3', { class: 'mission-title', tabindex: '-1' }, threadTitle(thread, nameOf)),
        h('p', { class: 'note' }, `${threadKindLabel(thread.kind)} · participants : ${thread.members.map((m) => `${nameOf(m)}${working.has(m) ? ' (au travail)' : ''}`).join(', ')}`),
        h('div', { class: 'chat-scroll comm-scroll' }, older, list), replyRow, form,
        h('p', { class: 'note' }, 'Le statut d’un message (envoyé, reçu, traité, erreur) est celui constaté par le Studio pour chaque destinataire. Les messages d’agents viennent tous d’une exécution réelle enregistrée.'));
      if (!sameThread) box.threads.querySelector('.mission-title')?.focus();
      const scroll = box.threads.querySelector('.comm-scroll'); if (scroll && (wasBottom || !sameThread)) scroll.scrollTop = scroll.scrollHeight;
    } catch (x) { put(box.threads, h('button', { type: 'button', onclick: showList }, '← Tous les fils'), h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  function refChip(r) {
    if (r.type === 'masked') return chip(r.label);
    if (r.type === 'memory') return h('button', { type: 'button', class: 'link', onclick: () => openMemory(r.id) }, `Souvenir : ${r.label || r.id.slice(0, 8)}`);
    if (r.type === 'link') return h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.label || r.url);
    if (r.type === 'thread') return h('button', { type: 'button', class: 'link', onclick: () => showThread(r.id) }, `Fil : ${r.label || r.id.slice(0, 8)}`);
    return chip(`${{ mission: 'Mission', result: 'Résultat', message: 'Message' }[r.type] ?? r.type} : ${r.label || r.id.slice(0, 8)}`);
  }
  function bubble(m) {
    const s = side(m);
    const time = h('time', { datetime: m.createdAt }, dateFr(m.createdAt));
    if (s === 'system') return h('li', { class: 'comm-system' }, h('span', { class: 'note' }, `Studio · ${dateFr(m.createdAt)} — ${m.body}`));
    const status = m.deliveries.length > 0 && h('span', { class: `chip comm-status comm-${m.status}`, title: m.deliveries.map((d) => `${nameOf(d.agentId)} : ${deliveryLabel(d.status)}${d.detail ? ` — ${d.detail}` : ''}`).join('\n') || 'Aucun destinataire' }, deliveryLabel(m.status));
    return h('li', { class: `chat-message ${s === 'own' ? 'chat-own' : 'chat-agent'}` }, h('div', { class: 'chat-bubble' },
      h('span', { class: 'chat-author' }, s === 'own' ? 'Vous' : nameOf(m.senderAgentId), m.kind !== 'message' && h('span', { class: 'chip soft comm-kind' }, messageKindLabel(m.kind))),
      h('p', {}, m.body),
      m.refs.length > 0 && h('div', { class: 'skill-chips' }, m.refs.map(refChip)),
      h('div', { class: 'comm-meta' }, time, ' ', status, s === 'agent' && m.runId && h('span', { class: 'note', title: 'Exécution réelle enregistrée par le Studio' }, ` · exécution ${m.runId.slice(0, 8)}`))));
  }

  // --- délégations ---
  async function loadTasks() {
    reload = loadTasks;
    put(box.tasks, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    try {
      const [tasks, status] = await Promise.all([get('/api/comm/tasks'), get('/api/comm/status')]); localDevice = status.device;
      const rows = taskTree(tasks);
      put(box.tasks,
        h('p', { class: 'note' }, 'Une délégation est une sous-mission : un agent n’en demande une à un collègue que dans les limites de sa fiche (champ « collaborates »), et vous validez ses demandes quand la mission l’exige. Une tâche n’est « terminée » qu’avec un résultat vérifié.'),
        rows.length ? h('ul', { class: 'skill-list' }, rows.map(({ task, level }) => taskRow(task, level))) : h('p', {}, 'Aucune délégation pour le moment.'),
        delegateForm());
    } catch (x) { put(box.tasks, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  function taskRow(t, level) {
    const slot = h('div'), err = errBox();
    const act = async (action, body = {}) => { err.textContent = ''; try { await send('POST', `/api/comm/tasks/${enc(t.id)}/${action}`, body); announce('Tâche mise à jour'); ui.pollComm?.(); await loadTasks(); } catch (x) { fail(err, x); throw x; } };
    const buttons = taskActions(t, localDevice).map(([a, label]) => (a === 'cancel' ? confirmBtn(label, 'Confirmer l’annulation', () => act('cancel'), 'danger')
      : a === 'verify' ? h('button', { type: 'button', onclick: () => detail(t, slot, true) }, label) : h('button', { type: 'button', onclick: () => act(a).catch(() => {}) }, label)));
    const detailBtn = h('button', { type: 'button', class: 'comm-detail-btn', onclick: () => detail(t, slot, false) }, 'Détails');
    return h('li', { class: 'skill-row comm-task', 'data-task': t.id, style: `margin-left:${Math.min(level, 3) * 16}px` }, h('div', {},
      h('div', { class: 'skill-chips' }, h('strong', {}, short(t.instruction, 110)), stateChip(t), chip(nameOf(t.assigneeId)), t.kind === 'consolidation' && chip('Consolidation'), t.withCatalog && chip('Catalogue Shopify (lecture seule)'), (t.withIntegrations ?? []).map((i) => chip(({ dsers: 'DSers direct', track17: '17TRACK', manual_import: 'Import manuel', shopify_admin: 'Shopify Admin' }[i] ?? i) + ' (lecture seule)')), t.budgetUsd != null && chip(`Budget ${(t.spentUsd ?? 0).toFixed(2)} / ${t.budgetUsd.toFixed(2)} $`), t.allowWeb && chip('Web en lecture seule')),
      h('p', { class: 'note' }, [`${t.requestedBy === 'user' ? 'Vous' : nameOf(t.requestedBy)} → ${nameOf(t.assigneeId)}`, `niveau ${t.depth}`, dueLabel(t), attemptsLabel(t), t.verified ? 'résultat vérifié' : ''].filter(Boolean).join(' · ')),
      t.stateNote && h('p', { class: 'note' }, t.stateNote), slot, err), h('div', { class: 'comm-actions' }, detailBtn, buttons));
  }
  async function detail(t, slot, verifying) {
    put(slot, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    try {
      const d = await get(`/api/comm/tasks/${enc(t.id)}`), r = d.results.at(-1) ?? null, err = errBox();
      const verify = verifying && t.state === 'review' && h('form', { class: 'memory-form', onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try { await send('POST', `/api/comm/tasks/${enc(t.id)}/verify`, { note: e.target.note.value }); announce('Résultat validé'); ui.pollComm?.(); await loadTasks(); } catch (x) { fail(err, x); }
      } }, h('label', {}, 'Ce que vous avez vérifié (facultatif)', h('input', { name: 'note', maxlength: 300 })), h('button', { type: 'submit', class: 'primary' }, 'J’ai relu ce résultat : le valider'), err);
      put(slot, h('div', { class: 'comm-detail' },
        h('h4', {}, 'Demande'), h('p', { class: 'memory-body' }, d.task.instruction),
        d.task.budgetUsd != null && budgetForm(d.task),
        d.dependsOn.length > 0 && [h('h4', {}, 'Attend'), h('ul', {}, d.dependsOn.map((x) => h('li', {}, `${nameOf(x.assigneeId)} — ${short(x.instruction, 80)} (${taskStateLabel(x.state)})`)))],
        h('h4', {}, 'Résultat'),
        r ? [h('p', { class: r.verified ? 'note' : 'err' }, verificationLine(r)), h('pre', { class: 'skill-content', tabindex: '0', 'aria-label': 'Résultat rendu par l’agent' }, r.body),
          r.sources.length > 0 && [h('h4', {}, 'Sources'), h('ul', {}, r.sources.map((s) => h('li', {}, sourceLine(s))))],
          r.observed && (r.observed.fetched?.length || r.observed.searched?.length) ? h('p', { class: 'note' }, `Consultations réelles de l’agent : ${r.observed.fetched?.length ?? 0} page(s) lue(s), ${r.observed.searched?.length ?? 0} recherche(s).`) : null]
          : h('p', { class: 'note' }, 'Aucun résultat pour le moment.'),
        verify, h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => goThread(t.threadId) }, 'Ouvrir le fil'), ' ', h('button', { type: 'button', onclick: () => put(slot) }, 'Fermer'))));
    } catch (x) { put(slot, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  function budgetForm(t) {
    const err = errBox(), input = h('input', { type: 'number', min: '0.1', max: '100', step: '0.1', value: String(t.budgetUsd), 'aria-label': 'Nouveau budget en dollars' });
    return h('form', { class: 'memory-form', onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; try { await send('POST', `/api/comm/tasks/${enc(t.id)}/budget`, { usd: Number(input.value) }); announce('Budget mis à jour'); ui.pollComm?.(); await loadTasks(); } catch (x) { fail(err, x); } } },
      h('p', { class: 'note' }, `Dépensé : ${(t.spentUsd ?? 0).toFixed(2)} $ sur ${t.budgetUsd.toFixed(2)} $ (coût rapporté par Claude Code${t.unreportedRuns ? `, dont ${t.unreportedRuns} exécution(s) interrompue(s) sans coût rapporté comptée(s) à 0,25 $ chacune : estimation prudente` : ''}).`),
      h('label', {}, 'Budget de la mission ($)', input), h('button', { type: 'submit' }, 'Modifier le budget'), err);
  }
  function delegateForm() {
    const err = errBox(), out = h('p', { class: 'note', role: 'status' });
    const who = h('select', { name: 'assigneeId', required: true, 'aria-label': 'Agent' }, withFiche.map((a) => h('option', { value: a.id }, `${a.name} — ${a.role}`)));
    const webOk = (id) => (profiles.get(id)?.tools ?? []).some((t) => WEB.includes(t));
    const cat = h('input', { type: 'checkbox', name: 'withCatalog' }), budget = h('input', { name: 'budgetUsd', type: 'number', min: '0.1', max: '100', step: '0.1', value: '3', 'aria-label': 'Budget en dollars' });
    const ints = { manual_import: h('input', { type: 'checkbox', name: 'withManualImport' }), shopify_admin: h('input', { type: 'checkbox', name: 'withShopifyAdmin' }), dsers: h('input', { type: 'checkbox', name: 'withDsers' }), track17: h('input', { type: 'checkbox', name: 'withTrack17' }) };
    const web = h('input', { type: 'checkbox', name: 'allowWeb' }), approval = h('input', { type: 'checkbox', name: 'requiresApproval', checked: true });
    const syncWeb = () => { web.disabled = !webOk(who.value); if (web.disabled) web.checked = false; };
    who.addEventListener('change', syncWeb);
    const f = h('form', { class: 'memory-form', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; out.textContent = '';
      const body = { assigneeId: who.value, instruction: f.instruction.value, title: f.title.value || undefined, allowWeb: web.checked, requiresSources: web.checked, requiresApproval: approval.checked, withCatalog: cat.checked, withIntegrations: Object.entries(ints).filter(([, el]) => el.checked).map(([id]) => id), budgetUsd: Number(budget.value) };
      try {
        const r = await send('POST', '/api/comm/delegations', body);
        announce(r.created ? 'Délégation enregistrée' : 'Demande déjà existante');
        out.textContent = r.created ? 'Enregistrée : elle démarre dès qu’un agent est libre.' : r.reused === 'result' ? 'Un résultat vérifié identique existe déjà : il est réutilisé, aucun agent n’est relancé.' : 'Une demande identique est déjà en cours.';
        ui.pollComm?.(); await loadTasks();
      } catch (x) { fail(err, x); }
    } }, h('label', {}, 'Agent', who), h('label', {}, 'Titre (facultatif)', h('input', { name: 'title', maxlength: 120 })),
      h('label', {}, 'Demande', h('textarea', { name: 'instruction', required: true, maxlength: 4000, rows: 4, placeholder: 'Ce que l’agent doit faire, avec le résultat attendu.' })),
      h('label', { class: 'check' }, web, ' Recherche web en lecture seule (WebSearch / WebFetch) — réservée aux agents dont la fiche le prévoit ; sources vérifiées par le Studio'),
      h('label', { class: 'check' }, cat, ' Fournir le catalogue Shopify de workeda.com (relevé daté, en lecture seule : aucune écriture dans la boutique)'),
      h('label', { class: 'check' }, ints.manual_import, ' Fournir les imports manuels nettoyés — accès individuel requis, sans recherche web'),
      h('label', { class: 'check' }, ints.shopify_admin, ' Fournir Shopify Admin (cache seulement) — accès individuel requis, sans recherche web'),
      h('label', { class: 'check' }, ints.dsers, ' Fournir les données DSers (lecture seule, sans données clients) — seulement si l’agent a reçu l’accès dans l’Integration Center ; incompatible avec la recherche web'),
      h('label', { class: 'check' }, ints.track17, ' Fournir les suivis 17TRACK déjà enregistrés (lecture seule, numéros masqués) — même condition'),
      h('label', {}, 'Budget de la mission (coût rapporté par Claude Code, en $)', budget, h('span', { class: 'note' }, 'Au-delà, plus aucune nouvelle exécution ne démarre ; vous pouvez l’augmenter.')),
      h('label', { class: 'check' }, approval, ' Je valide moi-même les délégations que les agents décideront (recommandé)'),
      h('button', { type: 'submit', class: 'primary' }, 'Déléguer'), out, err);
    syncWeb();
    return h('details', {}, h('summary', {}, 'Nouvelle délégation'), f);
  }

  // --- notifications ---
  async function loadNotes() {
    reload = loadNotes;
    try {
      const list = await get('/api/comm/notifications');
      put(box.notes, h('p', { class: 'note' }, 'Ce qui attend votre attention : validations, résultats à vérifier, blocages, échecs et nouveaux messages d’agents.'),
        list.length ? h('ul', { class: 'skill-list' }, list.map((n) => h('li', { class: 'skill-row' }, h('div', {}, h('div', { class: 'skill-chips' }, h('strong', {}, n.title), chip(NOTIFICATION[n.type] ?? n.type), chip(dateFr(n.at))), h('p', { class: 'memory-excerpt' }, n.detail)),
          h('button', { type: 'button', onclick: () => (n.taskId ? goTask(n.taskId) : goThread(n.threadId)) }, 'Ouvrir')))) : h('p', {}, 'Rien à signaler.'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: async () => { await send('POST', '/api/comm/notifications/seen'); announce('Messages marqués comme lus'); ui.pollComm?.(); loadNotes(); } }, 'Marquer les messages comme lus')));
    } catch (x) { put(box.notes, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }

  // --- catalogue Shopify (lecture seule) ---
  function shopSection(s) {
    const err = errBox(), out = h('p', { class: 'note', role: 'status' });
    const btn = h('button', { type: 'button', onclick: async () => { btn.disabled = true; err.textContent = ''; try { const r = await send('POST', '/api/shop/refresh'); announce('Catalogue relevé'); await loadActivity(r.skipped ?? (r.ok === false ? 'Relevé sans résultat : voir les limites ci-dessus.' : 'Catalogue relevé.')); } catch (x) { fail(err, x); btn.disabled = false; } } }, 'Relever le catalogue maintenant');
    const snap = s.snapshot;
    return [h('h3', {}, 'Catalogue Shopify (lecture seule)'),
      h('p', {}, snap ? `Dernier relevé réussi : ${dateFr(snap.fetchedAt)} — ${snap.collections} collection(s), ${snap.products} produit(s) (${s.mode === 'admin' ? 'API Admin' : 'pages publiques de ' + s.domain}).` : 'Aucun relevé réussi pour le moment.'),
      s.lastError && h('p', { class: 'err' }, `Limites du dernier essai : ${s.lastError}`),
      s.misconfigured && h('p', { class: 'err' }, 'Configuration Admin incomplète : mode public utilisé.'),
      h('p', { class: 'note' }, 'Le Studio ne peut rien écrire dans la boutique. Les agents ne reçoivent le catalogue que si vous le demandez pour une délégation ; chaque ordinateur relève le sien. Un relevé n’est refait qu’une fois toutes les 5 minutes.'),
      h('div', { class: 'row' }, btn), out, err];
  }

  // --- activité ---
  async function loadActivity(msg = '') {
    reload = () => loadActivity();
    try {
      const [act, usage, runs, status, check, shop] = await Promise.all([get('/api/comm/activity'), get('/api/comm/usage'), get('/api/comm/runs?limit=30'), get('/api/comm/status'), get('/api/comm/check'), get('/api/shop/status').catch(() => null)]);
      const err = errBox(), out = h('p', { class: 'note', role: 'status' }, msg);
      const sync = h('button', { type: 'button', class: 'primary', onclick: async () => { sync.disabled = true; try { const r = await send('POST', '/api/comm/import'); announce('Journal importé'); await loadActivity(`Journal : ${r.applied} appliqué(s), ${r.superseded} plus ancien(s) conservé(s), ${r.invalid} invalide(s).${r.warnings.length ? ` ${r.warnings.slice(0, 3).join(' ')}` : ''}`); } catch (x) { fail(err, x); sync.disabled = false; } } }, 'Importer le journal des autres ordinateurs');
      put(box.activity,
        h('h3', {}, 'En ce moment'), h('p', { role: 'status' }, activeText(act.active, nameOf)), act.lastPump?.quota && h('p', { class: 'err' }, 'Quota quotidien atteint : les tâches en file attendent demain.'),
        h('p', { class: 'note' }, `${act.maxActive} agents actifs au maximum à la fois. Claude Code ${status.engines.claudeCode ? 'détecté' : 'non détecté'} · Codex ${status.engines.codexCli ? 'détecté' : 'non détecté'} (« détecté » : présent sur le PC, pas forcément connecté).`),
        shop && shopSection(shop),
        h('h3', {}, 'Coûts et quotas'), h('p', {}, costLine(usage)), h('p', { class: 'note' }, usage.note),
        h('h3', {}, 'Historique des exécutions'), runs.length ? h('ul', { class: 'comm-runs' }, runs.map((r) => h('li', {}, `${dateFr(r.startedAt)} — ${runLine(r, nameOf)}`))) : h('p', {}, 'Aucune exécution pour le moment.'),
        h('h3', {}, 'Cohérence'), check.problems.length ? h('ul', {}, check.problems.map((p) => h('li', { class: 'err' }, p))) : h('p', {}, 'Aucun problème détecté.'), check.notes.length > 0 && h('ul', {}, check.notes.map((n) => h('li', { class: 'note' }, n))),
        h('h3', {}, 'Synchronisation entre ordinateurs'), h('p', {}, `Cet ordinateur : ${status.device} · ${check.journalFiles} journal(aux) · ${check.tasks} tâche(s) · ${check.messages} message(s).`),
        status.journalError && h('p', { class: 'err', role: 'alert' }, status.journalError),
        h('p', { class: 'note' }, 'La communication voyage par git (dossier comm/journal/). Après un « git pull », importez le journal : un import recopie des données et ne lance aucun agent.'),
        h('div', { class: 'row' }, sync), out, err);
    } catch (x) { put(box.activity, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }

  tabs = tabset([
    { label: 'Fils', render: () => { showList(); return box.threads; } },
    { label: 'Délégations', render: () => { loadTasks(); return box.tasks; } },
    { label: 'Notifications', render: () => { loadNotes(); return box.notes; } },
    { label: 'Activité', render: () => { loadActivity(); return box.activity; } }
  ], initial?.tab ?? 0, undefined, 'Sections des communications');
  if (initial?.thread) queueMicrotask(() => showThread(initial.thread));
  return h('div', { class: 'agent-detail skills-center comm-center' }, h('header', { class: 'agent-heading' }, h('div', {}, h('h2', {}, 'Comms'), h('p', {}, 'Communication entre les agents d’Archipel'), h('p', { class: 'agent-department' }, 'Fils · Délégations · Notifications · Activité'))), tabs.el);
}

// ---------- onglet « Comms » d'un agent ----------
export function agentCommTab({ ui, agent, nameOf, openThread, openCenter }) {
  const { h, get } = ui;
  const root = h('div', { class: 'skills-tab comm-tab' }, h('p', { class: 'note', role: 'status' }, 'Chargement des échanges…'));
  async function load() {
    try {
      const [threads, tasks, act] = await Promise.all([get(`/api/comm/threads?agentId=${enc(agent.id)}`), get(`/api/comm/tasks?agentId=${enc(agent.id)}`), get('/api/comm/activity')]);
      const working = act.active.some((a) => a.agentId === agent.id), open = tasks.filter(isOpen);
      put(root,
        h('p', { class: working ? '' : 'note', role: 'status' }, working ? `${agent.name} travaille en ce moment (exécution réelle en cours).` : `${agent.name} n’a aucune exécution en cours.`),
        h('h3', {}, `Fils (${threads.length})`),
        threads.length ? h('ul', { class: 'skill-list' }, threads.slice(0, 8).map((t) => h('li', { class: 'skill-row' }, h('div', {}, h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => openThread(t.id) }, threadTitle(t, nameOf)), h('span', { class: 'chip soft' }, threadKindLabel(t.kind))),
          t.lastMessage && h('p', { class: 'memory-excerpt' }, t.lastMessage.body))))) : h('p', {}, 'Aucun fil.'),
        h('h3', {}, `Délégations (${open.length} ouverte${open.length > 1 ? 's' : ''} sur ${tasks.length})`),
        tasks.length ? h('ul', { class: 'skill-list' }, tasks.slice(0, 8).map((t) => h('li', { class: 'skill-row' }, h('div', {}, h('div', { class: 'skill-chips' }, h('strong', {}, short(t.instruction, 80)), h('span', { class: `chip comm-state comm-s-${t.state}` }, taskStateLabel(t.state))),
          h('p', { class: 'note' }, `${t.assigneeId === agent.id ? `De ${t.requestedBy === 'user' ? 'vous' : nameOf(t.requestedBy)}` : `À ${nameOf(t.assigneeId)}`} · niveau ${t.depth}${t.verified ? ' · résultat vérifié' : ''}`))))) : h('p', {}, 'Aucune délégation.'),
        h('div', { class: 'row' }, h('button', { type: 'button', onclick: openCenter }, 'Ouvrir le Comms Center')),
        h('p', { class: 'note' }, 'Les messages et délégations de cet agent viennent d’exécutions réelles ; rien n’est simulé. Il ne contacte jamais un collègue directement : il demande, le Studio contrôle.'));
    } catch (x) { put(root, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  load();
  return root;
}
