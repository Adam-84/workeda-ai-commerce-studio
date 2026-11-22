// Vrai CLI, commandes synthétiques seulement : aucun tour exec et aucun modèle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import { resolveCodex, codexTransport } from '../src/codex-runner.js';

test('MXC réel : frontières fichiers, loopback, enfants et configuration sans modèle', { timeout: 180_000 }, async t => {
  if (process.platform !== 'win32') return t.skip('MXC nécessite Windows natif ; aucun remplacement moins strict.');
  let cli;
  try { cli = resolveCodex(); } catch { return t.skip('Codex CLI absent ; aucune sonde MXC possible.'); }
  const base = resolve(process.env.SystemRoot || 'C:\\Windows', 'Temp');
  const root = mkdtempSync(join(base, 'archipel-mxc-proof-'));
  assert.ok(root.startsWith(base + sep));
  const work = join(root, 'work'), outside = join(root, 'outside'), home = join(root, 'home');
  for (const p of [work, outside, home, join(home, '.codex'), join(home, 'skills'), join(home, 'skills', 'fictif')]) mkdirSync(p);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR || process.env.SystemRoot,
    HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, CODEX_HOME: home, TEMP: home, TMP: home };
  const cmd = join(env.SystemRoot, 'System32', 'cmd.exe');
  const ps = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const curl = join(env.SystemRoot, 'System32', 'curl.exe');
  const records = [], files = () => readdirSync(root, { recursive: true }).sort();
  let fakeConfig = '', profiles = '';
  const observed = {};
  const initial = files();
  t.after(() => {
    t.diagnostic(JSON.stringify({ kind: 'MXC_PROOF', root, cli, environmentNames: Object.keys(env), initial, final: files(), records,
      fixtures: { fakeConfig, profiles }, observed }));
    assert.ok(resolve(root).startsWith(base + sep) && dirname(root) === base);
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    assert.equal(existsSync(root), false);
  });
  async function run(args, expected, timeoutMs = 15_000) {
    const start = Date.now(), before = files();
    const result = await new Promise((done, reject) => {
      const child = spawn(cli.file, [...cli.args, ...args], { cwd: work, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '', bytes = 0, stopped = false;
      const stop = () => {
        stopped = true;
        spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' });
      };
      const timer = setTimeout(stop, timeoutMs);
      for (const [stream, append] of [[child.stdout, x => out += x], [child.stderr, x => err += x]]) stream.on('data', b => {
        bytes += b.length; if (bytes > 200_000) { if (!stopped) stop(); } else append(b.toString());
      });
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); done({ code, out, err, stopped }); });
    });
    records.push({ command: [cli.file, ...cli.args, ...args], cwd: work, environmentNames: Object.keys(env), expected,
      ...result, durationMs: Date.now() - start, before, after: files() });
    return result;
  }
  const sandbox = (profile, command) => ['-c', 'windows.sandbox="mxc"', 'sandbox', '--permission-profile', profile, '--', ...command];
  await run(['--version'], 'version du vrai client, sans modèle');
  await run(['sandbox', '--help'], 'options documentées localement, sans modèle');
  const ready = await run(sandbox(':read-only', [cmd, '/d', '/c', 'echo MXC_READY']), 'MXC_READY, code 0');
  if (ready.code !== 0 || !ready.out.includes('MXC_READY')) {
    assert.equal(ready.stopped, false, 'une sonde bloquée ne doit pas être masquée par un skip');
    if (/mxc|not supported|unavailable|not available|capabilit|policy|unsupported/i.test(ready.err)) return t.skip(`MXC indisponible/refusé, code ${ready.code} : ${ready.err.slice(-600)}`);
    assert.fail(`Échec de sonde MXC non classé : ${ready.err}`);
  }
  const trap = join(outside, 'trap.txt');
  writeFileSync(trap, 'FAUX-SECRET-DE-TEST');
  writeFileSync(join(work, 'allowed.txt'), 'TEMOIN-LECTURE');
  writeFileSync(join(home, '.codex', 'config.toml'), '# FAUX-SECRET-DE-TEST');
  writeFileSync(join(home, 'skills', 'fictif', 'SKILL.md'), '---\nname: fictif\ndescription: Sonde fictive\n---\nFAUX-SECRET-DE-TEST');
  const mcpMarker = join(root, 'mcp-must-not-run.txt'), mcpScript = join(root, 'fake-mcp.cjs');
  writeFileSync(mcpScript, `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)},'FICTIF');`);
  fakeConfig = `default_permissions = "probe_read"\n[features]\nshell_tool = true\nunified_exec = true\n[mcp_servers.fictif]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(mcpScript)}]\n`;
  writeFileSync(join(home, 'config.toml'), fakeConfig);
  // Profils documentés, configuration limitée au CODEX_HOME synthétique.
  profiles = ['probe_read', 'probe_write'].map(name => `
[permissions.${name}.filesystem]
":root" = "deny"
":minimal" = "read"
'${dirname(process.execPath)}' = "read"
'${work}' = "${name === 'probe_write' ? 'write' : 'read'}"
'${outside}' = "deny"
'${home}' = "deny"
[permissions.${name}.network]
enabled = false
`).join('');
  writeFileSync(join(home, 'config.toml'), fakeConfig + profiles);
  const server = createServer(socket => { hits++; socket.end(); });
  let hits = 0;
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  t.after(() => server.close());
  const port = server.address().port;
  const control = connect({ host: '127.0.0.1', port });
  await once(control, 'connect'); control.destroy();
  assert.equal(hits, 1, 'témoin positif : serveur local accessible hors sandbox');
  const payload = `const fs=require('node:fs'),cp=require('node:child_process'),net=require('node:net');
const result={}; const check=(name,fn)=>{try {fn();result[name]='allowed'}catch(e){result[name]=e.code||String(e)}};
check('insideRead',()=>fs.readFileSync(${JSON.stringify(join(work, 'allowed.txt'))}));
check('outsideRead',()=>fs.readFileSync(${JSON.stringify(trap)}));
check('insideWrite',()=>fs.writeFileSync(${JSON.stringify(join(work, 'written.txt'))},'FICTIF'));
check('outsideWrite',()=>fs.writeFileSync(${JSON.stringify(join(outside, 'written.txt'))},'FICTIF'));
check('configRead',()=>fs.readFileSync(${JSON.stringify(join(home, 'config.toml'))}));
check('dotCodexRead',()=>fs.readFileSync(${JSON.stringify(join(home, '.codex', 'config.toml'))}));
check('skillRead',()=>fs.readFileSync(${JSON.stringify(join(home, 'skills', 'fictif', 'SKILL.md'))}));
result.children={};
for(const [name,file,args] of ${JSON.stringify([
    ['cmd', cmd, ['/d', '/c', `type ${join(work, 'allowed.txt')} & type ${trap}`]],
    ['powershell', ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `Get-Content -LiteralPath '${join(work, 'allowed.txt')}' -ErrorAction Stop; try { Get-Content -LiteralPath '${trap}' -ErrorAction Stop } catch { 'DENIED' }`]],
    ['node', process.execPath, ['-e', "const f=require('node:fs');console.log(f.readFileSync(process.argv[1],'utf8'));try{console.log(f.readFileSync(process.argv[2],'utf8'))}catch{console.log('DENIED')}", join(work, 'allowed.txt'), trap]],
    ['curl', curl, ['--version']]
  ])}) {const r=cp.spawnSync(file,args,{encoding:'utf8',timeout:4000,windowsHide:true});result.children[name]={status:r.status,error:r.error?.code,stderr:r.stderr?.slice(-1500),inside:r.stdout?.includes('TEMOIN-LECTURE')||false,read:r.stdout?.includes('FAUX-SECRET-DE-TEST')||false};}
const s=net.connect({host:'127.0.0.1',port:${port}}); s.setTimeout(1200);let done=false;const finish=x=>{if(done)return;done=true;result.network=x;s.destroy();console.log('PROBE_JSON '+JSON.stringify(result));};s.on('connect',()=>finish('connected'));s.on('error',e=>finish(e.code));s.on('timeout',()=>finish('timeout'));`;
  for (const profile of [':read-only', 'probe_read', 'probe_write']) await t.test(profile, async () => {
    const beforeHits = hits;
    const r = await run(sandbox(profile, [process.execPath, '-e', payload]), 'témoin lisible ; écritures/réseau refusés sauf écriture autorisée probe_write');
    assert.equal(r.code, 0, r.err);
    const line = r.out.split(/\r?\n/).find(x => x.startsWith('PROBE_JSON '));
    assert.ok(line, r.out + r.err);
    const data = JSON.parse(line.slice(11)); observed[profile] = data;
    t.diagnostic(JSON.stringify({ profile, data, serverHits: hits - beforeHits }));
    assert.equal(data.insideRead, 'allowed');
    assert.equal(data.insideWrite === 'allowed', profile === 'probe_write');
    assert.notEqual(data.outsideWrite, 'allowed');
    if (profile !== ':read-only') {
      for (const key of ['outsideRead', 'configRead', 'dotCodexRead', 'skillRead']) assert.notEqual(data[key], 'allowed', key);
      for (const name of ['cmd', 'powershell', 'node']) {
        assert.equal(data.children[name].error, undefined, `${name} doit démarrer pour tester son héritage`);
        assert.equal(data.children[name].inside, true, `${name} doit lire le témoin autorisé`);
        assert.equal(data.children[name].read, false);
      }
    }
    assert.notEqual(data.network, 'connected', 'profil sans réseau : aucune connexion loopback');
    assert.equal(hits, beforeHits, 'aucune connexion vue par le serveur local');
    assert.equal(data.network === 'connected', hits > beforeHits, 'le résultat client doit correspondre au témoin serveur');
  });
  await t.test('client réel : configuration et MCP inventoriés sans démarrage de serveur', async () => {
    const listing = await run(['mcp', 'list', '--json'], 'MCP fictif visible sans exécution');
    assert.equal(listing.code, 0, listing.err);
    assert.ok(JSON.parse(listing.out).some(x => x.name === 'fictif'));
    const disabled = await run(['-c', 'mcp_servers.fictif.enabled=false', 'mcp', 'list', '--json'], 'MCP fictif présent mais disabled');
    assert.equal(disabled.code, 0, disabled.err);
    assert.equal(JSON.parse(disabled.out).find(x => x.name === 'fictif').enabled, false);
    assert.equal(existsSync(mcpMarker), false, 'inventorier un MCP ne doit pas le démarrer');
    const features = ['hooks', 'plugins', 'shell_tool', 'unified_exec', 'skill_search', 'skill_mcp_dependency_install', 'multi_agent', 'view_image'];
    const flags = features.flatMap(x => ['--disable', x]);
    const f = await run([...flags, 'features', 'list'], 'désactivations mesurées sans tour modèle');
    assert.equal(f.code, 0, f.err);
    // --help ne compose aucun tour : vérifier uniquement acceptation des options, pas leur efficacité runtime.
    const help = await run(['exec', '--ignore-user-config', '--ignore-rules', ...flags, '-c', 'web_search="disabled"', '-c', 'forced_login_method="chatgpt"', '-c', 'mcp_servers.fictif.enabled=false', '--help'], 'aide exec uniquement, aucun prompt');
    assert.equal(help.code, 0, help.err);
    assert.equal(existsSync(mcpMarker), false, 'aide et features ne doivent pas démarrer le MCP fictif');
  });
  await t.test('arrêt arbre par le transport produit, enveloppe fictive et vraie commande MXC', async () => {
    async function inventory() {
      return new Promise((done, reject) => {
        const c = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${root}*' -and $_.ProcessId -ne $PID } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress`], { env, windowsHide: true });
        const timer = setTimeout(() => c.kill(), 10_000);
        let output = ''; c.stdout.on('data', b => output += b); c.on('error', reject); c.on('close', code => { clearTimeout(timer); code === 0 ? done(output.trim()) : reject(new Error('Inventaire processus impossible')); });
      });
    }
    const beforeProcesses = await inventory();
    records.push({ kind: 'processes-before-stop', processes: beforeProcesses });
    assert.equal(beforeProcesses, '');
    const wrapper = join(root, 'sandbox-wrapper.cjs');
    const args = sandbox('probe_read', [process.execPath, '-e', `const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(JSON.stringify({type:'proof',pids:[process.pid,c.pid]}));setInterval(()=>{},1000)`]);
    // Cette enveloppe ignore les arguments exec du transport ; elle n'invoque QUE sandbox.
    const witness = join(root, 'pids.json');
    writeFileSync(wrapper, `const fs=require('node:fs');const c=require('node:child_process').spawn(${JSON.stringify(cli.file)},${JSON.stringify([...cli.args, ...args])},{cwd:${JSON.stringify(work)},env:${JSON.stringify(env)},stdio:['ignore','pipe','pipe'],windowsHide:true});let b='';c.stdout.on('data',x=>{b+=x;for(const l of b.split(/\\r?\\n/)){try{const e=JSON.parse(l);if(e.pids)fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify({pids:[process.pid,c.pid,...e.pids],command:[process.execPath,...process.argv.slice(1)],cwd:process.cwd(),environmentNames:Object.keys(process.env)}));}catch{}}});c.stdout.pipe(process.stdout);c.stderr.pipe(process.stderr);`);
    const started = Date.now();
    const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TEMP = root; process.env.TMP = root;
    try {
      await assert.rejects(codexTransport({ command: { file: process.execPath, args: [wrapper] }, source: env, prompt: 'FICTIF, jamais transmis à un modèle', timeoutMs: 6000 }), { code: 'timeout' });
    } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
    assert.ok(existsSync(witness), 'la vraie commande et son enfant ont effectivement démarré');
    const invocation = JSON.parse(readFileSync(witness)), { pids } = invocation;
    assert.equal(pids.length, 4);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), `PID ${pid} arrêté`);
    // Le transport ne diffuse pas les événements inconnus ; enregistrer les PID dans le témoin hôte de l'enveloppe.
    records.push({ kind: 'product-tree-stop', ...invocation, sandboxCommand: [cli.file, ...cli.args, ...args], sandboxCwd: work, sandboxEnvironmentNames: Object.keys(env), durationMs: Date.now() - started });
    const processes = await inventory();
    records.push({ kind: 'processes-after-stop', processes });
    assert.equal(processes, '', 'aucun descendant marqué par le dossier dédié');
  });
});
