// Veille des versions de Codex CLI : comparaison, pertinence, rapport, garde-fous réseau et contenu du workflow. Hors ligne (fixtures), aucun appel réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseVersion, compareVersions, analyzeNotes, selectNewer, candidateVersions, buildReport, runWatch, makeFetchJson, BLOCKERS, DIST_TAGS_URL, releaseUrl } from '../tools/codex-watch/check.mjs';

const base = { tested: '0.164.0', lastReported: null };
const rel = (v, body, extra = {}) => ({ tag_name: `rust-v${v}`, html_url: `https://github.com/openai/codex/releases/tag/rust-v${v}`, prerelease: false, draft: false, body, ...extra });
const NOTES = {
  tools: '- Added `agents.enabled` to disable subagent tools in noninteractive runs. (#1)',
  profile: '- Added `--ignore-user-config` support that skips user skills and AGENTS.md discovery. (#2)',
  network: '- Support managed network requirements: only the configured host may be reached through the egress allowlist. (#3)',
  none: '- Fixed a TUI crash when resizing the terminal. (#4)\n- Improved startup time.'
};
const fakeFetch = (map) => async (url) => { if (!(url in map)) throw new Error('HTTP 404'); const v = map[url]; if (v instanceof Error) throw v; return v; };

test('versions : analyse, comparaison et prérelease ignorés', () => {
  assert.equal(parseVersion('rust-v0.171.0').text, '0.171.0'); assert.equal(parseVersion('0.173.0-alpha.4').pre, 'alpha.4'); assert.equal(parseVersion('n/a'), null);
  assert.equal(compareVersions('0.171.0', '0.164.0'), 1); assert.equal(compareVersions('0.164.0', '0.164.0'), 0); assert.equal(compareVersions('0.164.0-alpha.1', '0.164.0'), -1); assert.equal(compareVersions('1.0.0', '0.999.9'), 1);
  assert.throws(() => compareVersions('x', '0.1.0'));
  const sel = selectNewer([rel('0.173.0-alpha.4', '', { prerelease: true }), rel('0.171.0', 'x'), rel('0.165.0', 'y', { draft: true }), rel('0.164.0', 'z'), rel('0.170.0', 'w'), null, { tag_name: 'weird' }], '0.164.0');
  assert.deepEqual(sel.map((r) => r.tag_name), ['rust-v0.171.0', 'rust-v0.170.0'], 'seulement les stables plus récentes, triées');
  assert.deepEqual(candidateVersions('0.164.0', '0.171.0'), ['0.165.0', '0.166.0', '0.167.0', '0.168.0', '0.169.0', '0.170.0', '0.171.0']); assert.deepEqual(candidateVersions('0.171.0', '0.171.0'), []); assert.deepEqual(candidateVersions('0.164.0', '0.173.0-alpha.4'), []);
});

test('pertinence : chaque blocage est reconnu par une formulation forte ; le bruit ne déclenche rien', () => {
  assert.deepEqual(analyzeNotes(NOTES.tools).groups, ['tools']); assert.deepEqual(analyzeNotes(NOTES.profile).groups, ['profile']); assert.deepEqual(analyzeNotes(NOTES.network).groups, ['network']);
  const none = analyzeNotes(NOTES.none); assert.equal(none.relevant, false); assert.deepEqual(none.groups, []);
  for (const noise of ['- Added undo and redo shortcuts to the prompt composer.', '- Updated the default model to GPT-6.2 Sol.', '- Fixed Windows path handling for quoted cmd.exe paths.', '- Improved tool call rendering in the TUI.']) assert.equal(analyzeNotes(noise).relevant, false, noise);
  assert.equal(analyzeNotes(null).relevant, false); assert.equal(analyzeNotes('').relevant, false);
  assert.ok(analyzeNotes('- Added GPT-6.2 Sol and Astra to model catalogs.').info.models.length === 1, 'les modèles sont une information, pas un signalement');
  assert.equal(BLOCKERS.length, 3);
});

test('veille : version pertinente signalée, version sans intérêt non signalée, aucune nouvelle version = rien', async () => {
  const dist = { [DIST_TAGS_URL]: { latest: '0.166.0', beta: '0.1.1' } };
  const relevant = await runWatch({ baseline: base, date: '2026-11-22', fetchJson: fakeFetch({ ...dist, [releaseUrl('0.165.0')]: rel('0.165.0', NOTES.none), [releaseUrl('0.166.0')]: rel('0.166.0', `${NOTES.network}\n${NOTES.tools}`) }) });
  assert.deepEqual(relevant.newer, ['0.166.0', '0.165.0']); assert.deepEqual(relevant.relevant, ['0.166.0']); assert.equal(relevant.notesAvailable, true);
  assert.match(relevant.report, /Codex CLI 0\.166\.0 — version PERTINENTE/); assert.match(relevant.report, /Versions sans mention pertinente : 0\.165\.0/); assert.match(relevant.report, /Tests nécessaires avant toute reprise/);
  assert.match(relevant.report, /Windows seulement/); assert.match(relevant.report, /n'installe, ne met à jour et n'exécute rien/); assert.match(relevant.report, /refus fermé/i);
  const quiet = await runWatch({ baseline: base, fetchJson: fakeFetch({ ...dist, [releaseUrl('0.165.0')]: rel('0.165.0', NOTES.none), [releaseUrl('0.166.0')]: rel('0.166.0', NOTES.none) }) });
  assert.deepEqual(quiet.relevant, []); assert.doesNotMatch(quiet.report, /PERTINENTE/); assert.doesNotMatch(quiet.report, /Tests nécessaires/);
  const same = await runWatch({ baseline: { tested: '0.166.0' }, fetchJson: fakeFetch({ [DIST_TAGS_URL]: { latest: '0.166.0' } }) });
  assert.deepEqual(same.newer, []); assert.deepEqual(same.relevant, []); assert.match(same.report, /rien à signaler/);
});

test('dégradation : notes GitHub indisponibles → la nouvelle version est quand même signalée, sans analyse inventée ; registre indisponible → silence', async () => {
  const dist = { [DIST_TAGS_URL]: { latest: '0.166.0' } };
  const noNotes = await runWatch({ baseline: base, fetchJson: fakeFetch({ ...dist, [releaseUrl('0.165.0')]: new Error('HTTP 403'), [releaseUrl('0.166.0')]: new Error('HTTP 403') }) });
  assert.equal(noNotes.notesAvailable, false); assert.deepEqual(noNotes.relevant, ['0.166.0']); assert.match(noNotes.report, /Notes de version indisponibles/); assert.doesNotMatch(noNotes.report, /PERTINENTE/);
  const down = await runWatch({ baseline: base, fetchJson: fakeFetch({}) }); assert.deepEqual(down.relevant, []); assert.equal(down.latest, null);
});

test('réseau : seuls registry.npmjs.org et api.github.com en HTTPS, sans redirection ; le jeton ne part jamais ailleurs', async () => {
  const calls = []; const f = makeFetchJson({ token: 'JETON-EPHEMERE-DE-TEST', fetchImpl: async (u, init) => { calls.push({ host: u.hostname, init }); return { ok: true, status: 200, text: async () => '{"latest":"0.1.0"}' }; } });
  await f('https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags'); await f('https://api.github.com/repos/openai/codex/releases/tags/rust-v0.171.0');
  assert.equal(calls[0].init.headers.authorization, undefined, 'pas de jeton vers le registre npm'); assert.equal(calls[1].init.headers.authorization, 'Bearer JETON-EPHEMERE-DE-TEST');
  assert.ok(calls.every((c) => c.init.method === 'GET' && c.init.redirect === 'error' && !c.init.body));
  for (const bad of ['http://registry.npmjs.org/x', 'https://evil.example/x', 'https://registry.npmjs.org.evil.net/x', 'https://api.github.com.evil.net/x', 'file:///etc/passwd']) await assert.rejects(() => f(bad), /hôte non autorisé|Invalid|invalid/i, bad);
  assert.equal(calls.length, 2, 'aucune requête vers un hôte refusé');
  await assert.rejects(() => makeFetchJson({ fetchImpl: async () => ({ ok: false, status: 500 }) })('https://api.github.com/x'), /HTTP 500/);
  await assert.rejects(() => makeFetchJson({ fetchImpl: async () => ({ ok: true, text: async () => 'x'.repeat(5_000_001) }) })('https://api.github.com/x'), /trop volumineuse/);
});

test('rapport : aucune donnée personnelle ni secret ; n\'installe, ne met à jour et n\'exécute rien (analyse statique du script)', () => {
  const code = readFileSync('tools/codex-watch/check.mjs', 'utf8');
  assert.ok(!/child_process|execSync|execFile|spawn|npm (install|i|update)|npx |writeFileSync\([^)]*baseline/.test(code), 'aucune exécution ni installation ; ne modifie pas la baseline');
  assert.ok(!/process\.env\.(?!GITHUB_TOKEN|GITHUB_OUTPUT)/.test(code), 'seules variables lues : GITHUB_TOKEN et GITHUB_OUTPUT');
  assert.ok(!/adamg|USERPROFILE|homedir|dotenv|\.env['"]/.test(code));
});

test('workflow GitHub Actions : planifié + manuel, permissions minimales, aucun secret autre que le jeton éphémère, aucune exécution de Codex', () => {
  const y = readFileSync('.github/workflows/codex-watch.yml', 'utf8');
  assert.match(y, /schedule:/); assert.match(y, /workflow_dispatch:/); assert.match(y, /permissions:\n {2}contents: read\n {2}issues: write/);
  assert.ok(!/pull_request_target|pull_request:|push:/.test(y), 'déclencheurs limités (aucun déclenchement par un tiers)');
  assert.ok(!/secrets\./.test(y), 'aucun secret du dépôt'); assert.ok(!/API_KEY|OPENAI|ANTHROPIC/i.test(y));
  assert.ok(!/(npm|pnpm|yarn|bun)\s+(i|install|add|update|exec|dlx)|npx\b|codex\s+(exec|--|login|app-server)|@openai\/codex/.test(y.replace(/#.*$/gm, '')), 'le workflow n\'installe ni n\'exécute Codex');
  assert.match(y, /persist-credentials: false/); assert.match(y, /node tools\/codex-watch\/check\.mjs/); assert.match(y, /timeout-minutes: \d/);
  assert.ok(!/contents: write/.test(y), 'aucune écriture dans le dépôt : pas de modification automatique de la baseline');
});

test('baseline : version testée valide, jamais mise à jour automatiquement', () => {
  const b = JSON.parse(readFileSync('tools/codex-watch/baseline.json', 'utf8')); assert.equal(b.tested, '0.164.0'); assert.ok(parseVersion(b.tested));
});
