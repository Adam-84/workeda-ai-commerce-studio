// public/dashboard-view.js — modèle du tableau de bord (fonction pure, testée dans Node).
// Règle : une donnée absente est dite « Indisponible » ou « Inconnu », jamais remplacée par zéro.
import { signalShort, engineLabel } from './engine-view.js';

const plural = (n, one, many = `${one}s`) => `${n} ${n > 1 ? many : one}`;
const card = (id, label, value, detail = '', tone = 'ok', open = null) => ({ id, label, value, detail, tone, open });
const missing = (id, label, detail = 'Source non disponible.', open = null) => card(id, label, 'Indisponible', detail, 'unknown', open);
const when = (iso) => new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Paris' });
const DAY = 86400000;
export const DECISIONS = ['approval', 'review'];

// 404 : serveur local, sans exploitation centrale. Toute autre panne vaut `false` : indisponible, pas « local ».
export const readOperations = (get) => get('/api/operations').catch((error) => (error.status === 404 ? null : false));
const SILENT = 'Le serveur n’a pas répondu.';

export function buildDashboard({ agents, missions, notifications, memoryPending, automations, usage, integrations, engines, operations = null, localHealth, now = Date.now() } = {}) {
  const cards = [];

  if (operations === false) cards.push(missing('server', 'Serveur', SILENT));
  else if (operations) cards.push(operations.halted ? card('server', 'Serveur', 'Arrêt général actif', 'Aucune mission ni automatisation ne part.', 'warn') : card('server', 'Serveur', 'En ligne', 'Serveur central.'));
  else cards.push(localHealth ? card('server', 'Serveur', 'Local actif', 'Disponible tant que cet ordinateur reste allumé.') : missing('server', 'Serveur'));

  if (agents) {
    const enabled = agents.filter((a) => a.enabled !== false);
    cards.push(card('agents', 'Agents', plural(enabled.length, 'disponible'), `${enabled.filter((a) => a.status === 'working').length} au travail`, 'ok', 'team'));
  } else cards.push(missing('agents', 'Agents'));

  if (missions) cards.push(card('missions', 'Missions', plural(missions.filter((m) => !['done', 'cancelled'].includes(m.state)).length, 'ouverte'), '', 'ok', 'missions'));
  else cards.push(missing('missions', 'Missions'));

  if (notifications && memoryPending) {
    const n = notifications.filter((x) => DECISIONS.includes(x.type)).length + memoryPending.length;
    cards.push(card('approvals', 'Validations', `${n} à valider`, 'Délégations, résultats et souvenirs.', n ? 'warn' : 'ok', 'comm'));
  } else cards.push(missing('approvals', 'Validations'));

  if (automations) {
    const active = automations.rules.filter((r) => r.enabled).length, paused = automations.status?.paused;
    cards.push(card('automations', 'Automatisations', plural(active, 'active'), paused ? 'Calendriers suspendus.' : '', paused ? 'warn' : 'ok', 'automations'));
  } else cards.push(missing('automations', 'Automatisations'));

  const today = usage?.today;
  if (!today) cards.push(missing('costs', 'Coûts IA du jour'));
  else if (!today.runs) cards.push(card('costs', 'Coûts IA du jour', 'Aucune exécution', '', 'ok'));
  else if (!today.runsWithCost) cards.push(card('costs', 'Coûts IA du jour', 'Inconnu', `${plural(today.runs, 'exécution')} sans coût rapporté.`, 'unknown'));
  else cards.push(card('costs', 'Coûts IA du jour', `${today.costUsd.toFixed(2).replace('.', ',')} $ rapportés`, `Coût rapporté pour ${today.runsWithCost} sur ${today.runs} exécutions ; ce n’est pas une facture.`, today.runsWithCost < today.runs ? 'unknown' : 'ok'));

  const limit = usage?.quota ? ` Limite interne Archipel : ${usage.quota.remaining} exécutions restantes sur ${usage.quota.runsPerDay} aujourd’hui pour les tâches et réponses.` : '';
  const current = (engines?.signals ?? []).filter((s) => !s.stale);
  if (!current.length) cards.push(card('quotas', 'Quotas fournisseurs', 'Inconnu', `Les abonnements ne communiquent pas leur solde à Archipel.${limit}`, 'unknown'));
  else {
    // Le catalogue dit quels modèles sont réellement retenus ; un relevé bloquant peut ne viser qu'un modèle ou qu'un worker.
    const models = engines.catalog?.find((p) => p.provider === 'claude')?.models;
    const held = current.some((s) => s.blocking), near = current.some((s) => s.status === 'allowed_warning');
    const waiting = models ? models.filter((m) => m.reason) : [];
    const stopped = models ? waiting.length === models.length : held;
    const named = waiting.map((m) => engineLabel({ provider: 'claude', model: m.model }).replace('Claude ', '')).join(' et ');
    const value = stopped ? 'Claude en attente' : waiting.length ? `Claude ${named} en attente` : near ? 'Claude proche de la limite' : 'Claude autorisé';
    const partly = held && !stopped && !waiting.length ? ' Une source est retenue, d’autres restent disponibles.' : '';
    const first = current.find((s) => s.blocking) ?? current.find((s) => s.status === 'allowed_warning') ?? current[0];
    const others = current.length > 1 ? ` ${plural(current.length - 1, 'autre relevé', 'autres relevés')} dans Comms, onglet Activité.` : '';
    cards.push(card('quotas', 'Quotas fournisseurs', value, `${signalShort(first)}.${partly}${others}${limit}`, held || near || waiting.length ? 'warn' : 'ok', 'comm'));
  }

  if (integrations) {
    const all = integrations.integrations ?? integrations, tested = all.filter((i) => i.state === 'tested').length;
    cards.push(card('integrations', 'Intégrations', `${tested} sur ${all.length} ${tested > 1 ? 'testées' : 'testée'}`, 'Testée ne signifie pas à jour.', 'ok', 'integrations'));
  } else cards.push(missing('integrations', 'Intégrations', 'Source non disponible.', 'integrations'));

  if (operations === false) cards.push(missing('workers', 'Moteurs (workers)', SILENT));
  else if (operations) {
    const active = operations.workers.filter((w) => !w.revoked), ready = active.filter((w) => w.online && !w.blocked).length;
    cards.push(card('workers', 'Moteurs (workers)', `${ready} ${ready > 1 ? 'disponibles' : 'disponible'} sur ${active.length}`, ready ? 'Codex désactivé.' : 'Les missions IA restent en attente. Codex désactivé.', ready ? 'ok' : 'warn'));
  } else cards.push(localHealth ? card('workers', 'Moteurs (workers)', 'Mode local', 'Claude Code de cet ordinateur ; Codex désactivé.', 'unknown') : missing('workers', 'Moteurs (workers)'));

  const dates = [operations?.freshness?.catalog, ...(integrations?.cards ?? []).flatMap((c) => (c.snapshots ?? []).map((s) => s.fetchedAt))].filter((d) => Number.isFinite(Date.parse(d))).sort();
  const latest = dates.at(-1);
  cards.push(latest ? card('freshness', 'Dernier relevé de données', when(latest), 'Le plus récent, toutes sources confondues.', now - Date.parse(latest) > DAY ? 'warn' : 'ok', 'integrations') : missing('freshness', 'Dernier relevé de données', 'Aucun relevé daté.', 'integrations'));

  const backup = operations?.backup;
  if (!backup) cards.push(missing('backup', 'Dernière sauvegarde', operations === false ? SILENT : 'Sauvegarde automatique réservée au serveur central.'));
  else if (!backup.lastSuccessfulAt) cards.push(card('backup', 'Dernière sauvegarde', 'Aucune', backup.error ? 'La dernière tentative a échoué.' : '', 'warn'));
  else cards.push(card('backup', 'Dernière sauvegarde', when(backup.lastSuccessfulAt), backup.error ? 'La dernière tentative a échoué.' : 'Bases seules : secrets et Skills à sauvegarder à part.', backup.error || now - Date.parse(backup.lastSuccessfulAt) > 2 * DAY ? 'warn' : 'ok'));

  return cards;
}
