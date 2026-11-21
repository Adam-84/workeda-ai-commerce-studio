// Integration Center : libellés et calculs purs (testables sans navigateur). Rien n'est affiché qui ne vienne du serveur.
export const dateFr = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');

// Quatre états réels + « non configuré ». Le serveur les calcule ; ici seulement le libellé et la classe de pastille.
export const STATE = {
  not_configured: { label: 'Non configuré', cls: 'soft', help: 'Aucune connexion : rien n’est lu.' },
  configured: { label: 'Configuré', cls: 'soft', help: 'Prêt à se connecter. Aucune donnée lue.' },
  authenticated: { label: 'Authentifié', cls: '', help: 'Connecté en lecture seule, pas encore testé.' },
  tested: { label: 'Testé', cls: 'accent', help: 'Connexion vérifiée par un vrai appel de test.' },
  unavailable: { label: 'Indisponible', cls: 'soft', help: 'Impossible de lire pour le moment (voir les raisons).' }
};
export const stateInfo = (s) => STATE[s] ?? { label: String(s ?? '?'), cls: 'soft', help: '' };

export const quotaLine = (q) => (q ? `Appels aujourd’hui : ${q.used} sur ${q.cap} (reste ${q.remaining}) · remise à zéro ${dateFr(q.resetsAt)}` : 'Quota inconnu.');
export const quotaRatio = (q) => (q && q.cap ? Math.min(1, q.used / q.cap) : 0);

export function lastLine(label, e) {
  if (!e?.at) return `${label} : jamais.`;
  return `${label} : ${dateFr(e.at)} — ${e.ok ? 'réussi' : `échec${e.error ? ` (${e.error})` : ''}`}`;
}
export const snapshotLine = (s) => `${{ stores: 'Boutiques', products: 'Produits liés', packages: 'Colis', shipping: 'Frais d’expédition', tracklist: 'Suivis', quota: 'Quota 17TRACK' }[s.kind] ?? s.kind} : ${dateFr(s.fetchedAt)}${s.count != null ? ` · ${s.count} élément${s.count > 1 ? 's' : ''}` : ''}`;

// Un agent peut recevoir l'accès en lecture s'il ne l'a pas déjà ; la suggestion ne donne JAMAIS d'accès (aucun accès par défaut).
export const SUGGESTED = { dsers: ['lucas', 'isabella', 'benjamin', 'alexander'], track17: ['benjamin', 'alexander'] };
export const SUGGEST_WHY = { lucas: 'rapprochement Shopify ↔ DSers', isabella: 'coûts et marges si les données suffisent', benjamin: 'indicateurs logistiques', alexander: 'synthèse' };
export function grantCandidates(card, agents) {
  const has = new Set(card.grants.map((g) => g.agent)), sug = new Set(SUGGESTED[card.id] ?? []);
  const rows = agents.filter((a) => !has.has(a.slug)).map((a) => ({ ...a, suggested: sug.has(a.slug), why: sug.has(a.slug) ? SUGGEST_WHY[a.slug] ?? '' : '' }));
  return rows.sort((x, y) => Number(y.suggested) - Number(x.suggested) || x.name.localeCompare(y.name, 'fr'));
}

// Actions proposées selon l'état réel ; la connexion exige toujours une confirmation, et le réseau réel un accord explicite du propriétaire.
export function actionsFor(card) {
  const a = [];
  if (!card.realNetworkAllowed) a.push({ id: 'blocked', label: 'Connexion réelle désactivée', disabled: true, why: 'Aucun compte n’est contacté tant que ARCHIPEL_ALLOW_REAL_NETWORK=1 n’est pas défini avec votre accord explicite.' });
  if (card.id === 'dsers' && !card.flags.authenticated) a.push({ id: 'connect', label: 'Se connecter à DSers (lecture seule)', disabled: !card.realNetworkAllowed || !card.storage.available });
  if (card.flags.authenticated || (card.id === 'track17' && card.flags.configured)) a.push({ id: 'test', label: 'Tester la connexion', disabled: !card.realNetworkAllowed });
  if (card.flags.authenticated) a.push({ id: 'sync', label: 'Actualiser les données', disabled: !card.realNetworkAllowed || card.quota.remaining <= 0 });
  if (card.flags.authenticated || card.flags.configured && card.id === 'track17') a.push({ id: 'revoke', label: 'Révoquer la connexion' });
  return a;
}
export const revokeText = (card) => (card.id === 'dsers'
  ? 'Supprime les jetons de cet ordinateur et retire tous les accès des agents. DSers n’a pas de point de révocation : retirez aussi Archipel dans votre compte DSers.'
  : 'Supprime la clé de cet ordinateur et retire tous les accès des agents. Pensez à la renouveler chez 17TRACK si elle a pu être exposée.');
