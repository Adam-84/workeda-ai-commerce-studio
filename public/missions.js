// public/missions.js — onglet Missions d'un agent : liste, fiche, création et modification.
// Enregistrer une mission ne sollicite aucun agent et n'appelle aucune IA.
export const PRIORITY_LABELS = { low: 'Basse', normal: 'Normale', high: 'Haute', urgent: 'Urgente' };
const STATE_LABELS = { draft: 'Brouillon' };
const date = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const BLANK = { title: '', objective: '', collaborators: [], priority: 'normal', expectedResult: '', contextText: '', contextLinks: [], constraints: '', validations: '', requiresApproval: true };

// missions : () => liste à jour ; save(method, path, data) enregistre puis recharge l'état, et renvoie la mission.
export function missionsTab({ agent, agents, missions, save, announce, h }) {
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
      h('p', { class: 'note mission-dates' }, `Créée le ${date(m.created_at)}${m.updatedAt ? ` · modifiée le ${date(m.updatedAt)}` : ''}`),
      h('div', { class: 'row' }, h('button', { type: 'button', class: 'primary', onclick: () => edit(m) }, 'Modifier'), h('button', { type: 'button', onclick: list }, 'Retour à la liste')));
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
