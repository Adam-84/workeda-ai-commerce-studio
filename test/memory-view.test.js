import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterMemory, tagsOf, departmentsOf, parseTags, parseSources, sourcesText, sourceLine, buildPayload, stateActions, freshnessLabel,
  scopeLabel, statsLine, contextSummary, actorLabel, actionLabel, natureLabel, levelLabel, importanceLabel
} from '../public/memory-view.js';

const item = (o = {}) => ({ id: 'm1', level: 'company', kind: 'rule', nature: 'decision', state: 'active', title: 'Ton de marque', body: 'Tutoiement partout', tags: ['ton'], owner: null, department: null, source: null, ...o });

test('filterMemory combine recherche sans accents, niveau, nature, état, agent, département et étiquette', () => {
  const items = [
    item(),
    item({ id: 'm2', level: 'individual', owner: 'lucas', nature: 'hypothesis', state: 'pending', title: 'Élément de catalogue', body: 'Titres courts', tags: ['seo', 'catalogue'] }),
    item({ id: 'm3', level: 'department', department: 'Catalogue', kind: 'lesson', nature: 'fact', title: 'Images', body: 'Fond blanc', tags: ['images'] })
  ];
  const ids = (f) => filterMemory(items, f).map((i) => i.id);
  assert.deepEqual(ids({}), ['m1', 'm2', 'm3']);
  assert.deepEqual(ids({ query: 'element' }), ['m2'], 'la recherche ignore accents et casse');
  assert.deepEqual(ids({ query: 'TUTOIEMENT' }), ['m1']);
  assert.deepEqual(ids({ level: 'department' }), ['m3']);
  assert.deepEqual(ids({ nature: 'hypothesis' }), ['m2']);
  assert.deepEqual(ids({ state: 'pending' }), ['m2']);
  assert.deepEqual(ids({ owner: 'lucas' }), ['m2']);
  assert.deepEqual(ids({ department: 'Catalogue' }), ['m3']);
  assert.deepEqual(ids({ tag: 'SEO' }), ['m2']);
  assert.deepEqual(ids({ kind: 'lesson', nature: 'fact' }), ['m3']);
  assert.deepEqual(ids({ level: 'company', nature: 'fact' }), [], 'les filtres se cumulent');
});

test('étiquettes et départements : listes uniques et triées', () => {
  const items = [item({ tags: ['b', 'a'] }), item({ tags: ['a', 'é'], department: 'Vente' }), item({ tags: [], department: 'Catalogue' })];
  assert.deepEqual(tagsOf(items), ['a', 'b', 'é']);
  assert.deepEqual(departmentsOf(items), ['Catalogue', 'Vente']);
});

test('parseTags : minuscules, doublons retirés, 10 au maximum', () => {
  assert.deepEqual(parseTags(' SEO, seo ,Images\nprix,, '), ['seo', 'images', 'prix']);
  assert.equal(parseTags(Array.from({ length: 15 }, (_, i) => `t${i}`).join(',')).length, 10);
  assert.deepEqual(parseTags(undefined), []);
});

test('sources : aller-retour texte ↔ objets', () => {
  const sources = parseSources('Rapport Q3 | https://exemple.fr/rapport | page 4\nNote interne | pas une url\n\nSimple');
  assert.deepEqual(sources, [
    { label: 'Rapport Q3', url: 'https://exemple.fr/rapport', note: 'page 4' },
    { label: 'Note interne', note: 'pas une url' },
    { label: 'Simple' }
  ]);
  assert.deepEqual(parseSources(sourcesText(sources)), sources);
  assert.equal(sourceLine({ label: 'A', url: 'https://x.fr', note: 'n' }), 'A · https://x.fr · n');
  assert.deepEqual(parseSources('javascript:alert(1) | x'), [{ label: 'javascript:alert(1)', note: 'x' }], 'seule une adresse http(s) devient un lien');
});

test('buildPayload : ne garde que le champ de portée utile et normalise les valeurs', () => {
  const base = { kind: 'rule', nature: 'fact', title: '  Titre ', body: ' Corps ', tags: 'A, b', sources: 'S | https://x.fr', importance: '4', confidence: 'high', visibility: 'company', owner: 'lucas', department: 'Catalogue', missionId: 'm9', expiresAt: '' };
  const ind = buildPayload({ ...base, level: 'individual' });
  assert.equal(ind.owner, 'lucas'); assert.ok(!('department' in ind) && !('missionId' in ind));
  assert.equal(ind.title, 'Titre'); assert.equal(ind.body, 'Corps'); assert.equal(ind.importance, 4);
  assert.deepEqual(ind.tags, ['a', 'b']); assert.deepEqual(ind.sources, [{ label: 'S', url: 'https://x.fr' }]);
  assert.equal(ind.expiresAt, null);
  const dep = buildPayload({ ...base, level: 'department' });
  assert.equal(dep.department, 'Catalogue'); assert.ok(!('owner' in dep));
  const mis = buildPayload({ ...base, level: 'mission' });
  assert.equal(mis.missionId, 'm9');
  const co = buildPayload({ ...base, level: 'company' });
  assert.ok(!('owner' in co) && !('department' in co) && !('missionId' in co));
  assert.match(buildPayload({ ...base, level: 'company', expiresAt: '2030-01-31' }).expiresAt, /^2030-01-3[01]T/);
  assert.equal(buildPayload({ level: 'company', title: 't', body: 'b' }).importance, 3, 'importance par défaut');
});

test('stateActions suit la machine d’états du serveur', () => {
  const t = (s) => stateActions(s).map((a) => `${a.to}:${a.label}${a.danger ? '!' : ''}`);
  assert.deepEqual(t('pending'), ['active:Valider', 'rejected:Rejeter', 'deleted:Supprimer!']);
  assert.deepEqual(t('active'), ['archived:Archiver', 'deleted:Supprimer!']);
  assert.deepEqual(t('archived'), ['active:Restaurer', 'deleted:Supprimer!']);
  assert.deepEqual(t('rejected'), ['pending:Rouvrir', 'deleted:Supprimer!']);
  assert.deepEqual(stateActions('inconnu'), []);
  assert.deepEqual(stateActions('deleted'), [], 'un souvenir supprimé n’a plus d’action');
});

test('libellés de fraîcheur, portée et statistiques', () => {
  assert.equal(freshnessLabel({ expired: true }), 'Expiré');
  assert.match(freshnessLabel({ stale: true, ageDays: 200 }), /À revoir \(200 j/);
  assert.equal(freshnessLabel({ ageDays: 0 }), 'Mis à jour aujourd’hui');
  assert.equal(freshnessLabel({ ageDays: 3 }), 'Mis à jour il y a 3 j');
  assert.equal(scopeLabel(item({ level: 'individual', owner: 'lucas' }), { nameOf: (r) => r.toUpperCase() }), 'Individuelle · LUCAS');
  assert.equal(scopeLabel(item({ level: 'department', department: 'Vente' })), 'Département · Vente');
  assert.equal(scopeLabel(item({ level: 'mission' })), 'Mission');
  assert.equal(scopeLabel(item()), 'Entreprise');
  assert.equal(statsLine({ total: 1, pending: 0, stale: 2, expired: 1 }), '1 souvenir · 0 à valider · 2 à revoir · 1 expiré');
  assert.equal(statsLine({ total: 3, pending: 1, stale: 0, expired: 2 }), '3 souvenirs · 1 à valider · 0 à revoir · 2 expirés');
  assert.equal(contextSummary({ items: [1], omitted: 0, tokens: 80 }), '1 souvenir transmis · ≈ 80 jetons');
  assert.equal(contextSummary({ items: [1, 2], omitted: 1, tokens: 80 }), '2 souvenirs transmis, 1 laissé de côté (budget) · ≈ 80 jetons');
  assert.equal(importanceLabel(undefined), 'Importance 3/5');
});

test('libellés d’historique et d’auteur', () => {
  assert.equal(actorLabel('proprietaire'), 'vous');
  assert.equal(actorLabel('agent:lucas'), 'agent lucas');
  assert.equal(actorLabel('appareil:abcd'), 'ordinateur abcd');
  assert.equal(actorLabel(null), '');
  assert.equal(actionLabel('proposed'), 'Proposé par un agent');
  assert.equal(actionLabel('autre'), 'autre', 'une action inconnue reste lisible');
  assert.equal(natureLabel('fact'), 'Fait vérifié');
  assert.equal(levelLabel('zzz'), 'zzz');
});
