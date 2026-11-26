// public/alerts.js — quelles alertes signaler entre deux relevés (fonctions pures, testées dans Node).
// Les textes sont fixes : aucun titre, produit, montant ni nom n'apparaît sur un écran verrouillé.
export const ALERT_KINDS = [
  { id: 'approval', label: 'Demande de validation', body: 'Une validation est attendue.' },
  { id: 'done', label: 'Mission terminée', body: 'Une mission est terminée.' },
  { id: 'failed', label: 'Mission échouée ou bloquée', body: 'Une mission est bloquée ou en échec.' },
  { id: 'budget', label: 'Budget atteint', body: 'Un budget de mission est atteint.' },
  { id: 'automation', label: 'Automatisation interrompue', body: 'Une automatisation s’est interrompue.' },
  { id: 'worker', label: 'Worker indisponible', body: 'Un moteur n’est plus disponible.' }
];

const ids = (list, keep) => (list ?? []).filter(keep).map((x) => String(x.id));

export function snapshot({ notifications, tasks, history, operations } = {}, previous = null) {
  // Le motif de blocage suit la demande après « — » : le mot « budget » dans la demande elle-même ne compte pas.
  const budget = (n) => n.type === 'blocked' && /(^|— )Budget de la mission atteint/.test(n.detail ?? '');
  return {
    approval: ids(notifications, (n) => ['approval', 'review'].includes(n.type)),
    done: ids(tasks, (t) => t.state === 'done'),
    failed: ids(notifications, (n) => ['failed', 'expired', 'blocked'].includes(n.type) && !budget(n)),
    budget: ids(notifications, budget),
    automation: ids(history, (r) => ['blocked', 'failed', 'uncertain', 'expired'].includes(r.state)),
    // Pour les workers, on retient ceux qui répondent : l'alerte naît de leur disparition.
    // Relevé d'exploitation manqué (`false`) : on garde le dernier état connu.
    online: operations === false ? previous?.online ?? [] : ids(operations?.workers, (w) => w.online && !w.blocked && !w.revoked)
  };
}

export function newAlerts(previous, next, preferences = {}) {
  if (!previous) return [];
  return ALERT_KINDS.filter(({ id }) => preferences[id] && (id === 'worker'
    ? previous.online.some((w) => !next.online.includes(w))
    : next[id].some((x) => !previous[id].includes(x)))).map(({ id, body }) => ({ kind: id, title: 'Archipel', body }));
}
