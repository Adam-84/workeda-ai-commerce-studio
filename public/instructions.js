// public/instructions.js — « Mes consignes » d'un agent : enregistrées dans ce Studio, elles complètent la fiche sans la modifier.
const FIELDS = [
  ['objective', 'Objectif principal', 'Ex. : Concentre-toi principalement sur la qualité du catalogue.'],
  ['priorities', 'Priorités', 'Ex. : Commence par les produits que je désigne comme prioritaires.'],
  ['preferences', 'Mes préférences de travail', 'Ex. : Présente tes propositions avant toute modification.'],
  ['limits', 'Limites particulières à respecter', 'Ex. : Ne propose aucune baisse de prix sans mon accord.']
];
const date = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

export function instructionsBlock({ agent, replies, get, send, announce, h }) {
  const url = `/api/agents/${encodeURIComponent(agent.id)}/instructions`;
  const box = h('section', { class: 'instructions', 'aria-label': 'Mes consignes' }, h('h3', {}, 'Mes consignes'), h('p', { class: 'note' }, 'Chargement…'));
  const intro = () => h('p', { class: 'note' }, replies
    ? `Enregistrées dans ce Studio et transmises à ${agent.name} dans Discussion et dans les discussions d’équipe. Elles complètent sa fiche métier sans la modifier et ne donnent aucun accès supplémentaire : pas d’outil, pas de web, pas de Shopify.`
    : 'Enregistrées dans ce Studio. Sans fiche dans .claude/agents, cet agent ne répond pas : elles serviront s’il est relié à une fiche.');
  const view = (c) => {
    const filled = FIELDS.some(([k]) => c[k]);
    box.replaceChildren(h('h3', {}, 'Mes consignes'), intro(),
      filled ? h('dl', { class: 'consignes' }, FIELDS.flatMap(([k, label]) => [h('dt', {}, label), h('dd', { class: c[k] ? 'pre' : 'note' }, c[k] || 'Non renseigné')])) : h('p', { class: 'note' }, 'Aucune consigne pour le moment.'),
      c.updatedAt ? h('p', { class: 'note' }, `Modifiées le ${date(c.updatedAt)}`) : '',
      h('button', { type: 'button', class: filled ? false : 'primary', onclick: () => edit(c) }, filled ? 'Modifier mes consignes' : 'Ajouter des consignes'));
  };
  const edit = (c) => {
    const err = h('p', { class: 'err', role: 'alert' }), save = h('button', { type: 'submit', class: 'primary' }, 'Enregistrer');
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; save.disabled = true;
      const fd = new FormData(f);
      try { view(await send('PUT', url, Object.fromEntries(FIELDS.map(([k]) => [k, fd.get(k)])))); announce('Consignes enregistrées'); box.querySelector('button')?.focus(); }
      catch (x) { err.textContent = x.message; save.disabled = false; }
    } },
      FIELDS.map(([k, label, hint]) => h('label', {}, label, h('textarea', { name: k, rows: 3, maxlength: 2000, placeholder: hint }, c[k]))),
      h('div', { class: 'memory-actions' }, save, h('button', { type: 'button', onclick: () => view(c) }, 'Annuler'), err));
    box.replaceChildren(h('h3', {}, 'Mes consignes'), intro(), f);
    f.querySelector('textarea').focus();
  };
  get(url).then(view).catch((x) => box.replaceChildren(h('h3', {}, 'Mes consignes'), h('p', { class: 'err' }, x.message)));
  return box;
}
