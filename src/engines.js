// src/engines.js — règles pures sur les moteurs IA (aucun accès base, réseau ou processus).
export const DEFAULT_PROVIDER = 'claude';
export const FAMILIES = ['opus', 'sonnet', 'haiku'];
const MODEL_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:\[\]-]{0,99}$/;
const PROVIDER_ID = /^[a-z][a-z0-9-]{0,31}$/;
export const isModelId = (v) => typeof v === 'string' && MODEL_ID.test(v);
export const isProviderId = (v) => typeof v === 'string' && PROVIDER_ID.test(v);
// Modèle d'une réponse principale ; les sous-appels et les messages fabriqués par Claude Code (« <synthetic> ») ne comptent pas.
export const modelOfEvent = (e) => (e?.type === 'assistant' && !e.parent_tool_use_id && isModelId(e.message?.model) ? e.message.model : null);
export const familyOf = (model) => { const words = String(model ?? '').toLowerCase().split(/[^a-z]+/); return FAMILIES.find((f) => words.includes(f)) ?? null; };
export function checkModel(requested, observed = []) {
  const list = [...new Set((observed ?? []).filter(isModelId))];
  if (!requested || !list.length) return { status: 'unknown', requested: requested ?? null, observed: list };
  const want = familyOf(requested);
  const same = list.every((m) => (want ? familyOf(m) === want : m === requested));
  return { status: same ? 'match' : 'mismatch', requested, observed: list };
}
export const mismatchText = (c) => `Modèle différent du demandé : « ${c.requested} » demandé, « ${c.observed.join(', ')} » constaté.`;
export const CATALOG = Object.freeze([
  { provider: 'claude', label: 'Claude', models: FAMILIES, state: 'available', reason: '' },
  { provider: 'codex', label: 'Codex', models: [], state: 'disabled', reason: 'Désactivé : isolation non démontrée, autorisation requise, aucun runner.' },
  { provider: 'gemini', label: 'Gemini', models: [], state: 'not_configured', reason: 'Non configuré.' }
]);
export const engineId = (e) => (e ? `${e.provider}:${e.model}` : 'inconnu');
// Pourquoi le catalogue refuse ce moteur ; chaîne vide s'il est permis.
export function catalogReason(e) {
  if (!e) return '';
  const p = CATALOG.find((x) => x.provider === e.provider);
  if (!p) return `Fournisseur inconnu « ${e.provider} » : la demande attend.`;
  if (p.state !== 'available') return `${p.label} — ${p.reason}`;
  return p.models.includes(e.model) ? '' : `Modèle inconnu « ${e.model} » pour ${p.label} : la demande attend.`;
}
const refuse = (message) => Object.assign(new Error(message), { status: 400 });
// Choix saisi par le propriétaire : null efface le choix ; tout le reste doit être au catalogue.
export function parseEngine(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || !isProviderId(input.provider) || !isModelId(input.model)) throw refuse('Moteur invalide.');
  const why = catalogReason(input); if (why) throw refuse(`Moteur refusé. ${why}`);
  return { provider: input.provider, model: input.model };
}
export function resolveEngine({ mission = null, agent = null, fiche = null } = {}) {
  for (const [source, e] of [['mission', mission], ['agent', agent], ['fiche', fiche]]) if (e) return { provider: e.provider, model: e.model, source };
  return null;
}
