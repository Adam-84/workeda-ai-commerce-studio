// public/engine-view.js — libellés et options du moteur IA (fonctions pures, testées dans Node).
export const SOURCES = { mission: 'choix de la mission', agent: 'choix de l’agent', fiche: 'fiche', task: 'choisi pour cette tâche' };
export const PROVIDERS = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
const MODELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
export const engineLabel = (e) => (e?.provider && e?.model ? `${PROVIDERS[e.provider] ?? e.provider} ${MODELS[e.model] ?? e.model}` : 'Moteur inconnu');
export const engineValue = (e) => (e ? `${e.provider}:${e.model}` : '');
export function engineFromValue(value) { if (!value) return null; const i = value.indexOf(':'); return { provider: value.slice(0, i), model: value.slice(i + 1) }; }
export function engineOptions(catalog = [], defaultLabel = 'Choix par défaut') {
  const out = [{ value: '', label: defaultLabel, disabled: false }];
  for (const p of catalog) {
    if (p.state !== 'available') { out.push({ value: `${p.provider}:`, label: `${p.label} — ${p.reason}`, disabled: true }); continue; }
    for (const m of p.models) out.push({ value: `${p.provider}:${m.model}`, label: `${engineLabel({ provider: p.provider, model: m.model })}${m.reason ? ' — indisponible pour le moment' : ''}`, disabled: false });
  }
  return out;
}
export const optionNodes = (h, catalog, current, defaultLabel) => engineOptions(catalog, defaultLabel).map((o) => h('option', { value: o.value, disabled: o.disabled, selected: o.value === engineValue(current) }, o.label));
export const affectedAutomations = (rules = [], slug) => rules.filter((r) => r.enabled && r.allowAi && r.agentSlug === slug).map((r) => r.name);
const WINDOWS = { five_hour: 'fenêtre de 5 h', seven_day: 'semaine', seven_day_opus: 'semaine Opus', seven_day_sonnet: 'semaine Sonnet', overage: 'dépense supplémentaire', unknown: 'fenêtre non précisée' };
const QUOTA = { allowed: 'autorisé', allowed_warning: 'proche de la limite', rejected: 'refusé' };
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
export const sourceName = (source) => (source === 'local' ? 'cet ordinateur' : `worker ${source.slice(0, 8)}`);
export function signalLine(s) {
  const head = `${PROVIDERS[s.provider] ?? s.provider} · ${sourceName(s.source)} · ${WINDOWS[s.window] ?? s.window}`;
  if (s.stale) return `${head} : Inconnu (relevé du ${when(s.observedAt)} périmé)`;
  const used = s.utilization == null ? 'consommation inconnue' : `${Math.round(s.utilization * 100)} % utilisés`;
  return `${head} : ${QUOTA[s.status] ?? s.status}${s.overage ? ', dépense supplémentaire en cours' : ''} · ${used} · ${s.resetsAt ? `remise à zéro ${when(s.resetsAt)}` : 'remise à zéro inconnue'} · relevé du ${when(s.observedAt)}`;
}
