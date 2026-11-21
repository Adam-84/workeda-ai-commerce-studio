// Phase 6 : intégrations DSers/17TRACK dans les missions (accès par agent côté serveur, héritage sans escalade, sources vérifiables),
// journal portable, migration v3 et API locale. Serveurs simulés : aucun réseau réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStudio } from '../src/studio.js';
import { createApp } from '../src/app.js';
import { loadAgentFiles } from '../src/agent-files.js';
import { createOrchestrator } from '../src/comm-run.js';
import { createSecretStore, testProtector } from '../src/secret-store.js';
import { createSimDsers, createSimTrack17, shopCatalog, PII } from './helpers/sim-servers.js';

const { profiles } = loadAgentFiles(fileURLToPath(new URL('../.claude/agents', import.meta.url)));
const J = JSON.stringify;

async function setup(script, { connect = true, grants = [], dsers = {}, file = ':memory:', journalDir } = {}) {
  const sim = createSimDsers(dsers), t17 = createSimTrack17();
  const secrets = createSecretStore({ dir: mkdtempSync(join(tmpdir(), 'archipel-im-')), protector: testProtector() });
  const fetchImpl = (u, i) => (String(u).includes('17track') ? t17.fetch(u, i) : sim.fetch(u, i));
  const studio = createStudio(file, { secrets, env: { ARCHIPEL_ALLOW_REAL_NETWORK: '1' }, integrationsFetch: fetchImpl, commJournalDir: journalDir, redirectUri: 'http://127.0.0.1:4318/api/integrations/dsers/callback' });
  studio.syncAgentFiles(profiles);
  studio.shop.latest = () => ({ id: 's', fetchedAt: new Date().toISOString(), products: shopCatalog(38), sourceUrls: [] });
  const ids = Object.fromEntries(studio.listAgentFiles().map((f) => [f.slug, f.agentId]));
  const svc = studio.integrations;
  if (connect) { const { authorizationUrl } = await svc.beginAuth('dsers'); const a = sim.authorize(authorizationUrl); await svc.completeAuth({ code: a.code, state: a.state }); await svc.sync('dsers', { force: true }); }
  for (const g of grants) svc.grant(g[0], g[1]);
  const calls = [];
  const runner = async (o) => { const name = /^Tu es ([^,]+),/.exec(o.system)?.[1]; calls.push({ name, ...o }); const s = script[name]; return typeof s === 'function' ? s(o, calls) : s; };
  const orch = createOrchestrator({ studio, profiles: () => profiles, runner });
  return { studio, comm: studio.comm, ids, orch, calls, svc, sim, t17 };
}
const ok = J({ report: 'Analyse faite à partir des relevés fournis.', status: 'done' });

test('journal : erreurs, observations, références et accusés des intégrations restent locaux', async () => {
  const marker = 'DETAIL-FOURNISSEUR-LOCAL-UNIQUEMENT';
  const dir = mkdtempSync(join(tmpdir(), 'archipel-journal-'));
  const s = await setup({}, { connect: false, journalDir: dir });
  const task = s.comm.createTask({ assigneeId: s.ids.lucas, instruction: 'Analyser', withIntegrations: ['dsers'] }).task;
  const run = s.comm.startRun({ agentId: s.ids.lucas, kind: 'task', taskId: task.id, threadId: task.threadId });
  const result = s.comm.recordResult(task.id, { agentId: s.ids.lucas, runId: run.id, body: 'Résultat', summary: '', level: 'none', verified: false, observed: { provided: [marker] }, verification: marker });
  s.comm.postMessage(task.threadId, { body: 'Résultat', taskId: task.id, refs: [{ type: 'result', id: result.id, label: marker }] }, { type: 'agent', agentId: s.ids.lucas, runId: run.id });
  s.comm.endRun(run.id, { state: 'error', error: marker });
  const { readFileSync, readdirSync } = await import('node:fs');
  const journal = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.ok(!journal.includes(marker), 'métadonnée ou erreur copiée dans le journal git');
});

test('une tâche intégration ne crée aucune mémoire sans provenance', async () => {
  const s = await setup({ Lucas: () => J({ report: 'Analyse faite.', memory: [{ title: 'Coût fournisseur local', body: 'Le fournisseur propose ce coût confidentiel.', nature: 'hypothesis', level: 'mission' }] }) }, { grants: [['dsers', 'lucas']] });
  s.comm.createTask({ assigneeId: s.ids.lucas, instruction: 'Analyser', withIntegrations: ['dsers'] });
  s.orch.pump(); await s.orch.idle();
  assert.equal(s.studio.memory.stats().total, 0, 'la mémoire ne conserve pas les restrictions des intégrations');
});

test('une consigne déléguée issue des intégrations ne revient pas dans une tâche sans accès', async () => {
  const marker = 'CONSIGNE-FOURNISSEUR-LOCALE';
  const s = await setup({ Alexander: () => J({ report: 'Je confie.', delegate: [{ to: 'Lucas', task: marker }] }), Lucas: () => ok }, { grants: [['dsers', 'lucas'], ['dsers', 'alexander']] });
  const root = s.comm.createTask({ assigneeId: s.ids.alexander, instruction: 'Coordonner', withIntegrations: ['dsers'], requiresApproval: false }).task;
  s.orch.pump(); await s.orch.idle();
  s.svc.revokeGrant('dsers', 'lucas');
  const child = s.comm.listTasks({ rootTaskId: root.id }).find((t) => t.id !== root.id);
  s.comm.createTask({ assigneeId: s.ids.lucas, missionId: child.missionId, threadId: child.threadId, instruction: 'Nouvelle analyse sans intégration' });
  const before = s.calls.length; s.orch.pump(); await s.orch.idle();
  assert.ok(s.calls.length > before);
  assert.ok(!s.calls.at(-1).prompt.includes(marker));
});

test('tâche avec DSers : sans accès accordé, aucune donnée ; avec accès, relevé daté sans PII, outils vides', async () => {
  const a = await setup({ Lucas: () => ok });
  a.comm.createTask({ assigneeId: a.ids.lucas, instruction: 'Rapprocher le catalogue Shopify et DSers', withIntegrations: ['dsers'] });
  a.orch.pump(); await a.orch.idle();
  assert.match(a.calls[0].prompt, /NON accordé/); assert.doesNotMatch(a.calls[0].prompt, /Produit numéro/);

  const b = await setup({ Lucas: () => ok }, { grants: [['dsers', 'lucas']] });
  const before = b.sim.state.mcpCount;
  const t = b.comm.createTask({ assigneeId: b.ids.lucas, instruction: 'Rapprocher le catalogue Shopify et DSers', withIntegrations: ['dsers'] }).task;
  assert.deepEqual(t.withIntegrations, ['dsers']);
  b.orch.pump(); await b.orch.idle();
  const c = b.calls[0];
  assert.match(c.prompt, /<donnees-non-fiables/); assert.match(c.prompt, /Produit numéro/); assert.deepEqual(c.tools, []);
  assert.match(c.system, /LECTURE SEULE/);
  for (const bad of [...PII.names, ...PII.emails, ...PII.phones, ...PII.streets, ...PII.zips]) assert.ok(!c.prompt.includes(bad), `PII dans le prompt : ${bad}`);
  assert.ok(!/RR\d{9}CN/.test(c.prompt));
  assert.equal(b.sim.state.mcpCount, before, 'la tâche ne consomme aucun quota : relevés en cache');
  assert.deepEqual(b.sim.writeAttempts, []);
  assert.equal(b.comm.task(t.id).state, 'done');
});

test('source « archipel://integrations/… » fournie par le Studio : vérifiable ; une source inventée ne l’est pas', async () => {
  const s = await setup({ Lucas: (o) => { const u = /archipel:\/\/integrations\/dsers\/[0-9a-f-]{36}/.exec(o.prompt)?.[0]; return J({ report: 'Rapprochement fait.', sources: [{ label: 'Relevé DSers', url: u }, { label: 'Inventée', url: 'archipel://integrations/dsers/00000000-0000-0000-0000-000000000000' }] }); } }, { grants: [['dsers', 'lucas']] });
  const t = s.comm.createTask({ assigneeId: s.ids.lucas, instruction: 'Rapprocher les produits', withIntegrations: ['dsers'], requiresSources: true }).task;
  s.orch.pump(); await s.orch.idle();
  const r = s.comm.resultOf(t.id);
  assert.ok(r.observed.provided.length > 0 && r.observed.provided.every((u) => u.startsWith('archipel://integrations/dsers/')));
  assert.equal(r.sources.find((x) => x.label === 'Relevé DSers')?.checked, true);
  assert.equal(r.sources.find((x) => x.label === 'Inventée')?.checked, false);
});

test('héritage sans escalade : un agent ne peut pas demander une intégration que le propriétaire n’a pas donnée', async () => {
  const s = await setup({ Alexander: () => J({ report: 'Je confie.', delegate: [{ to: 'Lucas', task: 'Rapprocher les produits' }] }), Lucas: () => ok }, { grants: [['dsers', 'lucas']] });
  const root = s.comm.createTask({ assigneeId: s.ids.alexander, instruction: 'Coordonner', withIntegrations: ['dsers'], requiresApproval: false }).task;
  s.orch.pump(); await s.orch.idle();
  const kids = s.comm.listTasks({ rootTaskId: root.id }).filter((t) => t.id !== root.id);
  assert.ok(kids.length === 1 && kids[0].withIntegrations.includes('dsers'), 'héritage depuis le parent');
  const bare = s.comm.createTask({ assigneeId: s.ids.alexander, instruction: 'Autre racine', requiresApproval: false }).task;
  const by = { type: 'agent', agentId: s.ids.alexander, runId: s.comm.startRun({ agentId: s.ids.alexander, kind: 'task', taskId: bare.id }).id };
  const child = s.comm.createTask({ assigneeId: s.ids.noah, instruction: 'Veille', parentTaskId: bare.id, withIntegrations: ['dsers', 'track17'] }, by).task;
  assert.deepEqual(child.withIntegrations, []);
  const x = s.comm.createTask({ assigneeId: s.ids.isabella, instruction: 'Calculer les marges', withIntegrations: ['dsers'] });
  const y = s.comm.createTask({ assigneeId: s.ids.isabella, instruction: 'Calculer les marges' });
  assert.equal(x.created && y.created, true, 'avec/sans intégration : pas un doublon');
  assert.deepEqual(s.comm.createTask({ assigneeId: s.ids.sophia, instruction: 'Étude', withIntegrations: ['inconnue', 'dsers'] }).task.withIntegrations, ['dsers'], 'identifiants inconnus ignorés');
});

test('tâche autorisée à lire le web : aucune donnée DSers/17TRACK fournie (pas de fuite par une page piégée)', async () => {
  const s = await setup({ Noah: () => ok }, { grants: [['dsers', 'noah']] });
  s.comm.createTask({ assigneeId: s.ids.noah, instruction: 'Veille concurrents et prix fournisseurs', withIntegrations: ['dsers'], allowWeb: true });
  s.orch.pump(); await s.orch.idle();
  assert.doesNotMatch(s.calls[0].prompt, /Produit numéro/); assert.match(s.calls[0].prompt, /NON fournies/);
});

test('journal portable : l’intégration demandée voyage, aucune donnée ni secret', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-journal-'));
  const s = await setup({ Lucas: () => ok }, { journalDir: dir, grants: [['dsers', 'lucas']] });
  const t = s.comm.createTask({ assigneeId: s.ids.lucas, instruction: 'Rapprocher', withIntegrations: ['dsers'] }).task;
  s.orch.pump(); await s.orch.idle();
  const { readFileSync, readdirSync } = await import('node:fs');
  const text = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.ok(text.includes('"withIntegrations":["dsers"]'));
  for (const bad of [...s.sim.state.access, ...PII.emails, ...PII.names, 'Produit numéro']) assert.ok(!text.includes(bad), 'fuite dans le journal');
  assert.ok(t.id);
});

// --- API locale --------------------------------------------------------------------------------------------------------------------
async function api(studio, { host = '127.0.0.1' } = {}) {
  const app = createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)), agentFiles: { profiles, warnings: [] } });
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const port = app.address().port;
  const call = (method, path, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: `${host}:${port}`, 'content-type': 'application/json', ...headers } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => { let json = null; try { json = JSON.parse(d); } catch { /* html */ } resolve({ status: res.statusCode, body: json, text: d, headers: res.headers }); }); });
    req.on('error', reject); if (body !== undefined) req.write(J(body)); req.end();
  });
  return { call, close: () => new Promise((r) => app.close(r)) };
}

test('API : cartes, connexion confirmée, accès par agent, révocation ; jamais de secret dans les réponses', async () => {
  const s = await setup({}, { connect: false });
  const a = await api(s.studio);
  try {
    let r = await a.call('GET', '/api/integrations');
    assert.equal(r.status, 200); assert.equal(r.body.cards.length, 2); assert.ok(r.body.agents.some((x) => x.slug === 'lucas'));
    assert.deepEqual(r.body.cards.map((c) => c.grants), [[], []], 'aucun accès par défaut');
    assert.equal((await a.call('POST', '/api/integrations/dsers/connect', {})).status, 400, 'confirmation explicite requise');
    r = await a.call('POST', '/api/integrations/dsers/connect', { confirm: true });
    assert.equal(r.status, 200); assert.match(r.body.authorizationUrl, /^https:\/\/ai\.dsers\.com\/oauth\/authorize\?/); assert.match(r.body.authorizationUrl, /code_challenge_method=S256/);
    const au = s.sim.authorize(r.body.authorizationUrl);
    r = await a.call('GET', `/api/integrations/dsers/callback?code=${au.code}&state=${au.state}`);
    assert.equal(r.status, 200); assert.match(r.text, /lecture seule/); assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    r = await a.call('POST', '/api/integrations/dsers/test', {}); assert.equal(r.body.state, 'tested');
    r = await a.call('POST', '/api/integrations/dsers/grants', { agent: 'lucas' }); assert.deepEqual(r.body.grants.map((g) => g.agent), ['lucas']);
    assert.equal((await a.call('POST', '/api/integrations/dsers/grants', { agent: 'fantome' })).status, 404);
    r = await a.call('POST', '/api/integrations/dsers/settings', { dailyCap: 50 }); assert.equal(r.body.quota.cap, 50);
    assert.equal((await a.call('POST', '/api/integrations/dsers/settings', { dailyCap: 0 })).status, 400);
    r = await a.call('POST', '/api/integrations/dsers/grants/lucas/revoke', {}); assert.deepEqual(r.body.grants, []);
    r = await a.call('POST', '/api/integrations/track17/key', { confirm: true, key: s.t17.key }); assert.equal(r.status, 200);
    const everything = J((await a.call('GET', '/api/integrations')).body);
    for (const sec of [...s.sim.state.access, ...s.sim.state.refresh.keys(), s.t17.key]) assert.ok(!everything.includes(sec), 'secret exposé par l’API');
    r = await a.call('POST', '/api/integrations/dsers/revoke', { purge: true }); assert.equal(r.body.revoked, true); assert.equal(r.body.card.flags.authenticated, false);
    assert.equal((await a.call('GET', '/api/integrations/inconnu')).status, 404);
  } finally { await a.close(); }
});

test('API : refusée depuis une autre origine ou un autre nom d’hôte ; aucune route d’écriture DSers/17TRACK/Shopify', async () => {
  const s = await setup({}, { connect: false });
  const a = await api(s.studio);
  try {
    assert.equal((await a.call('POST', '/api/integrations/dsers/connect', { confirm: true }, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await a.call('GET', '/api/integrations', undefined, { host: 'evil.example' })).status, 403);
    for (const p of ['/api/integrations/dsers/orders', '/api/integrations/dsers/push', '/api/integrations/dsers/call', '/api/integrations/track17/register']) assert.equal((await a.call('POST', p, { confirm: true })).status, 404, p);
  } finally { await a.close(); }
});

test('réseau réel non autorisé : la connexion est refusée avec explication, aucune requête sortante', async () => {
  const sim = createSimDsers();
  const secrets = createSecretStore({ dir: mkdtempSync(join(tmpdir(), 'archipel-im-')), protector: testProtector() });
  const studio = createStudio(':memory:', { secrets, env: {}, integrationsFetch: sim.fetch });
  const a = await api(studio);
  try {
    const r = await a.call('POST', '/api/integrations/dsers/connect', { confirm: true });
    assert.equal(r.status >= 400, true); assert.match(r.body.error, /désactivée|ARCHIPEL_ALLOW_REAL_NETWORK/); assert.equal(sim.state.http.length, 0);
  } finally { await a.close(); }
});

test('revue Codex #1 : le rapport issu de données DSers n’est transmis ni à un agent sans le même accès, ni à une tâche web, ni au journal git', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-journal-'));
  const s = await setup({ Lucas: () => J({ report: 'RAPPORT-FOURNISSEUR-CONFIDENTIEL : marge 42 % chez Fournisseur 3.', status: 'done', sources: [{ label: 'SOURCE-LIBELLE-CONFIDENTIEL', url: 'https://example.com/x' }] }), Noah: () => ok }, { journalDir: dir, grants: [['dsers', 'lucas']] });
  const lucas = s.comm.createTask({ assigneeId: s.ids.lucas, instruction: 'Analyser les fournisseurs DSers', withIntegrations: ['dsers'] }).task;
  s.orch.pump(); await s.orch.idle();
  assert.equal(s.comm.task(lucas.id).state, 'done');
  s.comm.createTask({ assigneeId: s.ids.noah, instruction: 'Veille web des concurrents', allowWeb: true, dependsOn: [lucas.id], missionId: lucas.missionId });
  s.orch.pump(); await s.orch.idle();
  const noah = s.calls.find((c) => c.name === 'Noah'); assert.ok(noah, 'la tâche de Noah a tourné');
  assert.ok(!noah.prompt.includes('RAPPORT-FOURNISSEUR'), 'rapport DSers transmis à une tâche web sans accès');
  assert.match(noah.prompt, /non transmis/);
  const { readFileSync, readdirSync } = await import('node:fs');
  const journal = readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.ok(!journal.includes('RAPPORT-FOURNISSEUR'), 'rapport DSers écrit dans le journal git');
  assert.ok(!journal.includes('SOURCE-LIBELLE-CONFIDENTIEL'), 'libellé de source issu de données DSers écrit dans le journal git');
  assert.ok(!noah.prompt.includes('tâche « Analyser les fournisseurs DSers »'), 'titre de la tâche dépendante transmis à une tâche web sans accès');
  assert.ok(journal.includes('Contenu local non synchronisé'));
});

test('revue Codex (2e passe) : délégation issue de données DSers → refusée sans accès ; avec accès, instruction/titre/mission restent hors du journal git', async () => {
  const SECRET = 'DONNEE-FOURNISSEUR-CONFIDENTIELLE-X';
  const script = { Alexander: (o) => (/Réponds uniquement avec un objet JSON/.test(o.prompt) ? J({ report: 'Je confie.', delegate: [{ to: 'Lucas', task: `Analyser ${SECRET}` }] }) : 'Réponse libre.'), Lucas: () => ok };
  const { readFileSync, readdirSync } = await import('node:fs');
  const journalOf = (dir) => readdirSync(dir).map((f) => readFileSync(join(dir, f), 'utf8')).join(String.fromCharCode(10));
  // sans accès pour Lucas : aucune tâche créée, aucune trace
  const d1 = mkdtempSync(join(tmpdir(), 'archipel-journal-'));
  const a = await setup(script, { journalDir: d1, grants: [['dsers', 'alexander']] });
  const r1 = a.comm.createTask({ assigneeId: a.ids.alexander, instruction: 'Coordonner', withIntegrations: ['dsers'], requiresApproval: false }).task;
  a.orch.pump(); await a.orch.idle();
  assert.equal(a.comm.listTasks({ rootTaskId: r1.id }).filter((t) => t.assigneeId === a.ids.lucas).length, 0, 'tâche créée pour un agent sans accès');
  assert.equal(a.calls.filter((c) => c.name === 'Lucas').length, 0);
  assert.ok(!journalOf(d1).includes(SECRET), 'donnée dans le journal (refus)');
  // avec accès : la tâche tourne, mais son contenu écrit par un agent ne voyage pas
  const d2 = mkdtempSync(join(tmpdir(), 'archipel-journal-'));
  const b = await setup(script, { journalDir: d2, grants: [['dsers', 'alexander'], ['dsers', 'lucas']] });
  const r2 = b.comm.createTask({ assigneeId: b.ids.alexander, instruction: 'Coordonner', withIntegrations: ['dsers'], requiresApproval: false }).task;
  b.orch.pump(); await b.orch.idle();
  assert.equal(b.comm.listTasks({ rootTaskId: r2.id }).filter((t) => t.assigneeId === b.ids.lucas).length, 1);
  assert.ok(!journalOf(d2).includes(SECRET), 'instruction, titre, mission ou référence issus de données DSers écrits dans le journal git');
});

test('revue Codex (2e passe) : réponse libre — un rapport issu de DSers n’est pas relu', async () => {
  const REPORT = 'RAPPORT-DSERS-POUR-REPONSE-LIBRE';
  const s = await setup({ Alexander: (o) => (/Réponds uniquement avec un objet JSON/.test(o.prompt) ? J({ report: 'Je confie.', delegate: [{ to: 'Lucas', task: 'Analyser les fournisseurs' }] }) : 'Réponse libre.'), Lucas: () => J({ report: REPORT, status: 'done' }) }, { grants: [['dsers', 'lucas'], ['dsers', 'alexander']] });
  const root = s.comm.createTask({ assigneeId: s.ids.alexander, instruction: 'Coordonner', withIntegrations: ['dsers'], requiresApproval: false }).task;
  s.orch.pump(); await s.orch.idle();
  const before = s.calls.length;
  s.orch.replyInThread(s.comm.task(root.id).threadId, s.ids.alexander); await s.orch.idle();
  const reply = s.calls.slice(before).find((c) => c.name === 'Alexander');
  if (reply) assert.ok(!reply.prompt.includes(REPORT), 'rapport DSers relu par une réponse libre');
});

