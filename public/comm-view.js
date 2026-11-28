// public/comm-view.js — libellés et logique d'affichage de la communication entre agents (pur, sans DOM : testé avec node --test).
export const THREAD_KINDS = [['direct', 'Privés'], ['department', 'Départements'], ['mission', 'Missions'], ['group', 'Groupes']];
export const threadKindLabel = (k) => THREAD_KINDS.find(([v]) => v === k)?.[1] ?? k;
export const MESSAGE_KINDS = { message: 'Message', delegation: 'Délégation', result: 'Résultat', help: 'Demande d’aide', blocker: 'Blocage', proposal: 'Proposition', decision: 'Décision', system: 'Studio' };
export const messageKindLabel = (k) => MESSAGE_KINDS[k] ?? k;
export const DELIVERY = { sent: 'Envoyé', received: 'Reçu', processed: 'Traité', error: 'Erreur' };
export const deliveryLabel = (s) => DELIVERY[s] ?? s;
export const TASK_STATES = { pending_approval: 'À valider', queued: 'En file', running: 'En cours', review: 'À vérifier', done: 'Terminée', failed: 'Échec', blocked: 'Bloquée', cancelled: 'Annulée', expired: 'Expirée' };
export const taskStateLabel = (s) => TASK_STATES[s] ?? s;
export const NOTIFICATION = { approval: 'À valider', review: 'À vérifier', blocked: 'Bloquée', failed: 'Échec', expired: 'Expirée', message: 'Message' };
export const LEVEL_LABEL = { provided: 'Relevé Shopify daté fourni par le Studio (non consulté par l’agent)', observed: 'Sources confirmées par consultation réelle', derived: 'Dérivé de résultats vérifiés', run: 'Exécution réelle, sans source exigée', manual: 'Validé par le propriétaire', none: 'Non vérifié' };
export const levelLabel = (l) => LEVEL_LABEL[l] ?? l;

const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// Actions offertes au propriétaire selon l'état (le serveur revérifie chaque transition).
export function taskActions(task, localDevice = null) {
  const out = [];
  if (localDevice && task.device && task.device !== localDevice && ['queued', 'pending_approval', 'blocked'].includes(task.state)) out.push(['adopt', 'Exécuter ici']);
  if (task.state === 'pending_approval') out.push(['approve', 'Approuver']);
  if (task.state === 'review') out.push(['verify', 'Valider le résultat']);
  if (['failed', 'blocked', 'expired', 'review'].includes(task.state)) out.push(['retry', 'Relancer']);
  if (['pending_approval', 'queued', 'blocked', 'expired', 'failed', 'review'].includes(task.state)) out.push(['cancel', 'Annuler']);
  return out;
}
export const isOpen = (task) => ['pending_approval', 'queued', 'running', 'review', 'blocked'].includes(task.state);

// Titre d'un fil : fil privé = noms des agents ; sinon le titre enregistré.
export function threadTitle(thread, nameOf) {
  if (thread.kind === 'direct') return thread.members.map(nameOf).join(' ↔ ') || thread.title;
  return thread.title;
}
export function groupThreads(threads) {
  return THREAD_KINDS.map(([kind, label]) => ({ kind, label, threads: threads.filter((t) => t.kind === kind) })).filter((g) => g.threads.length);
}
export const filterThreads = (threads, { query = '', agentId = '' } = {}, nameOf = () => '') => {
  const q = fold(query).trim();
  return threads.filter((t) => (!agentId || t.members.includes(agentId)) && (!q || fold(`${t.title} ${t.members.map(nameOf).join(' ')} ${t.lastMessage?.body ?? ''}`).includes(q)));
};

// Tâches rangées en arbre : racine, puis ses sous-tâches indentées (profondeur réelle de la délégation).
export function taskTree(tasks) {
  const byParent = new Map();
  for (const t of tasks) byParent.set(t.parentTaskId ?? null, [...(byParent.get(t.parentTaskId ?? null) ?? []), t]);
  const ids = new Set(tasks.map((t) => t.id));
  const roots = tasks.filter((t) => !t.parentTaskId || !ids.has(t.parentTaskId)).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const out = [];
  const walk = (t, level) => { out.push({ task: t, level }); for (const c of (byParent.get(t.id) ?? []).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))) walk(c, level + 1); };
  for (const r of roots) walk(r, 0);
  return out;
}

export const dateFr = (iso) => (iso ? new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '');
export function dueLabel(task, now = Date.now()) {
  if (!task.dueAt || ['done', 'cancelled'].includes(task.state)) return '';
  const left = Date.parse(task.dueAt) - now;
  if (left <= 0) return 'échéance dépassée';
  const h = Math.round(left / 3_600_000);
  return h >= 48 ? `échéance dans ${Math.round(h / 24)} j` : h >= 1 ? `échéance dans ${h} h` : 'échéance dans moins d’une heure';
}
export const attemptsLabel = (t) => (t.attempts ? `essai ${t.attempts}/${t.maxAttempts}` : '');

export function sourceLine(s) {
  const mark = s.resultId ? '' : s.provided ? ' ✔ relevé fourni par le Studio' : s.checked ? ' ✔ consultée' : s.url ? ' ✖ non confirmée' : '';
  return `${s.label || s.url}${s.url && s.label ? ` — ${s.url}` : ''}${s.date ? ` (${s.date})` : ''}${mark}`;
}
export const verificationLine = (r) => (r ? `${r.verified ? 'Vérifié' : 'Non vérifié'} · ${levelLabel(r.level)} — ${r.verification}` : 'Aucun résultat.');

const dollars = (v) => `${v.toFixed(2).replace('.', ',')} $`;
const partial = (n, runs) => (n < runs ? ` (${n} sur ${runs} exécutions)` : '');
// Coût d'un groupe d'exécutions : inconnu et partiel sont dits, jamais remplacés par zéro.
export function costText(s) {
  if (!s?.runs) return 'aucune exécution';
  if (!s.runsWithCost || s.costUsd == null) return 'coût inconnu';
  return `${dollars(s.costUsd)} rapportés${partial(s.runsWithCost, s.runs)}`;
}
export const tokensText = (s) => (!s?.runsWithTokens || s.inputTokens == null || s.outputTokens == null ? 'jetons inconnus' : `${s.inputTokens + s.outputTokens} jetons rapportés${partial(s.runsWithTokens, s.runs)}`);
export const costLine = (u) => `${u.today.runs} exécution${u.today.runs > 1 ? 's' : ''} aujourd’hui (reste ${u.quota.remaining} sur ${u.quota.runsPerDay} pour les tâches et réponses) · ${costText(u.today)} · ${u.total.runs} au total`;
export const engineLine = (e) => `${e.provider ?? 'fournisseur inconnu'} · ${e.model ?? 'modèle inconnu'} — aujourd’hui : ${e.today.runs ? `${e.today.runs} exécution(s), ${costText(e.today)}, ${tokensText(e.today)}` : 'aucune exécution'} · au total : ${e.total.runs} exécution(s), ${costText(e.total)}`;
// Compteur et activité Comms, sur chaque bouton qui ouvre les messages (barre du haut et barre mobile).
export function paintCommButtons(buttons, { notifications = 0, active = [] } = {}) {
  const title = active.length ? `${active.length} agent${active.length > 1 ? 's' : ''} au travail en ce moment` : 'Communication entre agents';
  for (const [button, label, separator = ' · '] of buttons) {
    if (!button) continue;
    button.textContent = notifications ? `${label}${separator}${notifications}` : label;
    button.classList.toggle('busy', active.length > 0);
    button.title = title;
  }
}

export const activeText = (active, nameOf) => (active.length ? `${active.map((a) => nameOf(a.agentId)).join(', ')} ${active.length > 1 ? 'travaillent' : 'travaille'} en ce moment` : 'Aucun agent au travail en ce moment');

const RUN_KINDS = { reply: 'réponse dans un fil', chat: 'discussion directe', team: 'fil d’équipe', plan: 'proposition de plan', memory: 'proposition de souvenirs' };
// Une exécution réelle, en une ligne.
export function runLine(r, nameOf) {
  const state = { running: 'en cours', done: 'terminée', error: 'en erreur', refused: 'refusée par le fournisseur (limite)' }[r.state] ?? r.state;
  const dur = r.durationMs != null ? ` · ${Math.round(r.durationMs / 1000)} s` : '';
  const what = r.kind === 'task' ? `tâche « ${r.taskTitle ?? '?'} »` : RUN_KINDS[r.kind] ?? r.kind;
  const model = !r.model ? '' : r.modelStatus === 'mismatch' ? ` · ⚠ ${r.observedModels.join(', ')} constaté au lieu de ${r.model}` : ` · ${r.model}${r.modelStatus === 'unknown' && r.state === 'done' ? ' (modèle constaté inconnu)' : ''}`;
  return `${nameOf(r.agentId)} · ${what} · ${state}${dur}${r.web ? ' · web en lecture seule' : ''}${model}${r.error ? ` — ${r.error}` : ''}`;
}

// Le message est-il d'un agent ? (jamais du propriétaire) ; système = Studio.
export const side = (m) => (m.senderType === 'user' ? 'own' : m.senderType === 'system' ? 'system' : 'agent');
export const statusChipClass = (s) => `comm-${s}`;
export const unreadCount = (notifications) => notifications.length;
