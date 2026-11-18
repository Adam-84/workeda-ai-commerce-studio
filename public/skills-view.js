// Fonctions pures de l'interface Skills (testées sous Node, sans DOM).
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export const STATUS_FR = { active: 'Actif', archived: 'Archivé', missing: 'Dossier manquant' };
export const ORIGIN_FR = { workeda: 'Workeda', custom: 'Créé ici', imported: 'Importé', github: 'Importé', anthropic: 'Anthropic', official: 'Officiel' };

export const statusLabel = (s) => STATUS_FR[s] ?? String(s ?? '');
export const originLabel = (o) => ORIGIN_FR[o] ?? String(o ?? '');

// Les jetons sont une estimation (caractères / 4), jamais une mesure faite par un modèle.
export const tokenLabel = (n) => `≈ ${Number(n) || 0} jetons`;
export const budgetLabel = (count, max, tokens) => `${count} / ${max} Skills préchargés · ${tokenLabel(tokens)} (estimation)`;

// Filtre la bibliothèque : texte (nom, titre, description, métiers), catégorie, statut.
export function filterSkills(skills, { query = '', category = '', status = 'active', agent = '' } = {}) {
  const q = fold(query).trim();
  return skills.filter((s) => {
    if (status && s.status !== status) return false;
    if (category && s.category !== category) return false;
    if (agent && !(s.agents ?? []).some((a) => a.id === agent)) return false;
    if (!q) return true;
    return fold([s.name, s.title, s.description, ...(s.roles ?? [])].join(' ')).includes(q);
  });
}

export function groupByCategory(skills, categories) {
  const order = categories.map((c) => c.slug);
  const groups = new Map(categories.map((c) => [c.slug, { slug: c.slug, name: c.name, skills: [] }]));
  for (const s of skills) {
    if (!groups.has(s.category)) groups.set(s.category, { slug: s.category, name: s.category, skills: [] });
    groups.get(s.category).skills.push(s);
  }
  return [...groups.values()].filter((g) => g.skills.length).sort((a, b) => (order.indexOf(a.slug) + 1 || 99) - (order.indexOf(b.slug) + 1 || 99));
}

// Verdict d'affectation affiché avant d'appeler l'API (le serveur reste l'arbitre).
export function assignCheck(skill, preloaded, max) {
  const names = new Set(preloaded.map((s) => s.name));
  if (names.has(skill.name)) return { ok: false, reason: 'Déjà préchargé.' };
  if (preloaded.length >= max) return { ok: false, reason: `Limite de ${max} Skills préchargés atteinte : retirez-en un d’abord.` };
  const missing = (skill.dependsOn ?? []).filter((d) => !names.has(d));
  if (missing.length) return { ok: false, reason: `Demande d’abord : ${missing.join(', ')}.`, missing };
  return { ok: true, reason: '' };
}

export function unassignCheck(skill, preloaded) {
  const blockers = preloaded.filter((s) => (s.dependsOn ?? []).includes(skill.name)).map((s) => s.name);
  return blockers.length ? { ok: false, reason: `Utilisé par : ${blockers.join(', ')}.`, blockers } : { ok: true, reason: '' };
}

// Deux formes : résultat d'une écriture ({ written, skipped, conflict }) ou état de contrôle ({ inSync, missing, outdated, conflict }).
export const copiesText = (copies) => {
  if (!copies) return '';
  if (Array.isArray(copies.written)) {
    const n = copies.written.length, k = copies.conflict?.length ?? 0;
    return `${n} copie${n > 1 ? 's' : ''} écrite${n > 1 ? 's' : ''}, ${copies.skipped?.length ?? 0} déjà à jour${k ? `, ${k} dossier${k > 1 ? 's' : ''} non géré${k > 1 ? 's' : ''} laissé${k > 1 ? 's' : ''} intact${k > 1 ? 's' : ''}` : ''}.`;
  }
  if (copies.inSync) return 'Copies Claude Code et Codex à jour.';
  const parts = [];
  if (copies.missing?.length) parts.push(`${copies.missing.length} absente(s)`);
  if (copies.outdated?.length) parts.push(`${copies.outdated.length} périmée(s)`);
  if (copies.conflict?.length) parts.push(`${copies.conflict.length} dossier(s) non géré(s), laissé(s) intacts`);
  return `Copies à régénérer : ${parts.join(', ')}.`;
};

export const findingText = (f) => `${f.severity === 'bloquant' ? 'Bloquant' : f.severity === 'attention' ? 'Attention' : 'Info'} : ${f.message ?? f.reason ?? f.rule ?? ''}`.trim();
export const compatText = (c) => (c?.ok ? 'compatible' : `à corriger (${(c?.issues ?? []).join(' ; ') || 'non vérifié'})`);

// Prochaine version patch proposée à l'édition.
export function nextPatch(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version ?? ''));
  return m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '1.0.1';
}
