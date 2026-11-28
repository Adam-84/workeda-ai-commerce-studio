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
export const QUOTA_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'];
const QUOTA_STATES = ['allowed', 'allowed_warning', 'rejected'];
const SOURCE_ID = /^[a-zA-Z0-9_-]{1,64}$/;
// Signal de quota borné : tout champ absent ou illisible reste inconnu (null).
export function cleanSignal(raw) {
  if (!raw || !QUOTA_STATES.includes(raw.status)) return null;
  const at = typeof raw.resetsAt === 'string' ? Date.parse(raw.resetsAt) : NaN;
  return {
    status: raw.status, window: QUOTA_WINDOWS.includes(raw.window) ? raw.window : 'unknown',
    utilization: Number.isFinite(raw.utilization) && raw.utilization >= 0 && raw.utilization <= 1 ? raw.utilization : null, // fraction
    resetsAt: Number.isFinite(at) ? new Date(at).toISOString() : null, overage: typeof raw.overage === 'boolean' ? raw.overage : null
  };
}
// Événement « rate_limit_event » de Claude Code. « archipel_source » n'est posé que par le serveur central.
export function quotaOfEvent(event) {
  const info = event?.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (!info) return null;
  const seconds = info.resetsAt;
  const signal = cleanSignal({ status: info.status, window: info.rateLimitType, utilization: info.utilization, resetsAt: Number.isFinite(seconds) && seconds > 0 && seconds < 1e11 ? new Date(seconds * 1000).toISOString() : null, overage: info.isUsingOverage });
  return signal && { ...signal, source: SOURCE_ID.test(event.archipel_source ?? '') ? event.archipel_source : 'local' };
}
// Deux relevés d'une même fenêtre pendant une exécution : une information absente ne contredit pas la précédente.
export const mergeSignal = (previous, next) => (next.overage === null && previous ? { ...next, overage: previous.overage } : next);
export const signalStale = (s, now = Date.now()) => Boolean(s.resetsAt && Date.parse(s.resetsAt) <= now);
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
const MODEL_WINDOWS = { seven_day_opus: 'opus', seven_day_sonnet: 'sonnet' };
const isConfirmed = (s, now) => Boolean(s.confirmedUntil && Date.parse(s.confirmedUntil) > now);
// Ce qu'une confirmation du propriétaire peut lever : un refus sans date, ou une dépense supplémentaire non masquée par un refus daté général.
export function needsConfirmation(s, now = Date.now()) {
  if (signalStale(s, now) || isConfirmed(s, now)) return false;
  if (s.status === 'rejected' && !s.resetsAt) return true;
  return Boolean(s.overage) && !(s.status === 'rejected' && !MODEL_WINDOWS[s.window]);
}
// Pourquoi ce signal fait attendre ce moteur ; chaîne vide s'il ne bloque pas.
// Une limite de modèle ne retient que ce modèle ; une dépense supplémentaire les retient tous.
export function signalReason(s, engine, now = Date.now()) {
  if (signalStale(s, now)) return '';
  const confirmed = isConfirmed(s, now);
  const only = MODEL_WINDOWS[s.window];
  if (s.status === 'rejected' && (!only || engine?.model === only)) {
    if (s.resetsAt) return `Limite Claude atteinte : reprise après le ${when(s.resetsAt)}.`;
    return confirmed ? '' : 'Limite Claude atteinte sans date de remise à zéro : confirmez la reprise.';
  }
  return s.overage && !confirmed ? 'Dépense supplémentaire signalée par Claude : confirmez avant de relancer.' : '';
}
