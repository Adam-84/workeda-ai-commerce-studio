// Affichage de la communication (helpers purs) : libellés, actions permises, arbre de délégations, preuves affichées.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  taskActions, taskTree, groupThreads, filterThreads, threadTitle, dueLabel, sourceLine, verificationLine, costLine, activeText, runLine, side,
  deliveryLabel, taskStateLabel, messageKindLabel, isOpen
} from '../public/comm-view.js';

const names = { a: 'Alexander', s: 'Sophia', n: 'Noah' };
const nameOf = (id) => names[id] ?? 'Agent';

test('actions offertes selon l’état réel de la tâche', () => {
  const keys = (state) => taskActions({ state }).map(([k]) => k);
  assert.deepEqual(keys('pending_approval'), ['approve', 'cancel']);
  assert.deepEqual(keys('review'), ['verify', 'retry', 'cancel']);
  assert.deepEqual(keys('failed'), ['retry', 'cancel']);
  assert.deepEqual(keys('running'), [], 'une tâche en cours ne s’interrompt pas depuis l’interface');
  assert.deepEqual(keys('done'), []); assert.deepEqual(keys('cancelled'), []);
  assert.equal(isOpen({ state: 'running' }), true); assert.equal(isOpen({ state: 'done' }), false);
});

test('libellés : statuts de message, états de tâche, types de message', () => {
  assert.deepEqual(['sent', 'received', 'processed', 'error'].map(deliveryLabel), ['Envoyé', 'Reçu', 'Traité', 'Erreur']);
  assert.equal(taskStateLabel('review'), 'À vérifier'); assert.equal(taskStateLabel('inconnu'), 'inconnu');
  assert.equal(messageKindLabel('blocker'), 'Blocage');
  assert.equal(side({ senderType: 'user' }), 'own'); assert.equal(side({ senderType: 'agent' }), 'agent'); assert.equal(side({ senderType: 'system' }), 'system');
});

test('arbre de délégations : racine puis sous-tâches, ordre de création', () => {
  const t = (id, parentTaskId, createdAt) => ({ id, parentTaskId, createdAt });
  const rows = taskTree([t('c2', 'r', '2026-11-21T10:03:00Z'), t('r', null, '2026-11-21T10:00:00Z'), t('c1', 'r', '2026-11-21T10:01:00Z'), t('g', 'c1', '2026-11-21T10:02:00Z'), t('r2', null, '2026-11-21T11:00:00Z'), t('orph', 'absent', '2026-11-21T09:00:00Z')]);
  assert.deepEqual(rows.map((x) => `${x.level}:${x.task.id}`), ['0:r2', '0:r', '1:c1', '2:g', '1:c2', '0:orph']);
});

test('fils : groupés par type, titre des fils privés = les agents, filtre insensible aux accents', () => {
  const threads = [
    { id: '1', kind: 'direct', title: 'x', members: ['s', 'n'], lastMessage: { body: 'Prix relevés' } },
    { id: '2', kind: 'mission', title: 'Étude marché', members: ['a'], lastMessage: null },
    { id: '3', kind: 'group', title: 'Trio', members: ['a', 's', 'n'], lastMessage: null }
  ];
  assert.deepEqual(groupThreads(threads).map((g) => g.kind), ['direct', 'mission', 'group']);
  assert.equal(threadTitle(threads[0], nameOf), 'Sophia ↔ Noah'); assert.equal(threadTitle(threads[1], nameOf), 'Étude marché');
  assert.deepEqual(filterThreads(threads, { query: 'etude' }, nameOf).map((t) => t.id), ['2']);
  assert.deepEqual(filterThreads(threads, { query: 'sophia' }, nameOf).map((t) => t.id), ['1', '3']);
  assert.deepEqual(filterThreads(threads, { agentId: 'n' }, nameOf).map((t) => t.id), ['1', '3']);
});

test('preuves : sources confirmées ou non, vérification, coûts, exécutions', () => {
  assert.match(sourceLine({ label: 'Étude', url: 'https://a.fr/x', date: '2026-11-20', checked: true }), /✔ consultée/);
  assert.match(sourceLine({ label: 'Inventée', url: 'https://b.fr', checked: false }), /✖ non confirmée/);
  assert.doesNotMatch(sourceLine({ label: 'Résultat de Sophia', url: null, resultId: 'r1', checked: true }), /✔|✖/, 'une source dérivée n’est pas une consultation');
  assert.match(verificationLine({ verified: true, level: 'observed', verification: '2 source(s) confirmée(s)' }), /^Vérifié · Sources confirmées/);
  assert.match(verificationLine({ verified: false, level: 'none', verification: 'Aucune source' }), /^Non vérifié/);
  const usage = { today: { runs: 3, costUsd: 0.42 }, quota: { remaining: 57, runsPerDay: 60 }, total: { runs: 9 } };
  assert.match(costLine(usage), /3 exécutions aujourd’hui \(reste 57 sur 60\) · 0\.42 \$/);
  assert.match(costLine({ ...usage, today: { runs: 1, costUsd: 0 } }), /coût non rapporté/);
  assert.equal(activeText([], nameOf), 'Aucun agent au travail en ce moment');
  assert.equal(activeText([{ agentId: 's' }, { agentId: 'n' }], nameOf), 'Sophia, Noah travaillent en ce moment');
  assert.match(runLine({ agentId: 's', kind: 'task', taskTitle: 'Tendances', state: 'done', durationMs: 42_000, web: true }, nameOf), /Sophia · tâche « Tendances » · terminée · 42 s · web en lecture seule/);
  assert.match(runLine({ agentId: 'n', kind: 'reply', state: 'error', error: 'panne' }, nameOf), /réponse dans un fil · en erreur — panne/);
});

test('échéances lisibles', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');
  assert.equal(dueLabel({ dueAt: '2026-11-21T09:00:00Z', state: 'queued' }, now), 'échéance dépassée');
  assert.equal(dueLabel({ dueAt: '2026-11-21T15:00:00Z', state: 'queued' }, now), 'échéance dans 5 h');
  assert.equal(dueLabel({ dueAt: '2026-11-25T10:00:00Z', state: 'queued' }, now), 'échéance dans 4 j');
  assert.equal(dueLabel({ dueAt: '2026-11-21T09:00:00Z', state: 'done' }, now), '');
});

test('compteur et activité : chaque bouton qui ouvre les messages les affiche, mobile compris', async () => {
  const { paintCommButtons } = await import('../public/comm-view.js');
  const button = () => { const classes = new Set(); return { textContent: '', title: '', classes, classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } }; };
  const top = button(), bottom = button();
  paintCommButtons([[top, 'Comms'], [bottom, 'Messages'], [null, 'Absent']], { notifications: 3, active: [{}] });
  assert.equal(top.textContent, 'Comms · 3'); assert.equal(bottom.textContent, 'Messages · 3');
  assert.ok(bottom.classes.has('busy')); assert.match(bottom.title, /1 agent au travail/);
  paintCommButtons([[bottom, 'Messages']], { notifications: 0, active: [] });
  assert.equal(bottom.textContent, 'Messages'); assert.equal(bottom.classes.size, 0);
  const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), 'utf8');
  assert.match(read('app.js'), /paintCommButtons\(\[\[\$\('#comm-btn'\), 'Comms'\], \[\$\('#mobile-nav \[data-nav=comm\]'\), 'Messages'\]\], act\)/);
  assert.match(read('style.css'), /#mobile-nav button\.busy::after/);
});
