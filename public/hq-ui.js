// public/hq-ui.js — tableau de bord, équipe, missions, menu « Plus » et réglages d'exploitation.
import { buildDashboard, readOperations, DECISIONS } from './dashboard-view.js';
import { ALERT_KINDS, snapshot, newAlerts } from './alerts.js';

const STATUS = { idle: 'En attente', working: 'Au travail', waiting: 'Attend une réponse', blocked: 'Bloqué' };
const MISSION_STATES = { draft: 'Brouillon', pending_approval: 'À valider', queued: 'En file', running: 'En cours', review: 'À vérifier', blocked: 'Bloquée', failed: 'En échec', expired: 'Expirée', done: 'Terminée', cancelled: 'Annulée' };
const PREFS_KEY = 'archipel.alerts';
const prefs = () => { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) ?? {}; } catch { return {}; } };
const optional = (promise) => promise.catch(() => null);

export function homeView({ ui, open }) {
  const { h, get, send, announce } = ui;
  const cards = h('div', { class: 'hq-cards', 'aria-live': 'polite' }, h('p', {}, 'Chargement…'));
  const todo = h('section'), controls = h('section'), err = h('p', { class: 'err', role: 'alert' });
  const act = async (run, done) => { err.textContent = ''; try { await run(); if (done) announce(done); await load(); } catch (e) { err.textContent = e.message; } };
  const button = (label, run, cls) => h('button', { type: 'button', class: cls, onclick: run }, label);

  async function load() {
    const [agents, missions, notifications, memoryPending, automations, usage, integrations, localHealth, engines, operations] = await Promise.all([
      '/api/agents', '/api/missions', '/api/comm/notifications', '/api/memory?state=pending', '/api/automations', '/api/comm/usage', '/api/integrations', '/api/health', '/api/engines'
    ].map((path) => optional(get(path))).concat(readOperations(get)));
    cards.replaceChildren(...buildDashboard({ agents, missions, notifications, memoryPending, automations, usage, integrations, engines, operations, localHealth }).map((c) => {
      const body = [h('span', { class: 'hq-label' }, c.label), h('strong', {}, c.value), c.detail ? h('span', { class: 'note' }, c.detail) : null];
      return c.open ? h('button', { type: 'button', class: `hq-card tone-${c.tone}`, onclick: () => open(c.open) }, body) : h('div', { class: `hq-card tone-${c.tone}` }, body);
    }));
    const waiting = (notifications ?? []).filter((n) => DECISIONS.includes(n.type)).slice(0, 20);
    todo.replaceChildren(h('h3', {}, 'À valider'), ...(waiting.length || memoryPending?.length ? [h('ul', { class: 'hq-list' },
      waiting.map((n) => h('li', {}, h('button', { type: 'button', onclick: () => open('comm', { thread: n.threadId }) }, h('strong', {}, n.title), h('span', { class: 'note' }, n.detail)))),
      (memoryPending ?? []).slice(0, 20).map((m) => h('li', {}, h('button', { type: 'button', onclick: () => open('memory', { item: m.id }) }, h('strong', {}, 'Souvenir proposé'), h('span', { class: 'note' }, m.title)))))]
      : [h('p', {}, notifications ? 'Rien à valider.' : 'Indisponible.')]));
    drawControls(operations, automations);
  }

  function drawControls(operations, automations) {
    if (operations === false) {
      controls.replaceChildren(h('h3', {}, 'Exploitation'), h('p', { class: 'note' }, 'Réglages indisponibles : le serveur n’a pas répondu. Actualisez.'));
    } else if (operations) {
      const stop = operations.halted
        ? button('Reprendre l’activité…', () => { if (confirm('Reprendre ? Les missions en file pourront de nouveau partir. Les calendriers retrouvent leur état d’avant l’arrêt.')) act(() => send('POST', '/api/operations/stop', { halted: false }), 'Activité reprise'); }, 'primary')
        : button('Arrêt général…', () => { if (confirm('Arrêt général ? Plus aucune mission ni automatisation ne partira. Une demande IA déjà envoyée ne peut pas être rappelée.')) act(() => send('POST', '/api/operations/stop', { halted: true }), 'Arrêt général actif'); }, 'danger');
      controls.replaceChildren(h('h3', {}, 'Exploitation'), h('div', { class: 'hq-actions' }, stop,
        button('Sauvegarder maintenant', () => act(() => send('POST', '/api/operations/backup', {}), 'Bases sauvegardées')),
        button('Se déconnecter', () => act(async () => { await send('POST', '/auth/logout', {}); location.replace('/login.html'); })),
        button('Déconnecter tous les appareils…', () => { if (confirm('Fermer toutes les sessions, y compris celle-ci ?')) act(async () => { await send('POST', '/auth/revoke', {}); location.replace('/login.html'); }); })));
    } else if (automations) {
      const paused = automations.status.paused;
      controls.replaceChildren(h('h3', {}, 'Exploitation'), h('div', { class: 'hq-actions' },
        button(paused ? 'Reprendre les calendriers' : 'Suspendre toutes les automatisations', () => act(() => send('POST', '/api/automations/pause', { paused: !paused }), paused ? 'Calendriers repris' : 'Automatisations suspendues'), paused ? 'primary' : 'danger')),
        h('p', { class: 'note' }, 'En mode local, cette suspension vise les automatisations. Les missions déjà en file se gèrent dans Comms.'));
    } else controls.replaceChildren();
  }

  load().catch((e) => { err.textContent = e.message; });
  return h('div', { class: 'hq' }, h('h2', {}, 'Tableau de bord'), err, cards, todo, controls, button('Actualiser', () => act(async () => {}, 'Tableau de bord actualisé')));
}

export function teamView({ ui, agents, departmentName, openAgent }) {
  const { h } = ui;
  return h('div', { class: 'hq' }, h('h2', {}, 'Équipe'), h('ul', { class: 'hq-list' }, agents.map((a) => h('li', {}, h('button', { type: 'button', onclick: () => openAgent(a.id) },
    h('strong', {}, a.name), h('span', { class: 'note' }, `${a.role} · ${departmentName(a.department_id)}`), h('span', {}, h('span', { class: `dot ${a.status}` }), a.enabled === false ? 'Désactivé' : STATUS[a.status] ?? a.status))))),
    h('p', { class: 'note' }, 'Pour recruter, ouvrez le bureau des agents et choisissez un département.'));
}

export function missionsView({ ui, agents, missions, openMission, create }) {
  const { h, announce } = ui;
  const nameOf = (id) => agents.find((a) => a.id === id)?.name ?? 'Sans responsable';
  const title = h('input', { name: 'title', required: true, maxlength: 120 });
  const who = h('select', { name: 'assignedTo' }, h('option', { value: '' }, 'Sans agent'), agents.map((a) => h('option', { value: a.id }, a.name)));
  const err = h('p', { class: 'err', role: 'alert' });
  const form = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; try { await create({ title: title.value, ...(who.value ? { assignedTo: who.value } : {}) }); announce('Mission créée (validation requise)'); } catch (x) { err.textContent = x.message; } } },
    h('label', {}, 'Nouvelle mission', title), h('label', {}, 'Responsable', who), h('button', { type: 'submit', class: 'primary' }, 'Créer la mission'), err);
  const open = (m) => !['done', 'cancelled'].includes(m.state);
  const sorted = [...missions].sort((a, b) => Number(open(b)) - Number(open(a)));
  return h('div', { class: 'hq' }, h('h2', {}, 'Missions'), form, h('h3', {}, 'Suivi'), sorted.length ? h('ul', { class: 'hq-list' }, sorted.map((m) => {
    const body = [h('strong', {}, m.title), h('span', { class: 'note' }, `${nameOf(m.assigned_to)} · ${MISSION_STATES[m.state] ?? m.state} · validation ${m.requiresApproval ? 'requise' : 'non requise'}`)];
    return h('li', {}, m.assigned_to ? h('button', { type: 'button', onclick: () => openMission(m) }, body) : h('div', {}, body));
  })) : h('p', {}, 'Aucune mission.'));
}

export function moreView({ ui, entries }) {
  const { h } = ui;
  return h('div', { class: 'hq' }, h('h2', {}, 'Plus'), h('ul', { class: 'hq-list' }, entries.map(([label, hint, run]) => h('li', {}, h('button', { type: 'button', onclick: run }, h('strong', {}, label), h('span', { class: 'note' }, hint))))));
}

export function alertsView({ ui }) {
  const { h, announce } = ui, current = prefs();
  const supported = 'Notification' in window;
  const state = h('p', { class: 'note', role: 'status' });
  const describe = () => { state.textContent = !supported ? 'Cet appareil n’affiche pas de notifications ici : les alertes sont seulement annoncées dans l’application.' : Notification.permission === 'granted' ? 'Notifications de l’appareil autorisées.' : Notification.permission === 'denied' ? 'Notifications refusées dans les réglages du navigateur.' : 'Notifications de l’appareil non autorisées.'; };
  describe();
  return h('div', { class: 'hq' }, h('h2', {}, 'Notifications'), h('fieldset', {}, h('legend', {}, 'Me prévenir'), ALERT_KINDS.map((k) => h('label', { class: 'check' },
    h('input', { type: 'checkbox', checked: current[k.id] === true, onchange: (e) => { localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prefs(), [k.id]: e.target.checked })); announce('Préférence enregistrée sur cet appareil'); } }), k.label))),
    supported && Notification.permission === 'default' ? h('button', { type: 'button', class: 'primary', onclick: async (e) => { await Notification.requestPermission(); e.target.hidden = Notification.permission !== 'default'; describe(); } }, 'Autoriser sur cet appareil') : null,
    state, h('p', { class: 'note' }, 'Les alertes arrivent seulement quand Archipel est ouvert ou en arrière-plan. Elles ne contiennent aucun détail de vos données.'));
}

export function startAlerts({ get, announce, everyMs = 30000 }) {
  let previous = null, busy = false;
  async function check() {
    const wanted = prefs();
    if (busy || !Object.values(wanted).some(Boolean)) { if (!busy) previous = null; return; }
    busy = true;
    try {
      // Un relevé incomplet est ignoré : il ferait réapparaître d'anciennes alertes au tour suivant.
      const [notifications, tasks, history] = await Promise.all([get('/api/comm/notifications'), get('/api/comm/tasks?state=done'), get('/api/automations/history')]);
      const operations = await readOperations(get);
      const next = snapshot({ notifications, tasks, history, operations }, previous);
      for (const alert of newAlerts(previous, next, wanted)) {
        const registration = 'Notification' in window && Notification.permission === 'granted' ? await navigator.serviceWorker?.getRegistration() : null;
        if (registration) await registration.showNotification(alert.title, { body: alert.body, tag: alert.kind, icon: '/icons/icon-192.png' }); else announce(alert.body);
      }
      previous = next;
    } catch { /* serveur injoignable : prochain tour */ } finally { busy = false; }
  }
  setInterval(check, everyMs); check();
}
