import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectCodex, runCodex, codexTransport, resolveCodex, filteredEnvironment } from '../src/codex-runner.js';
import { createEngineProvider } from '../src/engine-provider.js';

function fake(t, mode = 'success') {
  const dir = mkdtempSync(join(tmpdir(), 'archipel-fake-codex-'));
  const script = join(dir, 'fake.cjs'), capture = join(dir, 'capture.json');
  writeFileSync(script, `const fs = require('node:fs');
const args = process.argv.slice(2);
if(args.includes('--help') && ${JSON.stringify(mode)}==='probe-timeout') { setInterval(()=>{},1000); return; }
if(args.includes('--help') && ${JSON.stringify(mode)}==='old-help') { console.log('--json'); process.exit(); }
if (args.includes('--version')) { console.log('codex-cli 0.164.0'); process.exit(); }
if (args.includes('--help')) { console.log('--json --sandbox read-only --skip-git-repo-check --ephemeral --ignore-user-config --ignore-rules --config --cd'); process.exit(); }
let prompt=''; process.stdin.setEncoding('utf8'); process.stdin.on('data', x => prompt+=x);
process.stdin.on('end', () => {
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args, prompt, env:process.env, cwd:process.cwd()}));
const mode=${JSON.stringify(mode)};
if(mode==='timeout') { setInterval(()=>{},1000); return; }
if(mode==='tree') { const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(join(dir, 'pid'))},String(c.pid)); setInterval(()=>{},1000); return; }
if(mode==='huge') { process.stdout.write('x'.repeat(2000000)); return; }
if(mode==='auth') { console.log(JSON.stringify({type:'turn.failed',error:{message:'not logged in'}})); return; }
if(mode==='quota') { console.log(JSON.stringify({type:'error',message:'usage limit 429'})); return; }
if(mode==='empty') { console.log(JSON.stringify({type:'turn.completed'})); return; }
if(mode==='tool') { console.log(JSON.stringify({type:'item.started',item:{type:'command_execution'}})); return; }
if(mode==='invalid') { process.stdout.write('invalide\\n{bad}\\n'); }
const out=JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Réponse française 🏝️'}})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:12,output_tokens:7}});
if(mode==='fragment') { const b=Buffer.from(out); for(let i=0;i<b.length;i++) process.stdout.write(b.subarray(i,i+1)); } else process.stdout.write(out);
});`);
  const cmd = join(dir, 'codex.cmd');
  writeFileSync(cmd, `@"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, capture, command: { file: process.execPath, args: [script] }, cmd };
}

test('capacités : les flags réels ne prouvent pas une exécution sans outils, refus avant envoi', async t => {
  const f = fake(t), caps = await detectCodex({ command: f.command });
  assert.equal(caps.version, 'codex-cli 0.164.0');
  assert.equal(caps.available, true); assert.equal(caps.safe, false);
  assert.ok(caps.missing.includes('absence de tous les outils garantie'));
  await assert.rejects(runCodex({ command: f.command, prompt: 'NE PAS ENVOYER' }), { code: 'capability' });
  assert.equal(existsSync(f.capture), false);
});

test('CLI absent : erreur typée, aucun moteur de secours', async () => {
  const caps = await detectCodex({ command: { file: resolve('introuvable-codex.exe'), args: [] } });
  assert.equal(caps.available, false);
  let claude = 0;
  const p = createEngineProvider({ claude: async () => { claude++; }, codex: async () => { throw Object.assign(new Error('Codex absent'), { code: 'unavailable' }); } });
  await assert.rejects(p.run('codex', {}), { code: 'unavailable' }); assert.equal(claude, 0);
  await assert.rejects(p.run('constructor', {}), /Moteur/);
});

test('la détection respecte aussi le timeout et l’annulation, sans prompt envoyé', async t => {
  const f = fake(t, 'probe-timeout');
  await assert.rejects(runCodex({ command: f.command, prompt: 'NE PAS ENVOYER', timeoutMs: 300 }), { code: 'timeout' });
  const controller = new AbortController();
  const p = runCodex({ command: f.command, signal: controller.signal, prompt: 'NE PAS ENVOYER' });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(p, { code: 'cancelled' }); assert.equal(existsSync(f.capture), false);
});

test('ancienne aide sans options d’isolation : refus fermé avec capacités manquantes', async t => {
  const f = fake(t, 'old-help'), c = await detectCodex({ command: f.command });
  assert.ok(c.missing.includes('--ignore-user-config')); assert.ok(c.missing.includes('--sandbox'));
  await assert.rejects(runCodex({ command: f.command, prompt: 'NE PAS ENVOYER' }), { code: 'capability' });
  assert.equal(existsSync(f.capture), false);
});

for (const mode of ['success', 'fragment', 'invalid']) test(`transport faux CLI : ${mode}, fin JSON sans nouvelle ligne et usage`, async t => {
  const f = fake(t, mode), events = [];
  const r = await codexTransport({ command: f.command, system: 'Fiche', prompt: 'Contact a@example.com +33 6 12 34 56 78 AB123456789FR ' + ['sk', '-'].join('') + 'x'.repeat(40), onEvent: e => events.push(e) });
  assert.equal(r.text, 'Réponse française 🏝️'); assert.deepEqual(r.usage, { input: 12, output: 7 });
  assert.equal(r.costUsd, null); assert.equal(r.quota.state, 'unknown');
  assert.ok(events.some(e => e.type === 'usage'));
  const sent = JSON.parse(readFileSync(f.capture));
  assert.doesNotMatch(sent.prompt, /example.com|12 34 56 78|AB123456789FR|x{40}/);
  assert.notEqual(sent.cwd, process.cwd()); assert.equal(existsSync(sent.cwd), false);
  assert.ok(sent.args.includes('--json') && sent.args.includes('read-only'));
  assert.ok(!sent.args.some(x => x.includes('dangerously')));
});

test('shim cmd : jamais de shell, prompt et métacaractères restent sur stdin', async t => {
  const f = fake(t), command = resolveCodex(f.cmd);
  assert.equal(command.file, process.execPath);
  const prompt = 'bonjour & echo INJECTION | whoami $(test)';
  await codexTransport({ command, prompt });
  const sent = JSON.parse(readFileSync(f.capture));
  assert.ok(sent.prompt.includes(prompt)); assert.ok(!sent.args.includes(prompt));
  assert.throws(() => resolveCodex(join(f.dir, 'absent.cmd')), /Codex/);
});

test('environnement : liste autorisée, ni clés, ni proxy, ni options Node, HOME dédié', () => {
  const env = filteredEnvironment({ PATH: 'outils', SystemRoot: 'Windows', OPENAI_API_KEY: 'secret', SHOPIFY_TOKEN: 'secret', NODE_OPTIONS: '--require espion', HTTPS_PROXY: 'secret', CODEX_HOME: 'auth-existante' }, 'vide');
  assert.equal(env.HOME, 'vide'); assert.equal(env.CODEX_HOME, 'auth-existante');
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.SHOPIFY_TOKEN, undefined); assert.equal(env.PATH, undefined);
});

test('usage absent reste inconnu ; seuil de jetons rapportés est un échec typé', async t => {
  const f = fake(t);
  await assert.rejects(codexTransport({ command: f.command, prompt: 'Bonjour', maxTokens: 10 }), { code: 'budget' });
  writeFileSync(f.command.args[0], readFileSync(f.command.args[0], 'utf8').replace("usage:{input_tokens:12,output_tokens:7}", "usage:null"));
  const r = await codexTransport({ command: f.command, prompt: 'Bonjour' });
  assert.equal(r.usage, null); assert.equal(r.costUsd, null);
});

test('les clés API présentes chez Archipel ne parviennent pas au faux processus', async t => {
  const f = fake(t);
  await codexTransport({ command: f.command, source: { SystemRoot: process.env.SystemRoot, OPENAI_API_KEY: 'secret-injecte', ARCHIPEL_PASSWORD: 'secret-injecte', NODE_OPTIONS: '--require espion', HTTPS_PROXY: 'secret-injecte' }, prompt: 'Bonjour' });
  const { env } = JSON.parse(readFileSync(f.capture));
  assert.ok(!Object.values(env).includes('secret-injecte'));
  assert.equal(env.OPENAI_API_KEY, undefined); assert.equal(env.ARCHIPEL_PASSWORD, undefined); assert.equal(env.NODE_OPTIONS, undefined);
});

test('contrat fournisseur : événements normalisés et contexte Codex nettoyé, sans modèle Claude', async () => {
  const events = [];
  const provider = createEngineProvider({ codex: async opts => {
    assert.doesNotMatch(opts.system + opts.prompt, /example.com|34 56 78/);
    opts.onEvent({ type: 'usage', usage: { input: 2, output: 3 }, costUsd: 0 });
    return { text: 'Réponse', usage: { input: 2, output: 3 }, costUsd: 0 };
  } });
  const r = await provider.run('codex', { system: 'Contact a@example.com', prompt: '+33 6 12 34 56 78', onEvent: e => events.push(e) });
  assert.equal(r.costUsd, null); assert.equal(r.engine, 'codex');
  assert.ok(events.every(e => e.engine === 'codex')); assert.deepEqual(events.map(e => e.type), ['usage', 'completed']);
});

for (const [mode, code] of [['auth', 'auth'], ['quota', 'quota'], ['huge', 'output_limit'], ['empty', 'protocol'], ['tool', 'isolation']]) test(`transport : ${mode} → ${code}`, async t => {
  const f = fake(t, mode);
  await assert.rejects(codexTransport({ command: f.command, prompt: 'Bonjour' }), { code });
});

test('timeout et annulation : termine le processus et son arbre', async t => {
  for (const mode of ['timeout', 'tree']) {
    const f = fake(t, mode);
    await assert.rejects(codexTransport({ command: f.command, prompt: 'Bonjour', timeoutMs: 750 }), { code: 'timeout' });
    if (mode === 'tree') {
      const pid = Number(readFileSync(join(f.dir, 'pid')));
      assert.throws(() => process.kill(pid, 0), 'le descendant est arrêté');
    }
  }
  const f = fake(t, 'timeout'), controller = new AbortController();
  const pending = codexTransport({ command: f.command, signal: controller.signal, prompt: 'Bonjour' });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, { code: 'cancelled' });
});
