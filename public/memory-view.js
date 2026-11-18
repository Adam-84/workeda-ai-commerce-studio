// Fonctions pures du Memory Center (libellés, filtres, formulaires). Aucune dépendance au DOM : testées sous Node.

export const LEVELS = [['individual', 'Individuelle'], ['department', 'Département'], ['company', 'Entreprise'], ['mission', 'Mission']];
export const KINDS = [['knowledge', 'Connaissance'], ['experience', 'Expérience'], ['preference', 'Préférence'], ['lesson', 'Leçon apprise'], ['error', 'Erreur'], ['solution', 'Solution'], ['procedure', 'Procédure'], ['report', 'Rapport'], ['decision', 'Décision'], ['rule', 'Règle'], ['opportunity', 'Opportunité'], ['recommendation', 'Recommandation'], ['source', 'Source']];
export const NATURES = [['fact', 'Fait vérifié'], ['hypothesis', 'Hypothèse'], ['proposal', 'Proposition'], ['decision', 'Décision approuvée']];
export const STATES = [['pending', 'À valider'], ['active', 'Actif'], ['rejected', 'Rejeté'], ['archived', 'Archivé']];
export const CONFIDENCES = [['low', 'Faible'], ['medium', 'Moyenne'], ['high', 'Élevée']];
export const VISIBILITIES = [['private', 'Privée (propriétaire seulement)'], ['department', 'Mon département'], ['mission', 'Participants à la mission'], ['company', 'Toute l’entreprise']];

const pick = (table) => { const m = new Map(table); return (key) => m.get(key) ?? String(key ?? ''); };
export const levelLabel = pick(LEVELS), kindLabel = pick(KINDS), natureLabel = pick(NATURES), stateLabel = pick(STATES), confidenceLabel = pick(CONFIDENCES), visibilityLabel = pick(VISIBILITIES);

export const NATURE_HINT = {
  fact: 'Vérifié et sourcé par le propriétaire.',
  hypothesis: 'Non vérifié : à confirmer avant de s’y fier.',
  proposal: 'Idée proposée, pas encore décidée.',
  decision: 'Choix approuvé par le propriétaire.'
};

// Actions possibles selon l'état (même machine d'états que le serveur, qui reste l'arbitre).
const TRANSITIONS = { pending: ['active', 'rejected', 'deleted'], active: ['archived', 'deleted'], archived: ['active', 'deleted'], rejected: ['pending', 'deleted'] };
export const stateActions = (state) => (TRANSITIONS[state] ?? []).map((to) => ({ to, label: ACTION_LABEL[to][state] ?? ACTION_LABEL[to].default, danger: to === 'deleted' }));
const ACTION_LABEL = {
  active: { pending: 'Valider', archived: 'Restaurer', default: 'Activer' },
  rejected: { default: 'Rejeter' },
  archived: { default: 'Archiver' },
  pending: { rejected: 'Rouvrir', default: 'Rouvrir' },
  deleted: { default: 'Supprimer' }
};
export const CONFIRM_TEXT = {
  active: 'Ce souvenir sera utilisé par les agents autorisés à le lire.',
  rejected: 'La proposition ne sera jamais transmise aux agents. Elle reste consultable.',
  archived: 'Il ne sera plus transmis aux agents. Vous pourrez le restaurer.',
  pending: 'La proposition revient dans la liste à valider.',
  deleted: 'Le contenu est effacé définitivement, sur tous vos ordinateurs. Seule une trace vide reste pour la synchronisation.'
};

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

export function freshnessLabel(item) {
  if (item.expired) return 'Expiré';
  if (item.stale) return `À revoir (${item.ageDays} j sans mise à jour)`;
  return item.ageDays < 1 ? 'Mis à jour aujourd’hui' : `Mis à jour il y a ${item.ageDays} j`;
}

export function scopeLabel(item, { nameOf = (ref) => ref } = {}) {
  switch (item.level) {
    case 'individual': return `Individuelle · ${nameOf(item.owner)}`;
    case 'department': return `Département · ${item.department ?? '?'}`;
    case 'mission': return 'Mission';
    default: return 'Entreprise';
  }
}

export function importanceLabel(n) { return `Importance ${Number(n) || 3}/5`; }

export function filterMemory(items, f = {}) {
  const needle = fold(f.query).trim();
  const tag = fold(f.tag);
  return items.filter((i) => (!f.level || i.level === f.level) && (!f.kind || i.kind === f.kind) && (!f.nature || i.nature === f.nature) && (!f.state || i.state === f.state)
    && (!f.owner || i.owner === f.owner) && (!f.department || i.department === f.department) && (!tag || i.tags.includes(tag))
    && (!needle || fold(`${i.title} ${i.body} ${i.tags.join(' ')} ${i.source ?? ''}`).includes(needle)));
}

export const tagsOf = (items) => [...new Set(items.flatMap((i) => i.tags))].sort((a, b) => a.localeCompare(b, 'fr'));
export const departmentsOf = (items) => [...new Set(items.map((i) => i.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'fr'));

export const parseTags = (text) => [...new Set(String(text ?? '').split(/[,\n]/).map((t) => t.trim().toLocaleLowerCase('fr')).filter(Boolean))].slice(0, 10);

// Une source par ligne : « Libellé | https://adresse (facultative) | note (facultative) ».
export function parseSources(text) {
  return String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const [label, url = '', note = ''] = line.split('|').map((p) => p.trim());
    const s = { label };
    if (/^https?:\/\//i.test(url)) s.url = url; else if (url && !note) s.note = url;
    if (note) s.note = note;
    return s;
  });
}
export const sourcesText = (sources = []) => sources.map((s) => [s.label, s.url ?? '', s.note ?? ''].join(' | ').replace(/( \| )+$/, '')).join('\n');
export function sourceLine(s) {
  return [s.label, s.url, s.note, s.checkedAt ? `vérifiée le ${new Date(s.checkedAt).toLocaleDateString('fr-FR')}` : null].filter(Boolean).join(' · ');
}

// Données du formulaire → corps de requête. Le serveur revalide tout (secrets, doublons, cohérence).
export function buildPayload(data) {
  const out = {
    level: data.level, kind: data.kind, nature: data.nature, title: String(data.title ?? '').trim(), body: String(data.body ?? '').trim(),
    tags: parseTags(data.tags), sources: parseSources(data.sources), importance: Number(data.importance || 3), confidence: data.confidence || 'medium',
    visibility: data.visibility || undefined, expiresAt: data.expiresAt ? new Date(`${data.expiresAt}T23:59:59`).toISOString() : null
  };
  if (data.level === 'individual') out.owner = data.owner || null;
  if (data.level === 'department') out.department = data.department || null;
  if (data.level === 'mission') out.missionId = data.missionId || null;
  return out;
}

export const ACTION_LABELS = {
  created: 'Créé', proposed: 'Proposé par un agent', updated: 'Modifié', approved: 'Validé', rejected: 'Rejeté', archived: 'Archivé', deleted: 'Supprimé', reopened: 'Rouvert',
  'sync.imported': 'Reçu d’un autre ordinateur', 'sync.deleted': 'Suppression reçue d’un autre ordinateur', 'sync.superseded': 'Ancienne version reçue (conservée ici)'
};
export const actionLabel = (a) => ACTION_LABELS[a] ?? a;
export function actorLabel(actor) {
  if (!actor) return '';
  if (actor === 'proprietaire') return 'vous';
  if (actor.startsWith('agent:')) return `agent ${actor.slice(6)}`;
  if (actor.startsWith('appareil:')) return `ordinateur ${actor.slice(9)}`;
  return actor;
}

export const statsLine = (s) => `${s.total} souvenir${s.total > 1 ? 's' : ''} · ${s.pending} à valider · ${s.stale} à revoir · ${s.expired} expiré${s.expired > 1 ? 's' : ''}`;

// Sépare le texte de l'aperçu de contexte d'un agent en lignes lisibles.
export const contextSummary = (c) => `${c.items.length} souvenir${c.items.length > 1 ? 's' : ''} transmis${c.omitted ? `, ${c.omitted} laissé${c.omitted > 1 ? 's' : ''} de côté (budget)` : ''} · ≈ ${c.tokens} jetons`;
