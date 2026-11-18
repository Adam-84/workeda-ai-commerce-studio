// Interface Skills : onglet de la fiche agent et centre Skills. Réutilise les briques de app.js (h, get, send, tabset…).
import { statusLabel, originLabel, tokenLabel, budgetLabel, filterSkills, groupByCategory, assignCheck, unassignCheck, copiesText, findingText, compatText, nextPatch } from './skills-view.js';

const enc = encodeURIComponent;
// Remplace le contenu d'un élément : aplatit les tableaux et ignore false/null (replaceChildren les écrirait en texte).
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));
const list = (text) => String(text ?? '').split(/[,\n]/).map((t) => t.trim()).filter(Boolean);

// ---------- onglet « Skills » d'un agent ----------
export function agentSkillsTab({ ui, agent, openSkill, onChange = () => {} }) {
  const { h, get, send, announce } = ui;
  const root = h('div', { class: 'skills-tab' }, h('p', { class: 'note', role: 'status' }, 'Chargement des Skills…'));
  const status = h('p', { class: 'note', role: 'status' });
  const err = h('p', { class: 'err', role: 'alert' });
  let data = null, query = '';

  async function load() {
    try {
      const [mine, rec] = await Promise.all([get(`/api/agents/${enc(agent.id)}/skills`), get(`/api/skills/recommend?agentId=${enc(agent.id)}`).catch(() => [])]);
      data = { ...mine, rec }; draw();
    } catch (x) { put(root, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  async function change(method, path, body, done) {
    err.textContent = '';
    try {
      const r = await send(method, path, body);
      status.textContent = [done, r.notice, copiesText(r.copies)].filter(Boolean).join(' ');
      announce(done); onChange(); await load();
    } catch (x) { err.textContent = x.message; announce(x.message); }
  }
  const add = (s) => change('POST', `/api/agents/${enc(agent.id)}/skills`, { skill: s.name }, `« ${s.title || s.name} » ajouté à ${agent.name}.`);
  const remove = (s) => change('DELETE', `/api/agents/${enc(agent.id)}/skills/${enc(s.name)}`, undefined, `« ${s.title || s.name} » retiré de ${agent.name}.`);

  function draw() {
    const { max, preloaded, available, rec } = data;
    const byName = new Map([...preloaded, ...available].map((s) => [s.name, s]));
    const candidate = (s, why) => {
      const check = assignCheck(s, preloaded, max), id = `sk-${agent.id}-${s.name}`;
      return h('li', { class: 'skill-row' },
        h('div', {}, h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => openSkill(s.name) }, s.title || s.name),
          h('span', { class: 'chip soft' }, tokenLabel(s.tokens))), why && h('p', { class: 'note' }, why),
          !check.ok && h('p', { class: 'note', id }, check.reason)),
        h('button', { type: 'button', disabled: !check.ok, 'aria-describedby': check.ok ? false : id, 'aria-label': `Ajouter ${s.title || s.name} à ${agent.name}`, onclick: () => add(s) }, 'Ajouter'));
    };
    const needle = query.trim();
    const shown = filterSkills(available, { query: needle, status: 'active' });
    put(root, 
      h('h3', {}, 'Préchargés au démarrage'), h('p', { class: 'note' }, budgetLabel(preloaded.length, max, data.preloadedTokens)),
      preloaded.length ? h('ul', { class: 'skill-list' }, preloaded.map((s) => {
        const un = unassignCheck(s, preloaded), id = `rm-${agent.id}-${s.name}`;
        return h('li', { class: 'skill-row' },
          h('div', {}, h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => openSkill(s.name) }, s.title || s.name), h('span', { class: 'chip soft' }, tokenLabel(s.tokens))),
            h('p', { class: 'note' }, s.description), !un.ok && h('p', { class: 'note', id }, un.reason)),
          h('button', { type: 'button', disabled: !un.ok, 'aria-describedby': un.ok ? false : id, 'aria-label': `Retirer ${s.title || s.name} de ${agent.name}`, onclick: () => remove(s) }, 'Retirer'));
      })) : h('p', {}, 'Aucun Skill préchargé.'),
      status, err,
      rec.filter((r) => byName.has(r.name)).length > 0 && [h('h3', {}, 'Suggérés pour ce métier'), h('ul', { class: 'skill-list' }, rec.filter((r) => byName.has(r.name)).map((r) => candidate(byName.get(r.name), `Mots en commun : ${r.matched.join(', ')} (correspondance de mots-clés, pas un avis de qualité).`)))],
      h('h3', {}, `Disponibles (${shown.length})`),
      h('label', {}, 'Filtrer', h('input', { type: 'search', value: query, placeholder: 'Nom, métier, mot-clé…', oninput: (e) => { query = e.target.value; draw(); const i = root.querySelector('input[type=search]'); i.focus(); i.setSelectionRange(query.length, query.length); } })),
      shown.length ? h('ul', { class: 'skill-list' }, shown.map((s) => candidate(s))) : h('p', {}, 'Aucun Skill ne correspond.'),
      h('p', { class: 'note' }, 'Les changements s’appliquent au prochain démarrage de Claude Code : la liste des agents est lue au lancement. Un Skill ne donne jamais de nouvel outil ni de permission à l’agent.'));
  }
  load();
  return root;
}

// ---------- centre Skills ----------
export function skillsCenter({ ui, openAgent, initial = null }) {
  const { h, get, send, announce, tabset, field } = ui;
  const library = h('div');
  let categories = [], tabs = null;
  const filters = { query: '', category: '', status: 'active' };
  const result = (el, node) => el.replaceChildren(node);

  const chips = (s) => [h('span', { class: 'chip accent' }, `v${s.version}`), h('span', { class: 'chip soft' }, tokenLabel(s.tokens)), h('span', { class: 'chip soft' }, originLabel(s.origin)), s.status !== 'active' && h('span', { class: 'chip soft' }, statusLabel(s.status))];
  const findingsBlock = (findings) => findings?.length ? h('ul', { class: 'skill-findings' }, findings.map((f) => h('li', { class: f.severity === 'bloquant' ? 'err' : '' }, findingText(f)))) : h('p', { class: 'note' }, 'Aucune alerte de sécurité détectée (analyse de motifs, pas une garantie).');

  // --- bibliothèque ---
  async function renderLibrary() {
    put(library, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    try {
      const [skills, cats] = await Promise.all([get('/api/skills'), get('/api/skills/categories')]);
      categories = cats; drawLibrary(skills);
    } catch (x) { put(library, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  function drawLibrary(skills) {
    const shown = filterSkills(skills, filters), groups = groupByCategory(shown, categories);
    const search = h('input', { type: 'search', value: filters.query, placeholder: 'Nom, métier, mot-clé…', oninput: (e) => { filters.query = e.target.value; drawLibrary(skills); const i = library.querySelector('input[type=search]'); i.focus(); i.setSelectionRange(filters.query.length, filters.query.length); } });
    const cat = h('select', { onchange: (e) => { filters.category = e.target.value; drawLibrary(skills); } }, h('option', { value: '' }, 'Toutes les catégories'), categories.map((c) => h('option', { value: c.slug, selected: c.slug === filters.category }, c.name)));
    const st = h('select', { onchange: (e) => { filters.status = e.target.value; drawLibrary(skills); } }, [['active', 'Actifs'], ['archived', 'Archivés'], ['', 'Tous']].map(([v, l]) => h('option', { value: v, selected: v === filters.status }, l)));
    put(library, 
      h('div', { class: 'skill-filters' }, field('Rechercher', search), field('Catégorie', cat), field('Statut', st)),
      h('p', { class: 'note', role: 'status' }, `${shown.length} Skill${shown.length > 1 ? 's' : ''} affiché${shown.length > 1 ? 's' : ''} sur ${skills.length}.`),
      groups.length ? groups.map((g) => h('section', {}, h('h3', {}, g.name),
        h('ul', { class: 'skill-list' }, g.skills.map((s) => h('li', { class: 'skill-row' },
          h('div', {}, h('div', { class: 'skill-chips' }, h('button', { type: 'button', class: 'link', onclick: () => openDetail(s.name) }, s.title || s.name), chips(s)),
            h('p', { class: 'note' }, s.description),
            h('p', { class: 'note' }, s.agents.length ? `Préchargé par : ${s.agents.map((a) => a.name).join(', ')}` : 'Pas encore affecté à un agent')))))))
        : h('p', {}, 'Aucun Skill ne correspond à ces filtres.'));
  }

  // --- détail et édition ---
  async function openDetail(name, { focus = true } = {}) {
    put(library, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    try { drawDetail(await get(`/api/skills/${enc(name)}`)); if (focus) library.querySelector('h2')?.focus(); }
    catch (x) { put(library, h('p', { class: 'err', role: 'alert' }, x.message), h('button', { type: 'button', onclick: renderLibrary }, '← Bibliothèque')); }
  }
  function drawDetail(s) {
    const status = h('p', { class: 'note', role: 'status' }), err = h('p', { class: 'err', role: 'alert' });
    const act = async (fn, done) => { err.textContent = ''; try { const r = await fn(); status.textContent = [done, copiesText(r?.copies)].filter(Boolean).join(' '); announce(done); await openDetail(s.name, { focus: false }); library.querySelector('p[role=status]') && (library.querySelector('p[role=status]').textContent = status.textContent); } catch (x) { err.textContent = x.message; } };
    const archived = s.status === 'archived';
    // Même règle que le serveur (qui reste l'arbitre) : pas d'archivage tant qu'un agent ou un autre Skill s'en sert.
    const blockReason = s.agents.length ? `Préchargé par ${s.agents.map((a) => a.name).join(', ')} : retirez-le d’abord de la fiche de chaque agent concerné.` : s.dependents.length ? `Nécessaire à : ${s.dependents.join(', ')}.` : '';
    const versions = h('ul', {}, s.versions.map((v, i) => h('li', {}, `v${v.version} · ${tokenLabel(v.tokens)} · ${new Date(v.createdAt).toLocaleDateString('fr-FR')}${v.hash === s.hash ? ' (actuelle)' : ''}${v.note ? ` — ${v.note}` : ''}`)));
    put(library, 
      h('button', { type: 'button', onclick: renderLibrary }, '← Bibliothèque'),
      h('h2', { tabindex: '-1' }, s.title || s.name), h('p', { class: 'note' }, s.name), h('div', { class: 'skill-chips' }, chips(s), h('span', { class: 'chip soft' }, s.license)),
      h('p', {}, s.description),
      h('h3', {}, 'Compatibilité'), h('ul', {}, h('li', {}, `Claude Code : ${compatText(s.compat?.claude)}`), h('li', {}, `Codex : ${compatText(s.compat?.codex)}`)),
      h('p', { class: 'note' }, 'Vérification de structure seulement : Archipel ne lance aucun modèle et ne prouve pas qu’un agent utilise le Skill.'),
      h('h3', {}, 'Sécurité'), findingsBlock(s.findings),
      h('h3', {}, 'Dépendances'), h('p', {}, s.dependsOn.length ? `Demande : ${s.dependsOn.join(', ')}` : 'Aucune.'), s.dependents.length > 0 && h('p', {}, `Nécessaire pour : ${s.dependents.join(', ')}`),
      h('h3', {}, 'Agents'), s.agents.length ? h('div', { class: 'colleagues' }, s.agents.map((a) => h('button', { type: 'button', onclick: () => openAgent(a.id) }, a.name))) : h('p', {}, 'Aucun agent ne le précharge.'),
      h('p', { class: 'note' }, `Utilisations déclarées à la main : ${s.usage.length}${s.usage.length === 20 ? '+' : ''}. Archipel n’observe pas les agents.`),
      h('h3', {}, 'Versions'), versions,
      h('details', {}, h('summary', {}, 'Contenu du SKILL.md'), h('pre', { class: 'skill-content', tabindex: '0', 'aria-label': `Contenu de ${s.name}` }, s.content)),
      status, err,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => drawEdit(s) }, 'Modifier'),
        archived ? h('button', { type: 'button', onclick: () => act(() => send('POST', `/api/skills/${enc(s.name)}/unarchive`), 'Skill restauré.') }, 'Restaurer')
          : h('button', { type: 'button', disabled: !!blockReason, 'aria-describedby': blockReason ? 'archive-why' : false, onclick: () => confirmArchive(s, act) }, 'Archiver'),
        blockReason && h('p', { class: 'note', id: 'archive-why' }, blockReason)));
  }
  function confirmArchive(s, act) {
    const slot = library.querySelector('.row'), ok = h('button', { type: 'button', class: 'primary', onclick: () => act(() => send('POST', `/api/skills/${enc(s.name)}/archive`), 'Skill archivé.') }, 'Confirmer l’archivage');
    put(slot, h('div', { class: 'confirm' }, h('p', {}, `Archiver « ${s.title || s.name} » ? Le dossier reste dans skills/ ; il n’est plus proposé ni copié pour les agents. Rien n’est supprimé.`), h('div', {}, ok, ' ', h('button', { type: 'button', onclick: () => openDetail(s.name, { focus: false }) }, 'Annuler'))));
    ok.focus();
  }
  function drawEdit(s) {
    const content = h('textarea', { name: 'content', rows: '16', spellcheck: 'false', class: 'skill-editor', 'aria-label': 'Contenu complet du SKILL.md' }, s.content);
    const version = h('input', { name: 'version', value: nextPatch(s.version), pattern: '\\d+\\.\\d+\\.\\d+', required: true });
    const err = h('p', { class: 'err', role: 'alert' });
    put(library, h('button', { type: 'button', onclick: () => openDetail(s.name) }, '← Annuler'), h('h2', { tabindex: '-1' }, `Modifier « ${s.title || s.name} »`),
      h('p', { class: 'note' }, `Version actuelle ${s.version}. Une modification sans nouvelle version est refusée. L’ancien contenu reste consultable dans l’historique. Le nom ne peut pas changer ici.`),
      h('form', { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = '';
        try { const r = await send('PUT', `/api/skills/${enc(s.name)}`, { content: content.value, version: version.value, baseHash: s.hash }); announce(r.changed ? `Version ${r.version} enregistrée` : 'Aucun changement'); await openDetail(s.name); const p = library.querySelector('p[role=status]'); if (p) p.textContent = `${r.changed ? `Version ${r.version} enregistrée.` : 'Contenu identique : rien à enregistrer.'} ${copiesText(r.copies)}`; }
        catch (x) { err.textContent = x.message; }
      } }, content, field('Nouvelle version', version), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, 'Enregistrer'), h('button', { type: 'button', onclick: () => openDetail(s.name) }, 'Annuler')), err));
    content.focus();
  }

  // --- créer ---
  function createPanel() {
    const box = h('div');
    (async () => {
      let cats = categories;
      if (!cats.length) cats = categories = await get('/api/skills/categories').catch(() => []);
      const err = h('p', { class: 'err', role: 'alert' }), status = h('p', { class: 'note', role: 'status' });
      const f = h('form', { onsubmit: async (e) => {
        e.preventDefault(); err.textContent = ''; status.textContent = '';
        const d = Object.fromEntries(new FormData(f));
        try { const r = await send('POST', '/api/skills', { ...d, roles: list(d.roles), dependsOn: list(d.dependsOn) }); announce(`Skill ${r.skill} créé`); f.reset(); status.textContent = `Skill « ${r.skill} » créé (version 1.0.0). ${copiesText(r.copies)} Il n’est affecté à personne : ouvrez la fiche d’un agent pour l’ajouter.`; }
        catch (x) { err.textContent = x.message; }
      } },
      field('Nom technique', h('input', { name: 'name', required: true, maxlength: 64, pattern: '[a-z0-9]+(-[a-z0-9]+)*', placeholder: 'workeda-mon-skill', autocapitalize: 'none' })),
      field('Titre affiché', h('input', { name: 'title', maxlength: 80 })),
      field('Description (quand l’utiliser)', h('textarea', { name: 'description', rows: '3', required: true, maxlength: 1024 })),
      field('Consignes (Markdown)', h('textarea', { name: 'body', rows: '10', required: true, class: 'skill-editor', spellcheck: 'false' })),
      field('Catégorie', h('select', { name: 'category', required: true }, cats.map((c) => h('option', { value: c.slug }, c.name)))),
      field('Métiers concernés (séparés par des virgules)', h('input', { name: 'roles', placeholder: 'prix, marge' })),
      field('Dépend de (noms séparés par des virgules)', h('input', { name: 'dependsOn' })),
      h('p', { class: 'note' }, 'Le Skill est écrit dans skills/ puis copié pour Claude Code et Codex. Aucun script, aucune permission : du texte seulement. Les contenus dangereux sont refusés.'),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, 'Créer le Skill')), status, err);
      put(box, f);
    })();
    return box;
  }

  // --- importer depuis GitHub ---
  function importPanel() {
    const out = h('div'), err = h('p', { class: 'err', role: 'alert' });
    const url = h('input', { name: 'url', type: 'url', required: true, placeholder: 'https://github.com/…/SKILL.md', autocapitalize: 'none' });
    const cat = h('select', { name: 'category' });
    (async () => { const cats = categories.length ? categories : (categories = await get('/api/skills/categories').catch(() => [])); put(cat, ...cats.map((c) => h('option', { value: c.slug }, c.name))); })();
    const roles = h('input', { name: 'roles', placeholder: 'métiers, séparés par des virgules' });
    const f = h('form', { onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; put(out, h('p', { class: 'note', role: 'status' }, 'Téléchargement de SKILL.md seul…'));
      try { const { preview: p } = await send('POST', '/api/skills/import', { url: url.value }); drawPreview(p); } catch (x) { put(out); err.textContent = x.message; }
    } }, field('Adresse du SKILL.md sur GitHub', url), h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, 'Aperçu (rien n’est écrit)')), err);
    function drawPreview(p) {
      const status = h('p', { class: 'note', role: 'status' }), perr = h('p', { class: 'err', role: 'alert' });
      const go = h('button', { type: 'button', class: 'primary', disabled: p.blocked || p.exists, onclick: async () => {
        go.disabled = true; perr.textContent = '';
        try { const r = await send('POST', '/api/skills/import', { url: url.value, hash: p.hash, category: cat.value, roles: list(roles.value) }); announce(`Skill ${r.skill} importé`); status.textContent = `« ${r.skill} » importé (v1.0.0). ${copiesText(r.copies)} Il n’est affecté à aucun agent.`; }
        catch (x) { perr.textContent = x.message; go.disabled = false; }
      } }, 'Importer ce Skill');
      put(out, h('h3', {}, p.name), h('p', {}, p.description), h('div', { class: 'skill-chips' }, h('span', { class: 'chip soft' }, `Licence : ${p.license ?? 'non précisée'}`), h('span', { class: 'chip soft' }, tokenLabel(p.tokens))),
        h('p', { class: 'note' }, `Source : ${p.source}`),
        h('p', { class: 'note' }, `Claude Code : ${compatText(p.compat?.claude)} · Codex : ${compatText(p.compat?.codex)}`),
        findingsBlock(p.findings),
        p.blocked && h('p', { class: 'err', role: 'alert' }, 'Import refusé : le contenu est bloquant.'),
        p.exists && h('p', { class: 'err', role: 'alert' }, 'Un Skill porte déjà ce nom : rien n’est écrasé.'),
        h('details', {}, h('summary', {}, 'Lire le contenu avant d’importer'), h('pre', { class: 'skill-content', tabindex: '0' }, p.content)),
        field('Catégorie', cat), field('Métiers', roles),
        h('p', { class: 'note' }, 'Seul SKILL.md est téléchargé. Aucun script du dépôt n’est téléchargé ni exécuté. Relisez la licence et le contenu.'),
        h('div', { class: 'row' }, go), status, perr);
    }
    return h('div', {}, f, out);
  }

  // --- état ---
  function healthPanel() {
    const box = h('div', {}, h('p', { class: 'note', role: 'status' }, 'Chargement…'));
    async function load(msg = '') {
      try {
        const [hl, st] = await Promise.all([get('/api/skills/health'), get('/api/skills/stats')]);
        const err = h('p', { class: 'err', role: 'alert' }), status = h('p', { class: 'note', role: 'status' }, msg);
        const fix = h('button', { type: 'button', class: 'primary', onclick: async () => { fix.disabled = true; try { const r = await send('POST', '/api/skills/sync'); announce('Copies régénérées'); await load(copiesText(r)); } catch (x) { err.textContent = x.message; fix.disabled = false; } } }, 'Régénérer les copies');
        put(box, 
          h('h3', {}, 'Bibliothèque'), h('p', {}, `${st.active} actif${st.active > 1 ? 's' : ''}, ${st.archived} archivé${st.archived > 1 ? 's' : ''}, ${st.missing} manquant${st.missing > 1 ? 's' : ''} · ${tokenLabel(st.libraryTokens)} au total (estimation) · ${st.agentsWithSkills} agent${st.agentsWithSkills > 1 ? 's' : ''} équipé${st.agentsWithSkills > 1 ? 's' : ''}`),
          h('h3', {}, 'Cohérence des fiches et des Skills'), hl.problems.length ? h('ul', {}, hl.problems.map((p) => h('li', { class: 'err' }, p))) : h('p', {}, 'Aucun problème détecté.'),
          h('h3', {}, 'Copies pour Claude Code et Codex'), h('p', {}, copiesText(hl.copies)),
          h('p', { class: 'note' }, 'Copies écrites dans .claude/skills (Skills préchargés) et .agents/skills (tous les Skills actifs). Seuls les dossiers gérés par Archipel sont touchés ; rien n’est supprimé.'),
          !hl.copies.inSync && h('div', { class: 'row' }, fix),
          h('h3', {}, 'Coût de préchargement par agent'), st.perAgent.length ? h('ul', {}, st.perAgent.map((a) => h('li', {}, `${a.name} : ${a.skills} / ${st.maxPreloaded} Skills, ${tokenLabel(a.preloadedTokens)}`))) : h('p', {}, 'Aucun agent équipé.'),
          h('p', { class: 'note' }, 'Estimation à 4 caractères par jeton. Archipel ne peut pas prouver qu’un agent utilise ses Skills : vérifiez après un redémarrage de Claude Code (voir le README).'),
          status, err);
      } catch (x) { put(box, h('p', { class: 'err', role: 'alert' }, x.message)); }
    }
    load();
    return box;
  }

  tabs = tabset([
    { label: 'Bibliothèque', render: () => { renderLibrary(); return library; } },
    { label: 'Créer', render: createPanel },
    { label: 'Importer', render: importPanel },
    { label: 'État', render: healthPanel }
  ], 0, undefined, 'Sections du centre Skills');
  if (initial) queueMicrotask(() => openDetail(initial, { focus: false }));
  return h('div', { class: 'agent-detail skills-center' }, h('header', { class: 'agent-heading' }, h('div', {}, h('h2', {}, 'Skills'), h('p', {}, 'Bibliothèque partagée des agents'), h('p', { class: 'agent-department' }, 'Source : dossier skills/ du projet'))), tabs.el);
}
