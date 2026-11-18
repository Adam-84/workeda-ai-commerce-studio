// public/missions.js — onglet Missions d'un agent : liste, fiche, création et modification.
// Enregistrer une mission ne sollicite aucun agent et n'appelle aucune IA ; seul le fil d'équipe fait répondre les agents désignés.
import { readReply } from './conversation.js';
import { planBlock } from './plan.js';
export const PRIORITY_LABELS = { low: 'Basse', normal: 'Normale', high: 'Haute', urgent: 'Urgente' };
const STATE_LABELS = { draft: 'Brouillon' };
const MEMORY_LABELS = { fact: 'Fait', decision: 'Décision', open: 'Point ouvert' };
const date = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const BLANK = { title: '', objective: '', collaborators: [], priority: 'normal', expectedResult: '', contextText: '', contextLinks: [], constraints: '', validations: '', requiresApproval: true };

// missions : () => liste à jour ; save(method, path, data) enregistre puis recharge l'état, et renvoie la mission.
export function missionsTab({ agent, agents, missions, save, get, send, announce, h, canReply = () => false }) {
  const root = h('div', { class: 'missions' });
  const nameOf = (id) => agents.find((a) => a.id === id)?.name ?? 'Agent inconnu';
  const field = (label, control, hint) => h('label', {}, label, control, hint && h('span', { class: 'note' }, hint));
  const heading = (text) => h('h3', { class: 'mission-title', tabindex: '-1' }, text);
  const show = (...kids) => { root.replaceChildren(...kids.flat().filter((k) => k !== false)); root.querySelector('.mission-title')?.focus(); };

  function list() {
    const mine = missions().filter((m) => m.assigned_to === agent.id || m.requested_by === agent.id || m.collaborators.includes(agent.id));
    const role = (m) => (m.assigned_to === agent.id ? 'Responsable' : m.collaborators.includes(agent.id) ? 'Collaborateur' : 'Demandeur');
    show(heading('Missions de ' + agent.name),
      mine.length ? h('ul', { class: 'mission-list' }, mine.map((m) => h('li', {}, h('button', { type: 'button', onclick: () => sheet(m.id) },
        h('strong', {}, m.title), h('span', { class: 'note' }, `${role(m)} · priorité ${PRIORITY_LABELS[m.priority]?.toLowerCase() ?? m.priority} · ${STATE_LABELS[m.state] ?? m.state}`)))))
        : h('p', {}, 'Aucune mission pour le moment.'),
      h('button', { type: 'button', class: 'primary', onclick: () => edit() }, 'Donner une mission'));
  }

  function sheet(id) {
    const m = missions().find((x) => x.id === id); if (!m) return list();
    const block = (label, value) => [h('h4', {}, label), value ? h('p', { class: 'pre' }, value) : h('p', { class: 'note' }, 'Non renseigné')];
    const memory = memoryBlock(m);
    show(h('button', { type: 'button', onclick: list }, '← Missions'), heading(m.title),
      h('p', { class: 'note' }, `Priorité ${PRIORITY_LABELS[m.priority]?.toLowerCase() ?? m.priority} · ${STATE_LABELS[m.state] ?? m.state} · validation ${m.requiresApproval ? 'requise' : 'non requise'}`),
      block('Objectif', m.objective),
      block('Responsable', m.assigned_to ? nameOf(m.assigned_to) : ''),
      block('Collaborateurs', m.collaborators.map(nameOf).join(', ')),
      block('Résultat attendu', m.expectedResult),
      block('Contexte', m.contextText),
      m.contextLinks.length > 0 && [h('h4', {}, 'Liens de référence'),
        h('ul', {}, m.contextLinks.map((url) => h('li', {}, h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url)))),
        h('p', { class: 'note' }, 'Liens enregistrés comme simples références : leur contenu n’a pas été consulté.')],
      block('Contraintes', m.constraints),
      block('Validations nécessaires', m.validations),
      planBlock({ mission: m, agents, get, send, announce, h, canReply }),
      memory.el, teamBlock(m, memory),
      h('p', { class: 'note mission-dates' }, `Créée le ${date(m.created_at)}${m.updatedAt ? ` · modifiée le ${date(m.updatedAt)}` : ''}`),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => edit(m) }, 'Modifier'), h('button', { type: 'button', onclick: list }, 'Retour à la liste')));
  }

  // Mémoire : notes datées saisies à la main ; corriger ou archiver, jamais effacer.
  function memoryBlock(m) {
    const box = h('section', { class: 'mission-memory', 'aria-label': 'Mémoire de la mission' }, h('h4', {}, 'Mémoire de la mission'), h('p', { class: 'note' }, 'Chargement…'));
    const base = `/api/missions/${encodeURIComponent(m.id)}/memory`, status = h('p', { class: 'err', role: 'alert' });
    const load = () => get(base).then(render).catch((x) => box.replaceChildren(h('h4', {}, 'Mémoire de la mission'), h('p', { class: 'err' }, x.message)));
    const noteForm = (v, label, submit, cancel) => {
      const err = h('p', { class: 'err', role: 'alert' }), btn = h('button', { type: 'submit', class: 'primary' }, label);
      const f = h('form', { class: 'memory-form', onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; btn.disabled = true;
        const fd = new FormData(f);
        try { await submit({ kind: fd.get('kind'), sourceAgentId: fd.get('sourceAgentId') || null, body: fd.get('body') }); } catch (x) { err.textContent = x.message; btn.disabled = false; }
      } },
        h('div', { class: 'memory-pick' },
          field('Type', h('select', { name: 'kind' }, Object.entries(MEMORY_LABELS).map(([k, l]) => h('option', { value: k, selected: k === v.kind }, l)))),
          field('Source', h('select', { name: 'sourceAgentId' }, h('option', { value: '' }, 'Vous'), agents.map((a) => h('option', { value: a.id, selected: a.id === v.sourceAgentId }, a.name))))),
        field('Note', h('textarea', { name: 'body', rows: 2, maxlength: 4000, required: true }, v.body)),
        h('div', { class: 'memory-actions' }, btn, cancel && h('button', { type: 'button', onclick: cancel }, 'Annuler'), err));
      return f;
    };
    const item = (e) => {
      const li = h('li', { class: e.archivedAt ? 'memory-entry archived' : 'memory-entry' },
        h('p', { class: 'memory-meta' }, h('strong', {}, MEMORY_LABELS[e.kind] ?? e.kind),
          ` · ${date(e.createdAt)} · source : ${e.sourceAgentId ? nameOf(e.sourceAgentId) : 'vous'}, saisie manuelle${e.updatedAt ? ` · corrigée le ${date(e.updatedAt)}` : ''}${e.archivedAt ? ` · archivée le ${date(e.archivedAt)}` : ''}`),
        h('p', { class: 'pre' }, e.body),
        h('div', { class: 'memory-actions' },
          !e.archivedAt && h('button', { type: 'button', onclick: () => {
            li.replaceChildren(noteForm(e, 'Enregistrer la correction', async (data) => { await send('PUT', `${base}/${encodeURIComponent(e.id)}`, data); announce('Note corrigée'); await load(); }, load));
            li.querySelector('textarea').focus();
          } }, 'Corriger'),
          h('button', { type: 'button', onclick: async () => {
            status.textContent = '';
            try { await send('PUT', `${base}/${encodeURIComponent(e.id)}`, { archived: !e.archivedAt }); announce(e.archivedAt ? 'Note restaurée' : 'Note archivée'); await load(); } catch (x) { status.textContent = x.message; }
          } }, e.archivedAt ? 'Restaurer' : 'Archiver')));
      return li;
    };
    function render(entries) {
      const live = entries.filter((e) => !e.archivedAt), old = entries.filter((e) => e.archivedAt);
      box.replaceChildren(h('h4', {}, 'Mémoire de la mission'),
        h('p', { class: 'note' }, 'Notes datées saisies à la main. Les agents de la mission les lisent quand ils répondent, dans Discussion comme dans le fil d’équipe (notes archivées exclues).'),
        noteForm({ kind: 'fact', sourceAgentId: null, body: '' }, 'Ajouter à la mémoire', async (data) => {
          await send('POST', base, data); announce('Note ajoutée à la mémoire'); await load(); box.querySelector('textarea')?.focus();
        }),
        status,
        live.length ? h('ul', { class: 'memory-list' }, live.map(item)) : h('p', { class: 'note' }, 'Aucune note pour le moment.'),
        old.length ? h('details', {}, h('summary', {}, `Notes archivées (${old.length})`), h('ul', { class: 'memory-list' }, old.map(item))) : '');
    }
    load();
    return { el: box, load, noteForm };
  }

  // Fil d'équipe : vous écrivez, puis cochez qui répond, responsable d'abord. Chaque réponse est un appel réel à Claude Code.
  function teamBlock(m, memory) {
    const base = `/api/missions/${encodeURIComponent(m.id)}/discussion`;
    const members = [m.assigned_to, ...m.collaborators].filter(Boolean), speakers = members.filter(canReply), silent = members.filter((id) => !canReply(id));
    const box = h('section', { class: 'mission-team', 'aria-label': 'Discussion d’équipe' }, h('h4', {}, 'Discussion d’équipe'));
    if (!members.length) { box.append(h('p', { class: 'note' }, 'Ajoutez un responsable ou des collaborateurs pour ouvrir la discussion d’équipe.')); return box; }
    const list = h('ol', { class: 'team-list' }), status = h('p', { class: 'chat-send-status', role: 'status' });
    const input = h('textarea', { name: 'body', rows: 3, maxlength: 20000, placeholder: 'Écrire à l’équipe…', 'aria-label': 'Votre message à l’équipe' });
    const picks = speakers.map((id) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: id }), nameOf(id)));
    const button = h('button', { type: 'submit', class: 'primary' }, 'Envoyer');
    let busy = false;
    const chosen = () => picks.map((l) => l.firstChild).filter((c) => c.checked).map((c) => c.value);
    const sync = () => { const n = chosen().length, t = input.value.trim(); button.disabled = busy || (!t && !n); button.textContent = busy ? 'Réponses en cours…' : t ? (n ? 'Envoyer et faire répondre' : 'Envoyer') : 'Faire répondre'; };
    const bubble = (msg) => {
      const li = h('li', { class: msg.agentId ? 'team-msg' : 'team-msg own' }, h('p', { class: 'memory-meta' }, h('strong', {}, msg.agentId ? nameOf(msg.agentId) : 'Vous'), ` · ${date(msg.createdAt)}`), h('p', { class: 'pre' }, msg.body));
      const keep = h('button', { type: 'button', class: 'team-keep', onclick: () => {
        keep.replaceWith(memory.noteForm({ kind: 'fact', sourceAgentId: msg.agentId, body: msg.body }, 'Ajouter à la mémoire', async (data) => {
          await send('POST', `/api/missions/${encodeURIComponent(m.id)}/memory`, data); announce('Message retenu dans la mémoire'); await memory.load(); await load();
        }, load));
        li.querySelector('textarea').focus();
      } }, 'Retenir');
      li.append(keep);
      return li;
    };
    const load = () => get(base).then((items) => list.replaceChildren(...(items.length ? items.map(bubble) : [h('li', { class: 'note' }, 'Aucun message pour le moment.')]))).catch((x) => { status.textContent = x.message; });
    const form = h('form', { class: 'team-composer', oninput: sync, onchange: sync, onsubmit: async (e) => {
      e.preventDefault(); if (busy) return;
      const text = input.value.trim(), who = chosen();
      busy = true; status.textContent = ''; status.classList.remove('err'); sync();
      try {
        if (text) { await send('POST', base, { body: text }); input.value = ''; await load(); }
        for (const id of speakers.filter((x) => who.includes(x))) {
          const name = nameOf(id), live = h('p', { class: 'pre' });
          list.append(h('li', { class: 'team-msg pending' }, h('p', { class: 'memory-meta' }, h('strong', {}, name), ' · rédige sa réponse…'), live));
          status.textContent = `${name} rédige sa réponse…`;
          let done = false;
          await readReply(`${base}/reply/${encodeURIComponent(id)}`, (ev) => {
            if (ev.type === 'text') live.textContent += ev.text; else if (ev.type === 'done') done = true; else if (ev.type === 'error') throw new Error(ev.error);
          }).catch((x) => { throw new Error(`${name} n’a pas pu répondre. ${x.message}`); });
          if (!done) throw new Error(`La réponse de ${name} s’est interrompue avant la fin.`);
          announce(`Réponse de ${name} reçue.`); await load();
        }
        picks.forEach((l) => { l.firstChild.checked = false; });
        status.textContent = who.length ? 'Réponses enregistrées dans le fil.' : 'Message enregistré dans le fil.';
      } catch (x) { status.textContent = x.message; status.classList.add('err'); await load(); }
      finally { busy = false; sync(); }
    } },
      input,
      h('fieldset', { class: 'team-picks' }, h('legend', {}, 'Faire répondre'), speakers.length ? picks : h('p', { class: 'note' }, 'Aucun membre avec fiche ne peut répondre.')),
      silent.length > 0 && h('p', { class: 'note' }, `Sans fiche, ne répond pas : ${silent.map(nameOf).join(', ')}.`),
      h('div', { class: 'memory-actions' }, button), status);
    box.append(h('p', { class: 'note' }, 'Vous, le responsable et les collaborateurs. Écrivez, puis cochez qui répond : chaque réponse est un appel à Claude Code. Les agents lisent la mission, sa mémoire et tout le fil.'), list, form);
    sync(); load();
    return box;
  }

  function edit(m = null) {
    const v = m ?? { ...BLANK, assignedTo: agent.id };
    const area = (name, label, value, hint) => field(label, h('textarea', { name, rows: 3, maxlength: 4000 }, value), hint);
    const boxes = agents.map((a) => h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'collaborators', value: a.id, checked: v.collaborators.includes(a.id) }), a.name));
    const sync = () => boxes.forEach((b) => { const c = b.firstChild; c.disabled = c.value === responsible.value; if (c.disabled) c.checked = false; }); // le responsable n'est pas collaborateur
    const responsible = h('select', { name: 'assignedTo', onchange: sync }, h('option', { value: '' }, 'Aucun responsable'), agents.map((a) => h('option', { value: a.id, selected: a.id === v.assignedTo }, a.name)));
    const err = h('p', { class: 'err', role: 'alert' }), submit = h('button', { type: 'submit', class: 'primary' }, m ? 'Enregistrer les modifications' : 'Enregistrer la mission');
    const f = h('form', { class: 'mission-form', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      const fd = new FormData(f), t = (k) => fd.get(k);
      const data = { title: t('title'), objective: t('objective'), assignedTo: t('assignedTo') || null, collaborators: fd.getAll('collaborators'), priority: t('priority'), expectedResult: t('expectedResult'), contextText: t('contextText'), contextLinks: t('contextLinks').split('\n').map((s) => s.trim()).filter(Boolean), constraints: t('constraints'), validations: t('validations'), requiresApproval: fd.has('requiresApproval') };
      try { const saved = await save(m ? 'PUT' : 'POST', m ? `/api/missions/${encodeURIComponent(m.id)}` : '/api/missions', data); announce(m ? 'Mission modifiée' : 'Mission enregistrée'); sheet(saved.id); }
      catch (x) { err.textContent = x.message; submit.disabled = false; }
    } },
      h('p', { class: 'note' }, 'Enregistrement dans la base locale uniquement : aucun agent n’est sollicité et aucune IA n’est appelée.'),
      field('Titre', h('input', { name: 'title', required: true, maxlength: 120, value: v.title })),
      area('objective', 'Objectif', v.objective),
      field('Agent responsable', responsible),
      h('fieldset', {}, h('legend', {}, 'Collaborateurs (facultatif)'), h('div', { class: 'mission-collab' }, boxes)),
      field('Priorité', h('select', { name: 'priority' }, Object.entries(PRIORITY_LABELS).map(([k, label]) => h('option', { value: k, selected: k === v.priority }, label)))),
      area('expectedResult', 'Résultat attendu', v.expectedResult),
      h('fieldset', {}, h('legend', {}, 'Contexte fourni'),
        area('contextText', 'Texte', v.contextText),
        field('Liens', h('textarea', { name: 'contextLinks', rows: 2, spellcheck: 'false', placeholder: 'https://…' }, v.contextLinks.join('\n')), 'Une adresse par ligne (http:// ou https://). Un lien est enregistré comme référence : son contenu n’est pas consulté.')),
      h('fieldset', {}, h('legend', {}, 'Contraintes et validations'),
        area('constraints', 'Contraintes', v.constraints),
        area('validations', 'Validations nécessaires', v.validations),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'requiresApproval', checked: v.requiresApproval }), 'Validation humaine requise avant toute action')),
      h('div', { class: 'row' }, submit, h('button', { type: 'button', onclick: () => (m ? sheet(m.id) : list()) }, 'Annuler'), err)); // erreur collée aux boutons : jamais masquée
    sync();
    show(heading(m ? 'Modifier la mission' : 'Nouvelle mission'), f);
  }

  list();
  return root;
}
