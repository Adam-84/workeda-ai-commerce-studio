// public/agent-profile.js — textes de l'onglet Profil (module pur, testé sous Node).
const CONNECTOR_LABELS = { 'shopify-cli': 'Shopify CLI', 'codex-cli': 'Codex CLI', 'shopify-admin': 'Shopify Admin', dsers: 'DSers', playwright: 'Playwright', web: 'Recherche web' };
const STATE_LABELS = { detected: 'détecté', missing: 'non détecté', not_connected: 'non connecté', claude_code_only: 'dans Claude Code uniquement' };
const MODEL_LABELS = { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export const FULL_SECTIONS = [['neFaitJamais', 'Ne fait jamais'], ['missions', 'Missions'], ['regles', 'Règles'], ['methode', 'Méthode'], ['relais', 'Relais'], ['reussite', 'Réussite']];
export const connectorText = (c) => `${CONNECTOR_LABELS[c.id] ?? c.id} : ${STATE_LABELS[c.state] ?? c.state}`;
export const modelLabel = (m) => MODEL_LABELS[m] ?? m;
// Un collègue présent devient un bouton (agentId) ; absent, il reste du texte.
export const colleagues = (profile, agents) => profile.collaboratesAll
  ? [{ label: 'Toute l’équipe', agentId: null }]
  : profile.collaborates.map((c) => { const a = c.agentId && agents.find((x) => x.id === c.agentId); return a ? { label: a.name, agentId: a.id } : { label: cap(c.slug), agentId: null }; });
export const ignoredText = (n) => (n ? ` · ${n} fiche${n > 1 ? 's' : ''} ignorée${n > 1 ? 's' : ''}` : '');
export const helpLine = (name) => `Dans Claude Code, demande : "${name}, …"`;
