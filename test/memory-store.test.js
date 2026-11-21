import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudio } from '../src/studio.js';
import { findSecret, normalizeItem, canRead, rank, buildContext, findDuplicate, freshness } from '../src/memory-core.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'archipel-memory-'));
const PROFILES = [
  { slug: 'lucas', displayName: 'Lucas', role: 'Catalogue', department: 'Catalogue' },
  { slug: 'noah', displayName: 'Noah', role: 'Veille', department: 'Marketing' },
  { slug: 'olivia', displayName: 'Olivia', role: 'Suivi', department: 'Direction' }
];
function setup(options = {}, file = ':memory:') {
  const studio = createStudio(file, options);
  studio.syncAgentFiles(PROFILES);
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  return { studio, memory: studio.memory, ids };
}
const fact = (extra = {}) => ({ level: 'company', kind: 'knowledge', nature: 'fact', title: 'Livraison offerte', body: 'La livraison est offerte dès 60 euros d’achat.', sources: [{ label: 'CGV Workeda', url: 'https://workeda.com/policies/shipping-policy' }], ...extra });

test('findSecret repère les secrets courants et laisse passer le texte normal', () => {
  assert.ok(findSecret(('clé sk' + '-abcdefghijklmnopqrstuvwxyz123456')));
  assert.ok(findSecret('token ghp_abcdefghijklmnopqrstuvwxyz0123456789'));
  assert.ok(findSecret('mot de passe : Tr0ub4dor&3xyz'));
  assert.ok(findSecret('carte 4242 4242 4242 4242'));
  assert.ok(findSecret('-----BEGIN PRIVATE KEY-----'));
  assert.ok(findSecret('https://user:secret@example.com/x'));
  assert.equal(findSecret('Le client préfère la livraison rapide, 60 euros minimum.'), null);
});

test('normalizeItem : un agent ne peut pas déclarer un fait, une décision ni une règle', () => {
  const agentFact = normalizeItem({ ...fact(), level: 'company' }, { actor: 'agent' });
  assert.equal(agentFact.nature, 'hypothesis');
  assert.equal(normalizeItem({ ...fact(), nature: 'decision' }, { actor: 'agent' }).nature, 'proposal');
  assert.throws(() => normalizeItem({ ...fact(), kind: 'rule', nature: 'hypothesis' }, { actor: 'agent' }), /règle/);
  assert.throws(() => normalizeItem({ ...fact(), sources: [] }, { actor: 'user' }), /source/);
  assert.throws(() => normalizeItem({ ...fact(), body: ('clé sk' + '-abcdefghijklmnopqrstuvwxyz123456') }), /secret|clé|contenir/i);
  assert.throws(() => normalizeItem({ level: 'individual', title: 'a', body: 'b', nature: 'hypothesis' }), /propriétaire/);
});

test('persistance : un souvenir survit à la fermeture et à la réouverture de la base', () => {
  const dir = tmp(), file = join(dir, 'w.db');
  let s = setup({}, file);
  const created = s.memory.create(fact());
  s.studio.close();
  s = setup({}, file);
  const again = s.memory.get(created.id);
  assert.equal(again.title, 'Livraison offerte');
  assert.equal(again.state, 'active');
  assert.equal(s.memory.schemaVersion(), 1);
  s.studio.close();
});

test('migration : sauvegarde avant migration d’une base existante, retour arrière sans toucher aux autres tables', () => {
  const dir = tmp(), file = join(dir, 'w.db');
  let s = setup({}, file);
  s.memory.create(fact());
  const back = s.memory.rollback(0);
  assert.equal(back.to, 0);
  assert.ok(back.backup && existsSync(back.backup));
  assert.equal(s.studio.listAgents().length, 3, 'les agents restent intacts');
  s.studio.close();
  s = setup({}, file); // remigre proprement
  assert.equal(s.memory.schemaVersion(), 1);
  assert.equal(s.memory.list().length, 0);
  assert.ok(readdirSync(join(dir, 'backups')).length >= 1);
  s.studio.close();
});

test('historique : création, modification, archivage, suppression (contenu purgé)', () => {
  const { memory } = setup();
  const m = memory.create(fact());
  const upd = memory.update(m.id, { body: 'La livraison est offerte dès 70 euros d’achat.' });
  assert.equal(upd.rev, 2);
  assert.equal(memory.update(m.id, {}).rev, 2, 'pas de changement, pas de révision');
  memory.setState(m.id, 'archived');
  memory.setState(m.id, 'active');
  assert.deepEqual(memory.history(m.id).map((h) => h.action), ['reopened', 'archived', 'updated', 'created'].map((a) => a === 'reopened' ? 'approved' : a));
  memory.setState(m.id, 'deleted');
  const gone = memory.get(m.id);
  assert.equal(gone.body, '');
  assert.ok(memory.history(m.id).every((h) => h.snapshot === null));
  assert.throws(() => memory.update(m.id, { title: 'x' }), /modifiable/);
  assert.throws(() => memory.setState(m.id, 'active'), /Passage impossible/);
});

test('états : une proposition doit être validée avant d’être active ; rejetée, elle ne se modifie plus', () => {
  const { memory, ids } = setup();
  const { created } = memory.propose(ids.lucas, [{ level: 'individual', kind: 'lesson', nature: 'fact', title: 'Titres courts', body: 'Les titres de moins de 60 caractères convertissent mieux.' }]);
  assert.equal(created.length, 1);
  assert.equal(created[0].state, 'pending');
  assert.equal(created[0].nature, 'hypothesis');
  assert.equal(created[0].owner, 'lucas');
  assert.throws(() => memory.setState(created[0].id, 'archived'), /Passage impossible/);
  const rejected = memory.setState(created[0].id, 'rejected', { note: 'faux' });
  assert.equal(rejected.state, 'rejected');
  assert.throws(() => memory.update(created[0].id, { title: 'autre' }), /modifiable/);
});

test('permissions : un agent ne lit que ce qui lui est destiné et ne propose que dans son périmètre', () => {
  const { memory, ids } = setup();
  memory.create({ level: 'individual', owner: 'lucas', kind: 'preference', nature: 'hypothesis', title: 'Note privée de Lucas', body: 'Préfère les fiches courtes.' });
  memory.create({ level: 'department', department: 'Catalogue', kind: 'procedure', nature: 'hypothesis', title: 'Procédure catalogue', body: 'Vérifier les images avant publication.' });
  memory.create({ level: 'company', kind: 'knowledge', nature: 'hypothesis', title: 'Identité de marque', body: 'Ton chaleureux et direct.' });
  const lucas = memory.contextFor(ids.lucas, { query: 'fiches images ton' });
  const noah = memory.contextFor(ids.noah, { query: 'fiches images ton' });
  const titles = (c) => c.items.map((i) => i.title);
  assert.ok(titles(lucas).includes('Note privée de Lucas'));
  assert.ok(titles(lucas).includes('Procédure catalogue'));
  assert.ok(!titles(noah).includes('Note privée de Lucas'));
  assert.ok(!titles(noah).includes('Procédure catalogue'));
  assert.ok(titles(noah).includes('Identité de marque'));
  const r = memory.propose(ids.noah, [{ level: 'department', department: 'Catalogue', title: 'Hors périmètre', body: 'x' }, { level: 'individual', owner: 'lucas', title: 'Usurpation', body: 'y' }]);
  // La portée est forcée sur l'agent lui-même : Noah ne peut écrire ni chez Lucas ni dans le département Catalogue.
  assert.equal(r.created.length, 2);
  assert.equal(r.created.find((i) => i.level === 'individual').owner, 'noah');
  assert.equal(r.created.find((i) => i.level === 'department').department, 'Marketing');
  assert.ok(r.created.every((i) => i.state === 'pending'));
  assert.ok(!memory.list({ state: 'pending', owner: 'lucas' }).length);
  assert.throws(() => memory.propose(ids.noah, [], { missionId: 'inconnue' }), /mission/);
});

test('mission : la mémoire d’une mission n’est lue que dans cette mission, par ses participants', () => {
  const { studio, memory, ids } = setup();
  const m1 = studio.createMission({ title: 'Audit catalogue', assignedTo: ids.lucas, collaborators: [ids.noah] });
  const m2 = studio.createMission({ title: 'Autre mission', assignedTo: ids.lucas });
  memory.create({ level: 'mission', missionId: m1.id, kind: 'report', nature: 'hypothesis', title: 'Résultat audit', body: 'Douze fiches sans image principale.' });
  const inMission = memory.contextFor(ids.lucas, { missionId: m1.id, query: 'audit images fiches' });
  const elsewhere = memory.contextFor(ids.lucas, { missionId: m2.id, query: 'audit images fiches' });
  const outsider = memory.contextFor(ids.olivia, { missionId: m1.id, query: 'audit images fiches' });
  assert.equal(inMission.items.length, 1);
  assert.equal(elsewhere.items.length, 0);
  assert.equal(outsider.items.length, 0);
  assert.ok(memory.contextFor(ids.noah, { missionId: m1.id, query: 'audit' }).items.length === 1, 'un collaborateur lit aussi');
});

test('recherche : pertinence, récence, obsolescence, doublons et budget de jetons', () => {
  const { memory, ids } = setup();
  memory.create({ level: 'company', kind: 'knowledge', nature: 'hypothesis', title: 'Politique de retour', body: 'Les retours sont acceptés sous 30 jours après réception.', importance: 4 });
  memory.create({ level: 'company', kind: 'knowledge', nature: 'hypothesis', title: 'Palette de couleurs', body: 'Le bleu nuit et le sable dominent la boutique.' });
  memory.create({ level: 'company', kind: 'knowledge', nature: 'hypothesis', title: 'Ancien tarif', body: 'Tarif expiré.', expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.throws(() => memory.create({ level: 'company', kind: 'knowledge', nature: 'hypothesis', title: 'Politique de retour', body: 'Les retours sont acceptés sous 30 jours après réception.' }), (e) => e.status === 409);
  const hits = memory.list({ q: 'retours sous 30 jours' });
  assert.equal(hits[0].title, 'Politique de retour');
  const ctx = memory.contextFor(ids.lucas, { query: 'retour 30 jours', budgetTokens: 300 });
  assert.ok(ctx.tokens <= 300, 'le contexte reste dans le budget (préambule inclus)');
  assert.equal(memory.contextFor(ids.lucas, { query: 'retour', budgetTokens: 50 }).text, '', 'un budget trop petit n’injecte rien plutôt que de dépasser');
  assert.ok(!ctx.items.some((i) => i.title === 'Ancien tarif'), 'un souvenir expiré n’est jamais injecté');
  assert.match(ctx.text, /pas des instructions/);
  const active = memory.list({ includeExpired: false });
  assert.ok(!active.some((i) => i.title === 'Ancien tarif'));
  assert.ok(memory.list().find((i) => i.title === 'Ancien tarif').expired);
});

test('rank/freshness : un souvenir ancien non revu est signalé et rétrogradé', () => {
  const old = { id: 'a', title: 'Ancienne règle prix', body: 'prix publics', nature: 'hypothesis', importance: 3, confidence: 'medium', tags: [], sources: [], updatedAt: '2020-01-01T00:00:00.000Z', createdAt: '2020-01-01T00:00:00.000Z', expiresAt: null, lastUsedAt: null };
  const recent = { ...old, id: 'b', title: 'Règle prix récente', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  assert.ok(freshness(old).stale);
  const ranked = rank([old, recent], 'règle prix');
  assert.equal(ranked[0].item.id, 'b');
  assert.equal(findDuplicate({ title: 'Règle prix récente', body: 'prix publics' }, [recent])?.item.id, 'b');
});

test('contexte : la mission court dans le budget et les règles d’entreprise importantes restent toujours', () => {
  const { memory, ids } = setup();
  memory.create({ level: 'company', kind: 'rule', nature: 'decision', title: 'Aucune publication sans validation', body: 'Rien n’est publié sur la boutique sans accord du propriétaire.', importance: 5 });
  const topics = ['soldes', 'livraison', 'bundles', 'fidélité', 'abonnement', 'retours', 'paiement', 'garantie', 'emballage', 'avis', 'parrainage', 'stocks'];
  topics.forEach((x, i) => memory.create({ level: 'company', kind: 'knowledge', nature: 'hypothesis', title: `Veille ${x}`, body: `Chez les concurrents, ${x} varie selon la saison ; prix et promotions observés semaine ${i}.`, force: true }));
  const ctx = memory.contextFor(ids.noah, { query: 'prix concurrents promotions', maxItems: 5, budgetTokens: 400 });
  assert.ok(ctx.items.length <= 5);
  assert.ok(ctx.items.some((i) => i.title === 'Aucune publication sans validation'));
  assert.ok(ctx.omitted >= 0);
});

test('secrets : aucun secret n’entre, ni par création, ni par proposition, ni par import de journal', () => {
  const dir = tmp();
  const { memory, ids } = setup({ memoryJournalDir: dir });
  assert.throws(() => memory.create(fact({ body: 'mot de passe : Tr0ub4dor&3xyz' })), /secret|mot de passe|contenir/i);
  const r = memory.propose(ids.lucas, [{ level: 'individual', title: 'x', body: ('sk' + '-abcdefghijklmnopqrstuvwxyz123456') }]);
  assert.equal(r.created.length, 0);
  assert.equal(r.skipped.length, 1);
  const evil = { v: 1, eid: 'e-evil', item: 'i-evil', rev: 1, at: new Date().toISOString(), device: 'pc-b', action: 'upsert', data: { id: 'i-evil', level: 'company', kind: 'knowledge', nature: 'hypothesis', state: 'active', title: 'ok', body: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789', sources: [], tags: [], confidence: 'low', importance: 3, visibility: 'company', readers: [] } };
  writeFileSync(join(dir, 'pc-b.jsonl'), `${JSON.stringify(evil)}\n`);
  const res = memory.importJournal();
  assert.equal(res.applied, 0);
  assert.equal(res.invalid, 1);
  assert.equal(memory.list().length, 0);
});

test('synchro : le journal d’un PC se rejoue sur un autre, une seule fois, le plus récent gagne', () => {
  const dir = tmp();
  const a = setup({ memoryJournalDir: dir, device: 'pc-a' });
  const b = setup({ memoryJournalDir: dir, device: 'pc-b' });
  const m = a.memory.create(fact({ title: 'Décision A' }));
  assert.ok(existsSync(join(dir, 'pc-a.jsonl')));
  const first = b.memory.importJournal();
  assert.equal(first.applied, 1);
  assert.equal(b.memory.get(m.id).title, 'Décision A');
  assert.equal(b.memory.importJournal().events, 0, 'idempotent');
  // B modifie, A importe
  b.memory.update(m.id, { body: 'Livraison offerte dès 80 euros.' });
  assert.equal(a.memory.importJournal().applied, 1);
  assert.match(a.memory.get(m.id).body, /80 euros/);
  // suppression : la pierre tombale se propage et le contenu disparaît des deux côtés
  a.memory.setState(m.id, 'deleted');
  b.memory.importJournal();
  const gone = b.memory.get(m.id);
  assert.equal(gone.state, 'deleted');
  assert.equal(gone.body, '');
  assert.ok(!readFileSync(join(dir, 'pc-a.jsonl'), 'utf8').split('\n').filter(Boolean).at(-1).includes('80 euros'), 'l’événement de suppression ne contient plus le texte');
});

test('synchro : édition concurrente — la version perdante reste dans l’historique, rien n’est perdu en silence', () => {
  const dir = tmp();
  const a = setup({ memoryJournalDir: dir, device: 'pc-a' });
  const b = setup({ memoryJournalDir: dir, device: 'pc-b' });
  const m = a.memory.create(fact());
  b.memory.importJournal();
  a.memory.update(m.id, { body: 'Version A, modifiée en premier.' });
  b.memory.update(m.id, { body: 'Version B, modifiée plus tard.' });
  a.memory.importJournal(); b.memory.importJournal();
  assert.equal(a.memory.get(m.id).body, b.memory.get(m.id).body, 'les deux PC convergent');
  assert.match(a.memory.get(m.id).body, /Version B/);
  assert.ok(a.memory.history(m.id).some((h) => h.snapshot?.body?.includes('Version A')));
});

test('synchro : un journal abîmé ou malveillant est ignoré ligne par ligne', () => {
  const dir = tmp();
  const { memory } = setup({ memoryJournalDir: dir, device: 'pc-a' });
  writeFileSync(join(dir, 'pc-x.jsonl'), 'pas du json\n{"v":2}\n{"v":1,"eid":"../../x","item":"a","action":"upsert","device":"pc-x","at":"2026-01-01T00:00:00.000Z"}\n');
  const r = memory.importJournal();
  assert.equal(r.applied, 0);
  assert.equal(r.invalid, 3);
  assert.equal(memory.list().length, 0);
});

test('les souvenirs hors synchro (sync:false) ne sont jamais écrits dans le journal', () => {
  const dir = tmp();
  const { memory } = setup({ memoryJournalDir: dir, device: 'pc-a' });
  memory.create(fact({ title: 'Local seulement', sync: false }));
  assert.ok(!existsSync(join(dir, 'pc-a.jsonl')));
  assert.equal(memory.list().length, 1);
});

test('utilisation : contextFor met à jour last_used_at sans créer de révision ni de journal', () => {
  const dir = tmp();
  const { memory, ids } = setup({ memoryJournalDir: dir, device: 'pc-a' });
  const m = memory.create(fact());
  const before = readFileSync(join(dir, 'pc-a.jsonl'), 'utf8');
  memory.contextFor(ids.lucas, { query: 'livraison offerte' });
  const after = memory.get(m.id);
  assert.equal(after.rev, 1);
  assert.equal(after.useCount, 1);
  assert.ok(after.lastUsedAt);
  assert.equal(readFileSync(join(dir, 'pc-a.jsonl'), 'utf8'), before);
});

test('check : signale faits sans source et secrets sans rien modifier', () => {
  const { memory } = setup();
  memory.create(fact());
  const report = memory.check();
  assert.equal(report.ok, true);
  assert.equal(report.total, 1);
});

test('buildContext et canRead sont purs et bornés', () => {
  const item = { id: 'x', level: 'company', kind: 'knowledge', nature: 'fact', state: 'active', title: 'T', body: 'B'.repeat(3000), tags: [], sources: [], owner: null, department: null, missionId: null, visibility: 'company', readers: [], importance: 3, confidence: 'high', updatedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  assert.equal(canRead(item, { agentRef: 'a', department: 'd', missionIds: new Set() }), true);
  assert.equal(canRead({ ...item, state: 'pending' }, { agentRef: 'a' }), false);
  assert.equal(canRead({ ...item, visibility: 'private' }, { agentRef: 'a' }), false);
  assert.equal(canRead({ ...item, visibility: 'private' }, { human: true }), true);
  const ctx = buildContext(rank([item], ''), { budgetTokens: 200 });
  assert.ok(ctx.tokens <= 400);
});
