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
