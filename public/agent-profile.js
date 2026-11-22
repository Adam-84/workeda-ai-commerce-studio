// public/agent-profile.js — textes de l'onglet Profil (module pur, testé sous Node).
const CONNECTOR_LABELS = { 'shopify-cli': 'Shopify CLI', 'codex-cli': 'Codex CLI', 'shopify-admin': 'Shopify Admin', 'shopify-apps': 'Applications Shopify (inventaire déclaré)', dsers: 'DSers', playwright: 'Playwright', web: 'Recherche web' };
const STATE_LABELS = { detected: 'détecté', missing: 'non détecté', not_connected: 'non connecté', claude_code_only: 'dans Claude Code uniquement' };
const MODEL_LABELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pick = (table, key, fallback) => (Object.hasOwn(table, key) ? table[key] : fallback);

export const FULL_SECTIONS = [['neFaitJamais', 'Ne fait jamais'], ['missions', 'Missions'], ['regles', 'Règles'], ['methode', 'Méthode'], ['relais', 'Relais'], ['reussite', 'Réussite']];
export const connectorText = (c) => `${pick(CONNECTOR_LABELS, c.id, c.id)} : ${c.state == null ? 'état inconnu' : pick(STATE_LABELS, c.state, c.state)}`;
export const modelLabel = (m) => pick(MODEL_LABELS, m, m);
// Un collègue présent devient un bouton (agentId) ; absent, il reste du texte.
export const colleagues = (profile, agents) => {
  if (profile.collaboratesAll) return [{ label: 'Toute l’équipe', agentId: null }];
  const byId = new Map(agents.map((a) => [a.id, a]));
  return profile.collaborates.map(({ slug, agentId }) => {
    const a = agentId && byId.get(agentId);
    return a ? { label: a.name, agentId: a.id } : { label: cap(slug), agentId: null };
  });
};
export const ignoredText = (n) => (n ? ` · ${n} fiche${n > 1 ? 's' : ''} ignorée${n > 1 ? 's' : ''}` : '');
export const helpLine = (name) => `Dans Claude Code, demande : "${name}, …"`;
