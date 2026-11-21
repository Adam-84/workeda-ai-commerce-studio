// src/integrations.js — service de l'Integration Center : cartes d'état (configuré / authentifié / testé / indisponible), tests, relevés,
// accès en lecture par agent (AUCUN par défaut), révocation, et bloc de données donné aux agents (sans données personnelles).
// Le réseau réel est désactivé tant que ARCHIPEL_ALLOW_REAL_NETWORK=1 n'est pas défini avec l'accord explicite du propriétaire.
import { createIntegrationStore } from './studio-integrations.js';
import { createDsersConnector } from './dsers-connector.js';
import { createTrack17Connector, TRACK17_DEFAULT_CAP } from './track17-connector.js';
import { networkGate, realNetworkAllowed, IntegrationError } from './mcp-client.js';
import { INTEGRATION_IDS, REGISTRY, DEFAULT_DAILY_CAP, SNAPSHOT_STALE_MS, integrationPrompt, analyzeLogistics, containsPii } from './integrations-core.js';

const bad = (m, status = 400) => Object.assign(new Error(m), { status });
export const STATE_LABELS = { not_configured: 'Non configuré', configured: 'Configuré', authenticated: 'Authentifié', tested: 'Testé', unavailable: 'Indisponible' };

export function createIntegrationService({ db, secrets, shop = null, env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), redirectUri = 'http://127.0.0.1:4318/api/integrations/dsers/callback', sleep }) {
  const iso = () => new Date(now()).toISOString();
  const envCap = Number(env.ARCHIPEL_DSERS_DAILY_CAP);
  const store = createIntegrationStore(db, { clock: iso, defaultCaps: { dsers: Number.isInteger(envCap) && envCap >= 1 ? envCap : DEFAULT_DAILY_CAP, track17: TRACK17_DEFAULT_CAP } });
  const gate = networkGate({ env, fetchImpl });
  const dsers = createDsersConnector({ store, secrets, fetchImpl: gate, now, redirectUri });
  const track17 = createTrack17Connector({ store, secrets, fetchImpl: gate, now, ...(sleep ? { sleep } : {}) });
  const connectors = { dsers, track17 };
  const conn = (id) => { if (!connectors[id]) throw bad('Intégration inconnue.', 404); return connectors[id]; };
  const agentExists = (slug) => Boolean(db.prepare('SELECT 1 AS ok FROM agent_files f JOIN agents a ON a.id = f.agent_id WHERE f.slug = ? AND a.enabled = 1').get(slug));

  // --- statut : quatre états réels, jamais déduits d'un simple « détecté » ---
  function derive(id) {
    const s = store.state(id), storage = secrets.info(), reasons = [];
    const configured = id === 'dsers' ? storage.available : storage.available && secrets.has('track17.key');
    if (!storage.available) reasons.push('Stockage sécurisé indisponible (DPAPI sous Windows, ou ARCHIPEL_SECRET_KEY).');
    if (id === 'track17' && storage.available && !secrets.has('track17.key')) reasons.push('Aucune clé 17TRACK fournie : le connecteur reste inactif (aucun compte créé, aucun suivi enregistré).');
    if (id === 'dsers' && storage.available && !s.authenticated) reasons.push('Connexion DSers (OAuth, lecture seule) non faite.');
    if (s.revokedAt && !s.authenticated) reasons.push('Connexion révoquée sur cet ordinateur.');
    if (s.lastTestOk === false) reasons.push(`Dernier test échoué : ${s.lastTestError ?? 'erreur inconnue'}`);
    let stateKey = 'not_configured';
    if (configured) stateKey = 'configured';
    if (s.authenticated) stateKey = 'authenticated';
    if (s.authenticated && s.lastTestOk === true) stateKey = 'tested';
    if (!storage.available || s.lastTestOk === false) stateKey = 'unavailable';
    return { state: stateKey, stateLabel: STATE_LABELS[stateKey], flags: { configured, authenticated: s.authenticated, tested: s.lastTestOk === true, unavailable: stateKey === 'unavailable' }, reasons };
  }
  function card(id) {
    const def = REGISTRY[id], s = store.state(id), d = derive(id);
    const snaps = ['stores', 'products', 'packages', 'shipping', 'tracklist', 'quota'].map((k) => store.latest(id, k)).filter(Boolean).map((x) => ({ kind: x.kind, fetchedAt: x.fetchedAt, hash: x.hash, note: x.note, count: x.payload?.products?.length ?? x.payload?.packages?.length ?? x.payload?.stores?.length ?? x.payload?.quotes?.length ?? null }));
    return { id, label: def.label, kind: def.kind, host: def.host, auth: def.auth, plan: def.plan, quotaNote: def.quotaNote, ...d, readOnly: true, realNetworkAllowed: realNetworkAllowed(env),
      permissions: { requestedScopes: def.readScopes, grantedScopes: s.scopes, allowedTools: def.allowedTools, deniedToolsCount: def.deniedTools.length, deniedTools: def.deniedTools, note: 'Lecture seule : tout outil d’écriture, de commande, de paiement, de publication ou de suppression est refusé côté serveur Archipel (liste blanche, refus par défaut).' },
      quota: store.quota(id), lastTest: { at: s.lastTestAt, ok: s.lastTestOk, error: s.lastTestError, detail: s.lastTestDetail }, lastSync: { at: s.lastSyncAt, ok: s.lastSyncOk, error: s.lastSyncError }, snapshots: snaps,
      grants: store.grantsOf(id), recentErrors: store.recentErrors(id), settings: { dailyCap: store.dailyCap(id), shipCountry: s.settings.shipCountry ?? 'FR', blockedUntil: s.settings.blockedUntil ?? null }, storage: secrets.info() };
  }
  const cards = () => INTEGRATION_IDS.map(card);

  const guardReal = () => { if (!realNetworkAllowed(env)) throw new IntegrationError('real_network_disabled', `Connexion réelle désactivée : aucun compte n'est contacté tant que ARCHIPEL_ALLOW_REAL_NETWORK=1 n'est pas défini avec votre accord explicite.`); };
  return {
    store, dsers, track17, cards, card,
    beginAuth: async (id) => { if (id !== 'dsers') throw bad('Cette intégration n’utilise pas OAuth.'); return dsers.beginAuth(); },
    completeAuth: (params) => dsers.completeAuth(params),
    setKey: (id, key) => { if (id !== 'track17') throw bad('Cette intégration n’utilise pas de clé.'); return track17.setKey(key); },
    test: (id) => conn(id).test(),
    sync: (id, opts) => conn(id).sync(opts),
    revoke: (id, opts) => conn(id).revoke(opts),
    setDailyCap: (id, n) => { conn(id); return store.setDailyCap(id, n); },
    setSettings: (id, { shipCountry }) => { conn(id); if (shipCountry !== undefined) { if (!/^[A-Z]{2}$/.test(String(shipCountry))) throw bad('Code pays à 2 lettres attendu.'); store.patch(id, { settings: { ...store.state(id).settings, shipCountry } }); } return card(id); },
    grant: (id, slug) => { conn(id); if (!agentExists(slug)) throw bad('Agent inconnu, désactivé ou sans fiche.', 404); return store.grant(id, slug, 'read'); },
    revokeGrant: (id, slug) => { conn(id); return store.revokeGrant(id, slug); },
    realNetworkAllowed: () => realNetworkAllowed(env), guardReal,

    // Données pour un agent : uniquement ce qui lui est ACCORDÉ, relevés déjà en cache (aucun appel réseau ici : le quota n'est jamais consommé par une tâche).
    promptFor({ agentSlug, integrations = [] }) {
      const wanted = [...new Set(integrations)].filter((i) => INTEGRATION_IDS.includes(i)), notes = [], denied = [], used = [];
      for (const id of wanted) { if (store.hasGrant(id, agentSlug)) used.push(id); else { denied.push(id); notes.push(`Accès « ${REGISTRY[id].label} » NON accordé à ${agentSlug} par le propriétaire : aucune donnée fournie. N'en invente aucune.`); } }
      const shopProducts = shop?.latest?.()?.products ?? [];
      const d = used.includes('dsers') ? dsers.data(shopProducts) : null, t = used.includes('track17') ? track17.data() : null;
      for (const [label, x] of [['DSers', d], ['17TRACK', t]]) if (x && Date.now() - Date.parse(x.fetchedAt) > SNAPSHOT_STALE_MS) notes.push(`${label} : relevé ANCIEN (${x.fetchedAt}) ; ne présente pas ces données comme actuelles.`);
      if (used.includes('dsers') && !shopProducts.length) notes.push('Catalogue Shopify non relevé : la correspondance avec DSers n\'a pas pu être calculée.');
      let track = t;
      if (t && d?.packages?.length) { const seen = new Set(t.packages.map((p) => p.trackingKey)); track = { ...t, logistics: analyzeLogistics([...t.packages, ...d.packages.filter((p) => !p.trackingKey || !seen.has(p.trackingKey))], { now: now() }) }; }
      const out = integrationPrompt({ dsers: d, track17: track, notes });
      if (containsPii(out.text)) return { text: '', provided: [], denied, used: [], blocked: 'pii', note: 'Donnée personnelle détectée : bloc non transmis.' };
      return { ...out, denied, used: used.filter((i) => (i === 'dsers' ? d : t)) };
    },
    status: () => ({ realNetworkAllowed: realNetworkAllowed(env), storage: secrets.info(), integrations: INTEGRATION_IDS.map((id) => ({ id, state: derive(id).state })) })
  };
}
