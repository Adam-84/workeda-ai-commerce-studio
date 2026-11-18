// Interface Mémoire : onglet « Memory » de la fiche agent et Memory Center. Réutilise les briques de app.js (h, get, send, tabset, field).
import {
  LEVELS, KINDS, NATURES, STATES, CONFIDENCES, VISIBILITIES, NATURE_HINT, CONFIRM_TEXT,
  levelLabel, kindLabel, natureLabel, stateLabel, confidenceLabel, visibilityLabel, freshnessLabel, scopeLabel, importanceLabel,
  filterMemory, tagsOf, departmentsOf, stateActions, sourceLine, sourcesText, buildPayload, actionLabel, actorLabel, statsLine, contextSummary
} from './memory-view.js';

const enc = encodeURIComponent;
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
const DUPLICATE = /presque identique/i;
const DONE = { active: 'Souvenir activé', rejected: 'Proposition rejetée', archived: 'Souvenir archivé', pending: 'Proposition rouverte', deleted: 'Souvenir supprimé' };
const dateFr = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');
const options = (table, current, empty) => [empty != null && { value: '', label: empty }, ...table.map(([value, label]) => ({ value, label }))].filter(Boolean);

export function natureChip(h, item) { return h('span', { class: `chip mem-nature mem-${item.nature}`, title: NATURE_HINT[item.nature] }, natureLabel(item.nature)); }
export function stateChip(h, item) { return h('span', { class: `chip mem-state mem-${item.state}` }, stateLabel(item.state)); }

// Ligne de liste partagée (Memory Center, onglet agent, validation).
function memoryRow(h, item, { open, nameOf, extra = null }) {
  return h('li', { class: 'skill-row memory-row' },
    h('div', {},
      h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => open(item.id) }, item.title), natureChip(h, item), stateChip(h, item), h('span', { class: 'chip soft' }, kindLabel(item.kind))),
      h('p', { class: 'note' }, `${scopeLabel(item, { nameOf })} · ${importanceLabel(item.importance)} · confiance ${confidenceLabel(item.confidence).toLowerCase()} · ${freshnessLabel(item)}`),
      h('p', { class: 'memory-excerpt' }, item.body.length > 220 ? `${item.body.slice(0, 220)}…` : item.body),
      item.tags.length > 0 && h('div', { class: 'skill-chips' }, item.tags.map((t) => h('span', { class: 'chip soft' }, `#${t}`)))),
    extra);
}

// ---------- onglet « Memory » d'un agent ----------
export function agentMemoryTab({ ui, agent, ref, openItem }) {
  const { h, get, announce } = ui;
  const root = h('div', { class: 'skills-tab memory-tab' }, h('p', { class: 'note', role: 'status' }, 'Chargement de la mémoire…'));
  async function load() {
    try {
      const [mine, ctx, pending] = await Promise.all([
        get(`/api/memory?owner=${enc(ref)}&state=active`), get(`/api/memory/context?agentId=${enc(agent.id)}`).catch(() => null), get(`/api/memory?owner=${enc(ref)}&state=pending`)
      ]);
      put(root,
        h('p', { class: 'note' }, 'Ce que cet agent sait et peut lire. Il ne l’écrit jamais lui-même : il propose, vous validez dans le Memory Center.'),
        pending.length > 0 && h('p', { class: 'note', role: 'status' }, `${pending.length} proposition${pending.length > 1 ? 's' : ''} de ${agent.name} attend${pending.length > 1 ? 'ent' : ''} votre validation (Memory Center › À valider).`),
        h('h3', {}, `Souvenirs individuels (${mine.length})`),
        mine.length ? h('ul', { class: 'skill-list' }, mine.map((i) => memoryRow(h, i, { open: openItem, nameOf: () => agent.name }))) : h('p', {}, 'Aucun souvenir individuel actif.'),
        h('h3', {}, 'Ce que ' + agent.name + ' reçoit au début d’une mission'),
        ctx ? [h('p', { class: 'note' }, contextSummary(ctx)),
          ctx.items.length ? h('ul', {}, ctx.items.map((i) => h('li', {}, h('button', { type: 'button', class: 'link', onclick: () => openItem(i.id) }, i.title), ` · ${levelLabel(i.level)} · ${natureLabel(i.nature)}${i.stale ? ' · à revoir' : ''}`))) : h('p', {}, 'Rien pour l’instant.'),
          ctx.text && h('details', {}, h('summary', {}, 'Voir le texte exact transmis'), h('pre', { class: 'skill-content', tabindex: '0', 'aria-label': `Contexte transmis à ${agent.name}` }, ctx.text))]
          : h('p', { class: 'note' }, 'Aperçu indisponible.'),
        h('p', { class: 'note' }, 'L’aperçu ne dépend pas d’une mission précise : une mémoire de mission n’apparaît que pendant cette mission. Il n’enregistre aucune utilisation.'));
      announce?.('Mémoire chargée');
    } catch (x) { put(root, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  load();
  return root;
}

// ---------- Memory Center ----------
export function memoryCenter({ ui, agents = [], departments = [], missions = [], refOf, openAgent, initial = null }) {
  const { h, get, send, announce, tabset, field } = ui;
  const library = h('div');
  const nameByRef = new Map(agents.map((a) => [refOf(a), a.name]));
  const nameOf = (ref) => nameByRef.get(ref) ?? ref ?? '?';
  const filters = { query: '', level: '', kind: '', nature: '', state: '', owner: '', department: '', tag: '' };
  let tabs = null;

  const select = (name, opts, value, onchange, label) => h('select', { name, 'aria-label': label, onchange }, opts.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  const refocusSearch = () => { const i = library.querySelector('input[type=search]'); if (i) { i.focus(); i.setSelectionRange(filters.query.length, filters.query.length); } };

  // --- liste ---
  async function renderLibrary() {
    put(library, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    try { drawLibrary(await get('/api/memory?limit=500')); }
    catch (x) { put(library, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  function drawLibrary(items) {
    const shown = filterMemory(items, filters);
    const set = (key) => (e) => { filters[key] = e.target.value; drawLibrary(items); };
    const owners = [...new Set(items.map((i) => i.owner).filter(Boolean))].sort((a, b) => nameOf(a).localeCompare(nameOf(b), 'fr'));
    const search = h('input', { type: 'search', value: filters.query, placeholder: 'Titre, contenu, étiquette…', oninput: (e) => { filters.query = e.target.value; drawLibrary(items); refocusSearch(); } });
    put(library,
      h('div', { class: 'skill-filters memory-filters' },
        field('Rechercher', search),
        field('Niveau', select('level', options(LEVELS, filters.level, 'Tous'), filters.level, set('level'))),
        field('Type', select('kind', options(KINDS, filters.kind, 'Tous'), filters.kind, set('kind'))),
        field('Nature', select('nature', options(NATURES, filters.nature, 'Toutes'), filters.nature, set('nature'))),
        field('État', select('state', options(STATES, filters.state, 'Tous sauf supprimés'), filters.state, set('state'))),
        field('Agent', select('owner', [{ value: '', label: 'Tous' }, ...owners.map((o) => ({ value: o, label: nameOf(o) }))], filters.owner, set('owner'))),
        field('Département', select('department', [{ value: '', label: 'Tous' }, ...departmentsOf(items).map((d) => ({ value: d, label: d }))], filters.department, set('department'))),
        field('Étiquette', select('tag', [{ value: '', label: 'Toutes' }, ...tagsOf(items).map((t) => ({ value: t, label: `#${t}` }))], filters.tag, set('tag')))),
      h('p', { class: 'note', role: 'status' }, `${shown.length} souvenir${shown.length > 1 ? 's' : ''} affiché${shown.length > 1 ? 's' : ''} sur ${items.length}.`),
      shown.length ? h('ul', { class: 'skill-list' }, shown.map((i) => memoryRow(h, i, { open: (id) => openDetail(id), nameOf })))
        : h('p', {}, items.length ? 'Aucun souvenir ne correspond à ces filtres.' : 'La mémoire est vide. Ajoutez un premier souvenir dans l’onglet « Ajouter » : les agents proposeront les leurs en fin de mission.'));
  }

  // --- détail ---
  async function openDetail(id, { focus = true, message = '' } = {}) {
    put(library, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    try {
      const [item, history] = await Promise.all([get(`/api/memory/${enc(id)}`), get(`/api/memory/${enc(id)}/history`)]);
      drawDetail(item, history, message);
      if (focus) library.querySelector('h2')?.focus();
    } catch (x) { put(library, h('p', { class: 'err', role: 'alert' }, x.message), h('button', { type: 'button', onclick: renderLibrary }, '← Mémoire')); }
  }
  function drawDetail(item, history, message) {
    const status = h('p', { class: 'note', role: 'status' }, message), err = h('p', { class: 'err', role: 'alert' });
    const actions = stateActions(item.state);
    const slot = h('div', { class: 'row' });
    const apply = async (to, label, patch) => {
      err.textContent = '';
      try { await send('POST', `/api/memory/${enc(item.id)}/state`, { to, patch: patch ?? null }); announce(label); if (to === 'deleted') { await renderLibrary(); library.querySelector('p[role=status]') && (library.querySelector('p[role=status]').textContent = 'Souvenir supprimé.'); } else await openDetail(item.id, { focus: false, message: `${label}.` }); }
      catch (x) { err.textContent = x.message; }
    };
    const confirmState = (a) => {
      const ok = h('button', { type: 'button', class: a.danger ? 'danger' : 'primary', onclick: () => apply(a.to, DONE[a.to]) }, `Confirmer : ${a.label.toLowerCase()}`);
      put(slot, h('div', { class: 'confirm' }, h('p', {}, `${a.label} « ${item.title} » ? ${CONFIRM_TEXT[a.to]}`), h('div', {}, ok, ' ', h('button', { type: 'button', onclick: () => drawActions() }, 'Annuler'))));
      ok.focus();
    };
    const drawActions = () => put(slot,
      h('button', { type: 'button', class: 'primary', onclick: () => drawEdit(item) }, 'Modifier'),
      actions.filter((a) => !(item.state === 'pending' && a.to === 'active')).map((a) => h('button', { type: 'button', class: a.danger ? 'danger' : '', onclick: () => confirmState(a) }, a.label)),
      item.state === 'pending' && h('button', { type: 'button', class: 'primary', onclick: () => apply('active', 'Souvenir validé') }, 'Valider'));
    drawActions();
    const meta = [
      ['Niveau', scopeLabel(item, { nameOf })], ['Type', kindLabel(item.kind)], ['Visibilité', visibilityLabel(item.visibility)], ['Confiance', confidenceLabel(item.confidence)],
      ['Importance', `${item.importance}/5`], ['Fraîcheur', freshnessLabel(item)], ['Créé', dateFr(item.createdAt)], ['Modifié', dateFr(item.updatedAt)],
      item.expiresAt && ['Expire', dateFr(item.expiresAt)], item.proposedBy && ['Proposé par', nameOf(item.proposedBy)], ['Utilisé', item.useCount ? `${item.useCount} fois (dernière : ${dateFr(item.lastUsedAt)})` : 'Jamais transmis à un agent'],
      item.owner && ['Propriétaire', nameOf(item.owner)], item.readers.length > 0 && ['Lecteurs autorisés', item.readers.map(nameOf).join(', ')]
    ].filter(Boolean);
    put(library,
      h('button', { type: 'button', onclick: renderLibrary }, '← Mémoire'),
      h('h2', { tabindex: '-1' }, item.title),
      h('div', { class: 'skill-chips' }, natureChip(h, item), stateChip(h, item), item.tags.map((t) => h('span', { class: 'chip soft' }, `#${t}`))),
      h('p', { class: 'note' }, NATURE_HINT[item.nature]),
      item.state === 'pending' && h('p', { class: 'note' }, 'Proposition en attente : aucun agent ne la reçoit tant que vous ne l’avez pas validée.'),
      h('p', { class: 'memory-body' }, item.body),
      h('h3', {}, 'Sources'),
      item.sources.length ? h('ul', {}, item.sources.map((s) => (s.url ? h('li', {}, s.label, ' · ', h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url), s.note ? ` · ${s.note}` : '') : h('li', {}, sourceLine(s)))))
        : h('p', { class: 'note' }, item.nature === 'fact' ? 'Aucune source.' : 'Aucune source déclarée : traitez ce contenu avec prudence.'),
      item.source && h('p', { class: 'note' }, `Provenance : ${item.source}`),
      h('p', { class: 'note' }, 'Archipel ne lit pas les sources : c’est à vous de les vérifier. Une source est une référence que vous déclarez.'),
      h('dl', { class: 'memory-meta' }, meta.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
      status, err, slot,
      h('h3', {}, 'Historique'),
      h('ol', { class: 'memory-history', reversed: true }, history.map((e) => h('li', {}, `${dateFr(e.at)} · ${actionLabel(e.action)}${e.actor ? ` par ${actorLabel(e.actor)}` : ''}${e.note ? ` — ${e.note}` : ''} (v${e.rev})`))),
      h('p', { class: 'note' }, 'À la suppression, le contenu est effacé de l’historique ; seule reste une trace vide pour la synchronisation.'));
  }

  // --- édition ---
  function drawEdit(item) {
    const err = h('p', { class: 'err', role: 'alert' });
    const f = formFor(item, async (payload) => {
      err.textContent = '';
      try { await send('PUT', `/api/memory/${enc(item.id)}`, payload); announce('Souvenir modifié'); await openDetail(item.id, { focus: false, message: 'Modifications enregistrées.' }); }
      catch (x) { err.textContent = x.message; }
    }, { submit: 'Enregistrer', err, editing: true });
    put(library, h('button', { type: 'button', onclick: () => openDetail(item.id) }, '← Annuler'), h('h2', { tabindex: '-1' }, `Modifier « ${item.title} »`),
      h('p', { class: 'note' }, 'L’ancienne version reste consultable dans l’historique. Un secret ou un mot de passe est refusé.'), f);
    f.querySelector('input[name=title]')?.focus();
  }

  // --- formulaire (ajout et édition) ---
  function formFor(item, onSubmit, { submit, err, editing = false }) {
    const v = item ?? { level: 'company', kind: 'knowledge', nature: 'hypothesis', confidence: 'medium', importance: 3, tags: [], sources: [], visibility: '', title: '', body: '' };
    const level = h('select', { name: 'level', onchange: () => sync(), disabled: editing }, LEVELS.map(([val, l]) => h('option', { value: val, selected: val === v.level }, l)));
    const owner = h('select', { name: 'owner' }, agents.map((a) => h('option', { value: refOf(a), selected: refOf(a) === v.owner }, a.name)));
    const dept = h('select', { name: 'department' }, departments.map((d) => h('option', { value: d, selected: d === v.department }, d)));
    const mission = h('select', { name: 'missionId' }, missions.map((m) => h('option', { value: m.id, selected: m.id === v.missionId }, m.title)));
    const scope = { individual: field('Agent propriétaire', owner), department: field('Département', dept), mission: field('Mission', mission), company: null };
    const scopeBox = h('div');
    function sync() { const el = scope[level.value]; put(scopeBox, el); }
    sync();
    const nature = h('select', { name: 'nature' }, NATURES.map(([val, l]) => h('option', { value: val, selected: val === v.nature }, l)));
    const hint = h('p', { class: 'note', id: 'nature-hint' }, NATURE_HINT[v.nature]);
    nature.addEventListener('change', () => { hint.textContent = NATURE_HINT[nature.value]; });
    const f = h('form', { class: 'memory-form', onsubmit: (e) => {
      e.preventDefault();
      const d = Object.fromEntries(new FormData(f));
      d.level = level.value; d.owner = owner.value; d.department = dept.value; d.missionId = mission.value;
      onSubmit(buildPayload(d));
    } },
      field('Niveau', level), scopeBox,
      field('Type', h('select', { name: 'kind' }, KINDS.map(([val, l]) => h('option', { value: val, selected: val === v.kind }, l)))),
      field('Nature', nature), hint,
      field('Titre', h('input', { name: 'title', required: true, maxlength: 120, value: v.title })),
      field('Contenu', h('textarea', { name: 'body', rows: '6', required: true, class: 'skill-editor', maxlength: 4000 }, v.body)),
      field('Étiquettes (séparées par des virgules)', h('input', { name: 'tags', value: v.tags.join(', '), placeholder: 'prix, livraison' })),
      field('Sources (une par ligne : Libellé | https://adresse | note)', h('textarea', { name: 'sources', rows: '3', spellcheck: 'false' }, sourcesText(v.sources))),
      h('div', { class: 'memory-pair' },
        field('Confiance', h('select', { name: 'confidence' }, CONFIDENCES.map(([val, l]) => h('option', { value: val, selected: val === v.confidence }, l)))),
        field('Importance (1 à 5)', h('input', { name: 'importance', type: 'number', min: '1', max: '5', value: v.importance, required: true }))),
      field('Visibilité', h('select', { name: 'visibility' }, [h('option', { value: '' }, 'Par défaut selon le niveau'), ...VISIBILITIES.map(([val, l]) => h('option', { value: val, selected: val === v.visibility }, l))])),
      field('Expire le (facultatif)', h('input', { name: 'expiresAt', type: 'date', value: v.expiresAt ? v.expiresAt.slice(0, 10) : '' })),
      h('p', { class: 'note' }, 'Ne mettez jamais de mot de passe, clé d’API, jeton ou numéro de carte : ils sont refusés. Un fait vérifié exige au moins une source.'),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, submit)), err);
    return f;
  }

  // --- ajouter ---
  function createPanel() {
    const box = h('div'), err = h('p', { class: 'err', role: 'alert' }), status = h('p', { class: 'note', role: 'status' });
    const create = async (payload, force = false) => {
      err.textContent = ''; status.textContent = '';
      try {
        const r = await send('POST', '/api/memory', force ? { ...payload, force: true } : payload);
        announce('Souvenir ajouté'); status.textContent = `« ${r.title} » ajouté et actif.`; draw();
      } catch (x) {
        if (DUPLICATE.test(x.message)) {
          const again = h('button', { type: 'button', onclick: () => create(payload, true) }, 'Créer quand même');
          put(err, x.message, ' ', again); err.setAttribute('role', 'alert');
        } else err.textContent = x.message;
      }
    };
    function draw() { put(box, formFor(null, (p) => create(p), { submit: 'Ajouter au Memory Center', err }), status); }
    draw();
    return box;
  }

  // --- à valider ---
  function reviewPanel() {
    const box = h('div', {}, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    async function load(message = '') {
      try {
        const items = await get('/api/memory?state=pending&limit=200');
        const status = h('p', { class: 'note', role: 'status' }, message);
        put(box, h('p', { class: 'note' }, 'Les agents proposent, vous décidez. Une proposition validée devient active ; rejetée, elle n’est jamais transmise.'), status,
          items.length ? h('ul', { class: 'skill-list' }, items.map((i) => reviewCard(i, load))) : h('p', {}, 'Aucune proposition en attente.'));
        announce?.(`${items.length} proposition${items.length > 1 ? 's' : ''} à valider`);
      } catch (x) { put(box, h('p', { class: 'err', role: 'alert' }, x.message)); }
    }
    function reviewCard(i, reload) {
      const err = h('p', { class: 'err', role: 'alert' });
      const nat = h('select', { 'aria-label': `Nature pour « ${i.title} »` }, NATURES.map(([val, l]) => h('option', { value: val, selected: val === i.nature }, l)));
      const act = async (to, label) => {
        err.textContent = '';
        try { await send('POST', `/api/memory/${enc(i.id)}/state`, { to, patch: to === 'active' && nat.value !== i.nature ? { nature: nat.value } : null }); announce(label); await reload(`« ${i.title} » ${label}.`); }
        catch (x) { err.textContent = x.message; }
      };
      return h('li', { class: 'skill-row memory-row' }, h('div', {},
        h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => { tabs.select?.(0); openDetail(i.id); } }, i.title), natureChip(h, i), h('span', { class: 'chip soft' }, kindLabel(i.kind))),
        h('p', { class: 'note' }, `${scopeLabel(i, { nameOf })}${i.proposedBy ? ` · proposé par ${nameOf(i.proposedBy)}` : ''} · ${dateFr(i.createdAt)}`),
        h('p', { class: 'memory-body' }, i.body),
        i.sources.length > 0 && h('ul', {}, i.sources.map((s) => h('li', {}, sourceLine(s)))),
        h('div', { class: 'row' }, h('label', {}, 'Nature à la validation ', nat),
          h('button', { type: 'button', class: 'primary', onclick: () => act('active', 'validé') }, 'Valider'),
          h('button', { type: 'button', onclick: () => act('rejected', 'rejeté') }, 'Rejeter')),
        i.nature !== 'decision' && h('p', { class: 'note' }, 'Seul vous pouvez la déclarer « fait vérifié » ou « décision approuvée » (un fait exige une source : modifiez-la avant).'),
        err));
    }
    load();
    return box;
  }

  // --- état ---
  function healthPanel() {
    const box = h('div', {}, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    async function load(msg = '') {
      try {
        const [st, check, status] = await Promise.all([get('/api/memory/stats'), get('/api/memory/check'), get('/api/memory/status')]);
        const err = h('p', { class: 'err', role: 'alert' }), out = h('p', { class: 'note', role: 'status' }, msg);
        const sync = h('button', { type: 'button', class: 'primary', onclick: async () => {
          sync.disabled = true; err.textContent = '';
          try { const r = await send('POST', '/api/memory/import'); announce('Journal importé'); await load(`Journal : ${r.applied} appliqué(s), ${r.superseded} plus ancien(s) conservé(s), ${r.invalid} invalide(s).${r.warnings.length ? ` ${r.warnings.join(' ')}` : ''}`); }
          catch (x) { err.textContent = x.message; sync.disabled = false; }
        } }, 'Importer le journal des autres ordinateurs');
        const row = (obj, table) => Object.entries(obj).map(([k, n]) => `${table(k)} : ${n}`).join(' · ') || '—';
        put(box,
          h('h3', {}, 'Contenu'), h('p', {}, statsLine(st)),
          h('p', { class: 'note' }, `Par niveau — ${row(st.byLevel, levelLabel)}`), h('p', { class: 'note' }, `Par nature — ${row(st.byNature, natureLabel)}`), h('p', { class: 'note' }, `Par état — ${row(st.byState, stateLabel)}`),
          h('h3', {}, 'Cohérence'), check.problems.length ? h('ul', {}, check.problems.map((p) => h('li', { class: 'err' }, p))) : h('p', {}, 'Aucun problème détecté.'),
          check.notes.length > 0 && h('ul', {}, check.notes.map((n) => h('li', { class: 'note' }, n))),
          h('h3', {}, 'Synchronisation entre ordinateurs'),
          h('p', {}, `Cet ordinateur : ${status.device} · ${check.journalFiles} journal(aux) · schéma v${status.schemaVersion}.`),
          status.journalError && h('p', { class: 'err', role: 'alert' }, `Journal inaccessible : ${status.journalError}`),
          h('p', { class: 'note' }, 'La mémoire voyage par git (dossier memory/journal/). Après un « git pull », importez le journal ; le plus récent gagne et l’ancienne version reste dans l’historique.'),
          h('div', { class: 'row' }, sync), out, err,
          h('p', { class: 'note' }, 'Sauvegardes : npm run memory:backup (dossier data/backups/, jamais envoyé sur git).'));
      } catch (x) { put(box, h('p', { class: 'err', role: 'alert' }, x.message)); }
    }
    load();
    return box;
  }

  tabs = tabset([
    { label: 'Souvenirs', render: () => { renderLibrary(); return library; } },
    { label: 'À valider', render: reviewPanel },
    { label: 'Ajouter', render: createPanel },
    { label: 'État', render: healthPanel }
  ], 0, undefined, 'Sections du Memory Center');
  if (initial) queueMicrotask(() => openDetail(initial, { focus: false }));
  return h('div', { class: 'agent-detail skills-center memory-center' }, h('header', { class: 'agent-heading' }, h('div', {}, h('h2', {}, 'Memory'), h('p', {}, 'Mémoire des agents d’Archipel'), h('p', { class: 'agent-department' }, 'Individuelle · Département · Entreprise · Mission'))), tabs.el);
}
