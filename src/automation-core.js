import { createHash, randomUUID } from 'node:crypto';
import { validateSchedule } from './automation-schedule.js';
import { findSecret } from './memory-core.js';

export const SOURCES = ['catalog', 'shopify_apps', 'manual_import', 'dsers', 'track17', 'shopify_admin', 'missions', 'recommendations', 'competitor', 'metrics'];
export const EVENTS = ['catalog.changed', 'competitor.price_changed', 'logistics.anomaly', 'mission.done', 'mission.failed', 'recommendation.pending'];
export const LIMITS = { perRule: 5, global: 20, active: 1, ttlMs: 86400000, leaseMs: 90000, maxRules: 100 };
export const error = (message, status = 400) => Object.assign(new Error(message), { status });
export const hash = (v) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const bounded = (v, max, name) => { if (typeof v !== 'string' || !v.trim() || v.length > max || findSecret(v)) throw error(`${name} invalide ou sensible.`); return v.trim(); };

export function validateCondition(c = {}) {
  if (!['stale', 'variation', 'margin', 'metric'].includes(c.kind)) throw error('Condition non prise en charge.');
  const field = { stale: 'minutes', variation: 'percent', margin: 'below', metric: 'above' }[c.kind];
  if (!Number.isFinite(c[field]) || c[field] < 0 || c[field] > 1e9) throw error('Seuil invalide.');
  return { kind: c.kind, [field]: c[field] };
}
export function validateDefinition(v = {}) {
  const kind = v.trigger?.kind;
  if (!['time', 'event', 'condition'].includes(kind)) throw error('Déclencheur invalide.');
  const trigger = kind === 'time' ? { kind, schedule: validateSchedule(v.trigger.schedule) } : kind === 'event' ? { kind, event: v.trigger.event } : { kind, condition: validateCondition(v.trigger.condition) };
  if (kind === 'event' && !EVENTS.includes(trigger.event)) throw error('Événement invalide.');
  if (!Array.isArray(v.sources) || !v.sources.length || v.sources.length > 4 || v.sources.some((x) => !SOURCES.includes(x))) throw error('Choisissez 1 à 4 sources connues.');
  if (!/^[a-z][a-z0-9-]{0,59}$/.test(v.agentSlug ?? '')) throw error('Agent invalide.');
  const perDay = v.perDay ?? 5, freshnessMinutes = v.freshnessMinutes ?? 1440, cooldownMinutes = v.cooldownMinutes ?? 60;
  if (![perDay, freshnessMinutes, cooldownMinutes].every(Number.isInteger) || perDay < 1 || perDay > 5 || freshnessMinutes < 5 || freshnessMinutes > 43200 || cooldownMinutes < 15 || cooldownMinutes > 43200) throw error('Limites invalides.');
  if (v.id != null && !/^[a-zA-Z0-9-]{1,80}$/.test(v.id)) throw error('Identifiant invalide.');
  const budgetUsd = v.budgetUsd ?? 1, tokenBudget = v.tokenBudget ?? 20000;
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0.1 || budgetUsd > 100 || !Number.isInteger(tokenBudget) || tokenBudget < 100 || tokenBudget > 1000000) throw error('Budget de consommation invalide.');
  return { schemaVersion: 1, id: v.id ?? randomUUID(), revision: 1, name: bounded(v.name, 100, 'Nom'), agentSlug: v.agentSlug, objective: bounded(v.objective, 2000, 'Objectif'), sources: [...new Set(v.sources)].sort(), trigger, allowAi: v.allowAi === true, perDay, freshnessMinutes, cooldownMinutes, budgetUsd, tokenBudget };
}
export function condition(c, data, now = Date.now()) {
  let value;
  if (c.kind === 'stale') value = data.fetchedAt ? (now - Date.parse(data.fetchedAt)) / 60000 : NaN;
  if (c.kind === 'variation') value = Number.isFinite(data.before) && data.before > 0 && Number.isFinite(data.after) ? Math.abs(data.after - data.before) / data.before * 100 : NaN;
  if (c.kind === 'margin') value = Number.isFinite(data.price) && data.price > 0 && Number.isFinite(data.cost) && data.cost >= 0 && data.currency && data.currency === data.costCurrency ? (data.price - data.cost) / data.price * 100 : NaN;
  if (c.kind === 'metric') value = Number.isFinite(data.value) ? data.value : NaN;
  return { available: Number.isFinite(value), value: Number.isFinite(value) ? value : null, matched: Number.isFinite(value) && (c.kind === 'margin' ? value < c.below : value >= (c.minutes ?? c.percent ?? c.above)) };
}
