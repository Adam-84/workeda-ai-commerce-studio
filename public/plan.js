// public/plan.js — Plan d'action d'une mission : proposition du responsable (appel IA explicite), versions figées,
// décisions de l'utilisateur et avancement déclaré à la main. Valider ne lance rien et n'accorde aucun accès.
import { readReply } from './conversation.js';

export const STEP_LABELS = { todo: 'À faire', doing: 'En cours', blocked: 'Bloquée', done: 'Terminée' };
const STATUS = { proposed: 'Proposition à valider', validated: 'Validée', rejected: 'Refusée' };
const date = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const blankStep = (agentId = null) => ({ action: '', agentId, expected: '', prerequisites: '', state: 'todo' });

export function planBlock({ mission: m, agents, get, send, announce, h, canReply }) {
  const base = `/api/missions/${encodeURIComponent(m.id)}`;
  const nameOf = (id) => agents.find((a) => a.id === id)?.name ?? 'Agent inconnu';
  const responsible = m.assigned_to, canPropose = Boolean(responsible && canReply(responsible));
  const box = h('section', { class: 'mission-plan', 'aria-label': 'Plan d’action' }, h('h4', {}, 'Plan d’action'), h('p', { class: 'note' }, 'Chargement…'));
  const status = h('p', { class: 'chat-send-status', role: 'status' });
  let plans = [], busy = false;
  const fail = (x) => { status.textContent = x.message; status.classList.add('err'); announce(x.message); };
  const ok = (t) => { status.textContent = t; status.classList.remove('err'); announce(t); };
  const load = () => get(`${base}/plans`).then((p) => { plans = p; render(); }).catch((x) => box.replaceChildren(h('h4', {}, 'Plan d’action'), h('p', { class: 'err' }, x.message)));

  async function propose(revision) {
    if (busy) return;
    busy = true; status.textContent = ''; render();
    const who = nameOf(responsible), progress = h('p', { class: 'note plan-progress' }, `${who} prépare ${revision ? 'une révision du plan' : 'un plan'}…`);
    status.before(progress);
    let chars = 0, done = false;
    try {
      await readReply(`${base}/plan/propose`, (ev) => {
        if (ev.type === 'text') { chars += ev.text.length; progress.textContent = `${who} prépare ${revision ? 'une révision du plan' : 'un plan'}… (${chars} caractères reçus)`; }
        else if (ev.type === 'done') done = true; else if (ev.type === 'error') throw new Error(ev.error);
      }, revision ? { revision } : {});
      if (!done) throw new Error('La proposition s’est interrompue avant la fin.');
      busy = false; await load(); ok(`Nouvelle version proposée par ${who} : c’est une proposition, à valider ou non.`);
    } catch (x) { busy = false; render(); fail(new Error(`${who} n’a pas pu proposer de plan. ${x.message}`)); }
  }
  const decide = async (p, decision, note) => {
    try { await send('POST', `${base}/plans/${encodeURIComponent(p.id)}/decision`, { decision, note }); await load(); ok(decision === 'validated' ? `Version ${p.version} validée. Rien n’est exécuté et aucun accès n’est accordé.` : `Version ${p.version} refusée.`); }
    catch (x) { fail(x); }
  };
  const setState = async (p, s, state) => {
    try { await send('PUT', `${base}/plans/${encodeURIComponent(p.id)}/steps/${encodeURIComponent(s.id)}`, { state }); await load(); ok(`Étape « ${s.action} » : ${STEP_LABELS[state].toLowerCase()} (déclaré par vous).`); }
    catch (x) { await load(); fail(x); }
  };

  const actions = (p) => {
    const note = h('textarea', { rows: 2, maxlength: 2000, placeholder: 'Commentaire de décision ou indications de révision', 'aria-label': 'Commentaire de décision ou indications de révision' });
    const act = (label, cls, fn) => h('button', { type: 'button', class: cls, disabled: busy, onclick: fn }, label);
    return h('div', { class: 'plan-actions' }, note,
      h('div', { class: 'memory-actions' },
        p.status !== 'validated' && act(`Valider la version ${p.version}`, 'primary', () => decide(p, 'validated', note.value)),
        p.status !== 'rejected' && act('Refuser', false, () => decide(p, 'rejected', note.value)),
        act('Modifier le plan', false, () => edit(p)),
        canPropose && act('Demander une révision', false, () => {
          if (!note.value.trim()) { fail(new Error('Écrivez vos indications de révision dans le champ ci-dessus.')); note.focus(); return; }
          propose(note.value.trim());
        })));
  };
  const version = (p, current) => {
    const last = p.decisions.at(-1);
    return h('div', { class: current ? 'plan-version current' : 'plan-version' },
      h('p', { class: 'plan-head' }, h('strong', {}, `Version ${p.version} · ${STATUS[p.status]}`),
        ` · ${p.origin === 'ai' ? `proposée par ${nameOf(p.authorAgentId)}` : 'rédigée par vous'} le ${date(p.createdAt)}${last ? ` · ${last.decision === 'validated' ? 'validée' : 'refusée'} par vous le ${date(last.createdAt)}` : ''}`),
      p.status === 'proposed' && h('p', { class: 'plan-warning' }, 'Proposition non validée : ce n’est pas une décision.'),
      p.revisionNote && h('p', { class: 'note' }, `Révision demandée : ${p.revisionNote}`),
      p.decisions.filter((d) => d.note).map((d) => h('p', { class: 'note' }, `Votre commentaire (${d.decision === 'validated' ? 'validation' : 'refus'}, ${date(d.createdAt)}) : ${d.note}`)),
      h('ol', { class: 'plan-steps' }, p.steps.map((s) => h('li', { class: `plan-step ${s.state}` },
        h('p', {}, h('strong', {}, s.action)),
        h('p', { class: 'note' }, `Responsable : ${s.agentId ? nameOf(s.agentId) : 'à désigner'}`),
        s.expected && h('p', { class: 'note' }, `Résultat attendu : ${s.expected}`),
        s.prerequisites && h('p', { class: 'note' }, `Prérequis : ${s.prerequisites}`),
        current
          ? h('label', { class: 'plan-state' }, 'État, déclaré par vous', h('select', { disabled: busy, onchange: (e) => setState(p, s, e.target.value) }, Object.entries(STEP_LABELS).map(([k, l]) => h('option', { value: k, selected: k === s.state }, l))))
          : h('p', { class: 'note' }, `État : ${STEP_LABELS[s.state] ?? s.state}`),
        current && s.stateUpdatedAt && h('p', { class: 'note' }, `Avancement déclaré par vous le ${date(s.stateUpdatedAt)}`)))),
      p.missing && [h('p', { class: 'note' }, h('strong', {}, 'Informations manquantes')), h('p', { class: 'pre' }, p.missing)],
      current && actions(p));
  };

  function render() {
    const cur = plans[0], old = plans.slice(1);
    const who = !responsible ? 'Désignez un responsable pour qu’il puisse proposer un plan.'
      : !canPropose ? `${nameOf(responsible)} n’a pas de fiche dans .claude/agents : il ne peut pas proposer de plan.`
      : `« ${cur ? 'Proposer un nouveau plan' : 'Proposer un plan'} » et « Demander une révision » sont des appels à Claude Code : ${nameOf(responsible)}, responsable, prépare les étapes à partir de l’objectif, des contraintes, de la mémoire, des échanges de la mission et de ses consignes.`;
    box.replaceChildren(h('h4', {}, 'Plan d’action'),
      h('p', { class: 'note' }, 'Un plan reste une proposition tant que vous ne validez pas une version précise. Valider ne lance aucune étape et n’accorde aucun accès : ni Shopify, ni web, ni fichiers, ni commandes. L’avancement des étapes est déclaré par vous.'),
      cur ? version(cur, true) : h('p', { class: 'note' }, 'Aucun plan pour le moment.'),
      h('p', { class: 'note' }, who),
      h('div', { class: 'memory-actions' },
        h('button', { type: 'button', class: cur ? false : 'primary', disabled: busy || !canPropose, onclick: () => propose('') }, cur ? 'Proposer un nouveau plan' : 'Proposer un plan'),
        !cur && h('button', { type: 'button', disabled: busy, onclick: () => edit(null) }, 'Rédiger moi-même')),
      status,
      old.length ? h('details', {}, h('summary', {}, `Versions précédentes (${old.length})`), old.map((p) => version(p, false))) : '');
  }

  // Édition : tout enregistrement crée une nouvelle version, à valider ; la version d'origine reste intacte.
  function edit(p) {
    const rows = (p?.steps ?? [blankStep(responsible)]).map((s) => ({ ...s }));
    const missing = h('textarea', { rows: 2, maxlength: 4000 }, p?.missing ?? ''), list = h('ol', { class: 'plan-editor' }), err = h('p', { class: 'err', role: 'alert' });
    const sync = () => list.querySelectorAll(':scope > li').forEach((li, i) => {
      for (const k of ['action', 'expected', 'prerequisites']) rows[i][k] = li.querySelector(`[name=${k}]`).value;
      rows[i].agentId = li.querySelector('[name=agentId]').value || null;
    });
    const move = (i, d) => { sync(); [rows[i], rows[i + d]] = [rows[i + d], rows[i]]; draw(); list.children[i + d].querySelector('textarea').focus(); };
    const draw = () => list.replaceChildren(...rows.map((r, i) => h('li', { class: 'plan-edit-step' },
      h('label', {}, `Étape ${i + 1} : action`, h('textarea', { name: 'action', rows: 2, maxlength: 500, required: true }, r.action)),
      h('label', {}, 'Responsable', h('select', { name: 'agentId' }, h('option', { value: '' }, 'À désigner'), agents.map((a) => h('option', { value: a.id, selected: a.id === r.agentId }, a.name)))),
      h('label', {}, 'Résultat attendu', h('textarea', { name: 'expected', rows: 2, maxlength: 1000 }, r.expected)),
      h('label', {}, 'Prérequis (facultatif)', h('textarea', { name: 'prerequisites', rows: 1, maxlength: 1000 }, r.prerequisites)),
      h('div', { class: 'memory-actions' },
        h('button', { type: 'button', disabled: i === 0, 'aria-label': `Monter l’étape ${i + 1}`, onclick: () => move(i, -1) }, '↑ Monter'),
        h('button', { type: 'button', disabled: i === rows.length - 1, 'aria-label': `Descendre l’étape ${i + 1}`, onclick: () => move(i, 1) }, '↓ Descendre'),
        h('button', { type: 'button', disabled: rows.length === 1, 'aria-label': `Retirer l’étape ${i + 1}`, onclick: () => { sync(); rows.splice(i, 1); draw(); } }, 'Retirer')))));
    const f = h('form', { class: 'plan-form', onsubmit: async (e) => {
      e.preventDefault(); sync(); err.textContent = '';
      try { const saved = await send('PUT', `${base}/plan`, { steps: rows, missing: missing.value }); await load(); ok(`Version ${saved.version} enregistrée : à valider.`); }
      catch (x) { err.textContent = x.message; }
    } },
      h('p', { class: 'note' }, p
        ? `Vos changements créeront la version ${p.version + 1}, à valider. La version ${p.version}${p.status === 'validated' ? ', validée,' : ''} reste conservée telle quelle.`
        : 'Votre plan sera enregistré comme version 1, à valider.'),
      list,
      h('button', { type: 'button', onclick: () => { sync(); rows.push(blankStep()); draw(); list.lastChild.querySelector('textarea').focus(); } }, 'Ajouter une étape'),
      h('label', {}, 'Informations manquantes', missing),
      h('div', { class: 'memory-actions' }, h('button', { type: 'submit', class: 'primary' }, 'Enregistrer comme nouvelle version'), h('button', { type: 'button', onclick: render }, 'Annuler'), err));
    draw();
    box.replaceChildren(h('h4', {}, 'Plan d’action'), f);
    list.querySelector('textarea').focus();
  }

  load();
  return box;
}
