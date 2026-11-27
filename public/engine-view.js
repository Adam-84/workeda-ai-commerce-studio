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
