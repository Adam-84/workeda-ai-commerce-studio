// Vrai CLI dans MXC ; fournisseur HTTP fictif, aucune authentification réelle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve, sep } from 'node:path';
import { resolveCodex } from '../src/codex-runner.js';

test('Job Object Windows : limite de processus et arrêt à la fermeture, processus fictifs', { timeout: 20_000 }, async t => {
  if (process.platform !== 'win32') return t.skip('Job Objects Win32 indisponibles sur cette plateforme.');
  const base = resolve(process.env.SystemRoot, 'Temp'), root = mkdtempSync(join(base, 'archipel-job-proof-'));
  const witness = join(root, 'witness.json'), script = join(root, 'child.cjs');
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot, TEMP: root, TMP: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root };
  t.after(() => { assert.equal(dirname(root), base); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 }); });
  writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(witness)},String(process.pid));setInterval(()=>{},1000);`);
  const file = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('test/fixtures/codex-job-probe.ps1'), '-NodePath', process.execPath, '-ChildScript', script, '-Witness', witness];
  const r = await new Promise((done, reject) => {
    const c = spawn(file, args, { cwd: root, env, windowsHide: true, shell: false });
    let out = '', err = '';
    const timer = setTimeout(() => { c.kill(); }, 15_000);
    c.stdout.on('data', b => out += b); c.stderr.on('data', b => err += b);
    c.on('error', reject); c.on('close', code => { clearTimeout(timer); done({ code, out, err }); });
  });
  t.diagnostic(JSON.stringify({ kind: 'JOB_PROOF', command: [file, ...args].map(x => x.replace(process.env.USERPROFILE, '%USERPROFILE%')), cwd: root, environmentNames: Object.keys(env), ...r }));
  assert.equal(r.code, 0, r.err);
  const limits = JSON.parse(r.out.split(/\r?\n/).find(x => x.startsWith('JOB_LIMITS ')).slice(11));
  const pids = JSON.parse(r.out.split(/\r?\n/).find(x => x.startsWith('JOB_WITNESS ')).slice(12));
  assert.equal(limits.flags & 0x2208, 0x2208); assert.equal(limits.activeProcesses, 2); assert.equal(limits.jobMemory, 1024 * 1024 * 1024);
  assert.ok(pids.thirdError, 'la troisième association doit être refusée par la limite active');
  for (const pid of [pids.first, pids.second]) assert.throws(() => process.kill(pid, 0), `PID ${pid} arrêté par fermeture du job`);
});

test('client complet MXC : racines explicites et fournisseur exclusivement local', { timeout: 180_000 }, async t => {
  if (process.platform !== 'win32') return t.skip('MXC exige Windows natif.');
  let cli;
  try { cli = resolveCodex(); } catch { return t.skip('CLI Codex absent.'); }
  const base = resolve(process.env.SystemRoot, 'Temp');
  const root = mkdtempSync(join(base, 'archipel-client-proof-'));
  const work = join(root, 'work'), home = join(root, 'home'), outside = join(root, 'outside');
  for (const p of [work, home, outside]) mkdirSync(p);
  const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot,
    HOME: home, USERPROFILE: home, CODEX_HOME: home, APPDATA: home, LOCALAPPDATA: home,
    TEMP: home, TMP: home, ARCHIPEL_FAKE_AUTH: 'FICTIF-SANS-VALEUR' };
  const records = [], requests = [], files = () => readdirSync(root, { recursive: true }).filter(x => !x.startsWith('home\\schema\\')).sort();
  const trap = join(outside, 'trap.txt');
  writeFileSync(trap, 'FAUX-SECRET-DE-TEST');
  writeFileSync(join(work, 'allowed.txt'), 'TEMOIN');
  writeFileSync(join(work, 'AGENTS.md'), 'PIEGE_AGENT : instruction fictive à ne pas charger.');
  mkdirSync(join(home, 'skills', 'fictif'), { recursive: true });
  writeFileSync(join(home, 'skills', 'fictif', 'SKILL.md'), '---\nname: fictif\ndescription: PIEGE_SKILL\n---\nPIEGE_SKILL');
  const mcpMarker = join(home, 'mcp-ran.txt');
  writeFileSync(join(home, 'fake-mcp.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(mcpMarker)},'FICTIF')`);
  t.after(() => {
    const proof = { kind: 'CLIENT_MXC_PROOF', root, environmentNames: Object.keys(env), records, requests, final: files() };
    // Les diagnostics ne contiennent aucun corps/header d'authentification et masquent les chemins personnels.
    const mask = value => typeof value === 'string' ? value.replace(/C:(?:\\+|\/+)(?:Users)(?:\\+|\/+)[^\\/\s"']+/gi, '%USERPROFILE%')
      : Array.isArray(value) ? value.map(mask) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k, mask(v)])) : value;
    t.diagnostic(JSON.stringify(mask(proof)));
    assert.equal(dirname(root), base); assert.ok(root.startsWith(base + sep));
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    assert.equal(existsSync(root), false);
  });
  async function snapshot(seed) {
    const script = `$all=@(Get-CimInstance Win32_Process);$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(${seed});do{$added=$false;foreach($p in $all){if($ids.Contains([int]$p.ParentProcessId) -and $ids.Add([int]$p.ProcessId)){$added=$true}}}while($added);$own=@($all|Where-Object{$ids.Contains([int]$_.ProcessId)}|Select-Object ProcessId,ParentProcessId,Name);$tcp=@(& '${join(env.SystemRoot, 'System32', 'netstat.exe')}' -ano -p tcp|Where-Object{$_ -match '\\s(\\d+)\\s*$' -and $ids.Contains([int]$Matches[1])});@{processes=$own;tcp=$tcp}|ConvertTo-Json -Depth 4 -Compress`;
    return new Promise((done, reject) => {
      const c = spawn(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { cwd: work, env, windowsHide: true });
      let out = ''; const timer = setTimeout(() => c.kill(), 8000);
      c.stdout.on('data', b => out += b); c.on('error', reject);
      c.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error('Inventaire de processus impossible')); else { try { done(JSON.parse(out)); } catch(e) { reject(e); } } });
    });
  }
  async function run(args, expected, timeoutMs = 12_000, input = '') {
    const before = files(), start = Date.now();
    const r = await new Promise((done, reject) => {
      const child = spawn(cli.file, [...cli.args, ...args], { cwd: work, env, shell: false, windowsHide: true });
      let out = '', err = '', bytes = 0, stopped = false;
      const stop = () => { if (stopped) return; stopped = true;
        const k = spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' });
        k.on('error', reject);
      };
      const timer = setTimeout(stop, timeoutMs);
      const observation = timeoutMs === 5000 ? new Promise((done, reject) => setTimeout(() => snapshot(child.pid).then(done, reject), 800)) : Promise.resolve(null);
      observation.catch(reject);
      for (const [s, append] of [[child.stdout, x => out += x], [child.stderr, x => err += x]]) s.on('data', b => {
        bytes += b.length; if (bytes > 300_000) stop(); else append(b.toString());
      });
      child.stdin.on('error', () => {}); child.stdin.end(input);
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', async code => { clearTimeout(timer); done({ code, out, err, stopped, pid: child.pid, snapshot: await observation }); });
    });
    records.push({ command: [cli.file, ...cli.args, ...args], cwd: work, expected, ...r, durationMs: Date.now() - start, before, after: files() });
    return r;
  }
  const sandbox = (profile, command) => ['-c', 'windows.sandbox="mxc"', 'sandbox', '-P', profile, '--', ...command];
  const ps = join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = join(env.SystemRoot, 'System32', 'cmd.exe');
  const ready = await run(sandbox(':read-only', [cmd, '/d', '/c', 'echo MXC_READY']), 'MXC disponible');
  if (ready.code !== 0) {
    assert.equal(ready.stopped, false);
    if (/mxc|unsupported|not available|not supported|policy|capabilit/i.test(ready.err)) return t.skip(`MXC indisponible : ${ready.err.slice(-400)}`);
    assert.fail(ready.err);
  }
  const server = createServer((req, res) => {
    const destination = new URL(req.url, `http://127.0.0.1:${server.address().port}`);
    if (destination.hostname !== '127.0.0.1' || destination.port !== String(server.address().port)) {
      requests.push({ rejected: true, host: destination.hostname }); res.writeHead(403).end(); return;
    }
    let body = ''; req.on('data', b => { body += b; if (body.length > 250_000) req.destroy(); });
    req.on('end', () => {
      requests.push({ path: destination.pathname, method: req.method, bytes: body.length });
      res.end('LOCAL_WITNESS');
    });
  });
  server.on('connect', (req, socket) => { requests.push({ rejectedConnect: true }); socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = server.address().port;
  let forbiddenHits = 0;
  const forbidden = createServer((req, res) => { res.end(); });
  forbidden.on('connection', () => forbiddenHits++);
  await new Promise(done => forbidden.listen(0, '127.0.0.1', done));
  t.after(() => { forbidden.closeAllConnections(); forbidden.close(); });
  const forbiddenPort = forbidden.address().port;
  let otherHostHits = 0;
  const otherHost = createServer((req, res) => res.end());
  otherHost.on('connection', () => otherHostHits++);
  await new Promise((done, reject) => { otherHost.once('error', reject); otherHost.listen(0, '127.0.0.2', done); });
  t.after(() => { otherHost.closeAllConnections(); otherHost.close(); });
  for (const p of [port, forbiddenPort]) await new Promise((done, reject) => {
    const s = connect({ host: '127.0.0.1', port: p }); s.once('error', reject); s.once('connect', () => s.destroy()); s.once('close', done);
  });
  assert.equal(forbiddenHits, 1, 'témoin positif hors sandbox : second port joignable');
  await new Promise((done, reject) => { const s = connect({ host: '127.0.0.2', port: otherHost.address().port }); s.once('error', reject); s.once('connect', () => s.destroy()); s.once('close', done); });
  assert.equal(otherHostHits, 1, 'témoin positif : autre adresse loopback joignable');
  const nodeRoot = dirname(process.execPath), cliRoot = cli.args.length ? dirname(dirname(cli.args[0])) : dirname(cli.file);
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64', triple = arch === 'arm64' ? 'aarch64' : 'x86_64';
  const native = cli.args.length ? join(cliRoot, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', `${triple}-pc-windows-msvc`, 'bin', 'codex.exe') : cli.file;
  assert.ok(existsSync(native), 'le binaire natif doit être résolu sans élargir les lectures');
  const profile = (name, minimal, network) => `
[permissions.${name}.filesystem]
":root" = "deny"
${minimal ? '":minimal" = "read"' : ''}
'${join(env.SystemRoot, 'System32')}' = "read"
'${nodeRoot}' = "read"
'${cliRoot}' = "read"
'${work}' = "read"
'${home}' = "write"
[permissions.${name}.network]
enabled = ${network}
proxy_url = "http://127.0.0.1:${port}"
[permissions.${name}.network.domains]
"127.0.0.1" = "allow"
`;
  const configText = `default_permissions="narrow"\n[mcp_servers.fictif]\nenabled=false\ncommand=${JSON.stringify(process.execPath)}\nargs=[${JSON.stringify(join(home, 'fake-mcp.cjs'))}]\n[features]\nnetwork_proxy=true\n` + profile('narrow', false, false) + profile('localproxy', false, true);
  writeFileSync(join(home, 'config.toml'), configText);
  records.push({ kind: 'synthetic-config', configText });
  const version = await run(sandbox('narrow', [native, '--version']), 'version du vrai binaire confiné sans modèle');
  assert.equal(version.code, 0, version.err);
  const payload = `const f=require('node:fs'); const r={};for(const [k,p] of ${JSON.stringify([['allowed', join(work, 'allowed.txt')], ['trap', trap]])}){try{f.readFileSync(p);r[k]='allowed'}catch(e){r[k]=e.code}};console.log('PROBE '+JSON.stringify(r));`;
  await t.test('liste blanche sans :minimal : témoin autorisé et piège frère', async () => {
    const r = await run(sandbox('narrow', [process.execPath, '-e', payload]), 'témoin lu, piège refusé');
    assert.equal(r.code, 0, r.err);
    const data = JSON.parse(r.out.split(/\r?\n/).find(x => x.startsWith('PROBE ')).slice(6));
    assert.equal(data.allowed, 'allowed'); assert.notEqual(data.trap, 'allowed');
  });
  let guardedLocal = false;
  await t.test('réseau désactivé, proxy explicite et accès loopback direct', async () => {
    const beforeHits = forbiddenHits;
    const connectProbe = (p, host = '127.0.0.1') => `const n=require('node:net');const s=n.connect({host:${JSON.stringify(host)},port:${p}});s.setTimeout(1000);for(const ev of ['connect','error','timeout'])s.on(ev,e=>{console.log('NET '+(e?.code||ev));s.destroy()});`;
    for (const p of ['narrow', 'localproxy']) {
      const r = await run(sandbox(p, [process.execPath, '-e', connectProbe(port)]), 'mesure du réseau sans destination externe');
      assert.equal(r.code, 0, r.err);
      if (p === 'narrow') assert.ok(!r.out.includes('NET connect'), r.out);
    }
    const r = await run(sandbox('localproxy', [process.execPath, '-e', connectProbe(forbiddenPort)]), 'connexion directe hors endpoint proxy refusée');
    assert.equal(r.code, 0, r.err);
    guardedLocal = !r.out.includes('NET connect') && forbiddenHits === beforeHits;
    assert.equal(r.out.includes('NET connect'), forbiddenHits > beforeHits, 'résultat socket confirmé par le serveur témoin');
    const beforeOtherHost = otherHostHits;
    const h = await run(sandbox('localproxy', [process.execPath, '-e', connectProbe(otherHost.address().port, '127.0.0.2')]), 'hôte loopback non autorisé refusé');
    assert.equal(h.code, 0, h.err);
    assert.equal(h.out.includes('NET connect'), otherHostHits > beforeOtherHost);
    guardedLocal &&= !h.out.includes('NET connect');
    records.push({ kind: 'network-preflight', guardedLocal, forbiddenHits: forbiddenHits - beforeHits, otherHostHits: otherHostHits - beforeOtherHost });
  });
  await t.test('catalogue et appels forcés : précondition réseau requise', st => {
    st.skip(guardedLocal ? 'Frontière modifiée : revalider le filtrage avant une sonde fournisseur.' : 'Proxy contournable : catalogue et outils forcés non prouvables sans ouvrir le réseau du client.');
  });
  await t.test('client réel imbriqué sans réseau : fournisseur local et aucun repli', async () => {
    const args = ['exec', '--json', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-c', 'windows.sandbox="mxc"',
      '-c', 'model_provider="archipel_fictif"', '-c', 'model="gpt-5.4"', '-c', 'approval_policy="never"',
      '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'web_search="disabled"',
      '-c', 'project_doc_max_bytes=0', '-c', 'skills.bundled.enabled=false', '-c', 'skills.include_instructions=false',
      ...['hooks', 'plugins', 'shell_tool', 'unified_exec', 'skill_search', 'skill_mcp_dependency_install', 'multi_agent', 'view_image'].flatMap(x => ['--disable', x]),
      '-c', 'model_providers.archipel_fictif.name="Sonde locale"',
      '-c', `model_providers.archipel_fictif.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.archipel_fictif.env_key="ARCHIPEL_FAKE_AUTH"',
      '-c', 'model_providers.archipel_fictif.wire_api="responses"',
      '-c', 'model_providers.archipel_fictif.requires_openai_auth=false',
      '-c', 'model_providers.archipel_fictif.request_max_retries=0',
      '-c', 'model_providers.archipel_fictif.stream_max_retries=0',
      'Sonde fictive, réponds OK.'];
    const before = requests.length;
    const r = await run(sandbox('narrow', [native, ...args]), 'client démarre ; attente réseau local coupée par timeout borné', 5000);
    assert.equal(r.stopped, true, 'le client réessaie malgré request_max_retries=0 ; arrêt explicite attendu');
    assert.notEqual(r.code, 0);
    assert.equal(requests.length, before);
    assert.ok(r.out.includes('thread.started'), r.out + r.err);
    assert.ok(/Connection failed|network/.test(r.out), r.out);
    assert.throws(() => process.kill(r.pid, 0), 'lanceur arrêté');
    assert.ok(r.snapshot.processes.some(x => x.Name === 'codex.exe'), 'vrai client observé avant arrêt');
    for (const p of r.snapshot.processes) assert.throws(() => process.kill(p.ProcessId, 0), `PID ${p.ProcessId} arrêté`);
    const after = await snapshot(r.pid); records.push({ kind: 'after-tree-stop', snapshot: after });
    assert.deepEqual(after.processes, []); assert.deepEqual(after.tcp, []);
  });
  await t.test('schéma app-server local sous MXC sans réseau', async () => {
    const out = join(home, 'schema');
    const r = await run(sandbox('narrow', [native, 'app-server', 'generate-json-schema', '--experimental', '--out', out]), 'schémas locaux expérimentaux sans authentification ni tour');
    assert.equal(r.code, 0, r.err);
    records.push({ kind: 'schema-files', count: readdirSync(out, { recursive: true }).length, files: readdirSync(out, { recursive: true }).filter(x => /ThreadStart|SandboxState|ReadOnly|RateLimit|Initialize|FsRead|FsWrite/.test(x)) });
    for (const name of ['v2/ThreadStartParams.json', 'v2/TurnStartParams.json', 'v2/GetAccountRateLimitsResponse.json', 'v2/FsReadFileParams.json', 'v2/FsWriteFileParams.json']) {
      if (existsSync(join(out, name))) {
        const s = JSON.parse(readFileSync(join(out, name), 'utf8'));
        records.push({ kind: 'schema', name, properties: s.properties,
          definitions: Object.fromEntries(Object.entries(s.definitions || {}).filter(([k]) => /SandboxPolicy|ReadOnly|FileSystem/.test(k))) });
      }
    }
  });
  await t.test('app-server stdio : initialize et thread/start sans tour ni compte', async () => {
    const args = sandbox('narrow', [native, '-c', 'windows.sandbox="mxc"', '-c', 'analytics.enabled=false', '-c', 'feedback.enabled=false', '-c', 'project_doc_max_bytes=0',
      '-c', 'model_provider="archipel_fictif"', '-c', 'model_providers.archipel_fictif.name="Sonde locale"',
      '-c', `model_providers.archipel_fictif.base_url="http://127.0.0.1:${port}/v1"`,
      '-c', 'model_providers.archipel_fictif.env_key="ARCHIPEL_FAKE_AUTH"',
      '-c', 'model_providers.archipel_fictif.requires_openai_auth=false',
      '-c', 'skills.bundled.enabled=false', '-c', 'skills.include_instructions=false',
      '--disable', 'hooks', '--disable', 'plugins', '--disable', 'shell_tool', 'app-server', '--stdio']);
    const messages = [], before = requests.length;
    await new Promise((done, reject) => {
      const child = spawn(cli.file, [...cli.args, ...args], { cwd: work, env, shell: false, windowsHide: true });
      let buffer = '', err = '', bytes = 0, stopping = false;
      const stop = () => { if (stopping) return; stopping = true;
        const k = spawn(join(env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { env, windowsHide: true, stdio: 'ignore' }); k.on('error', reject);
      };
      const timer = setTimeout(stop, 12_000);
      const send = x => child.stdin.write(JSON.stringify(x) + '\n');
      child.stdin.on('error', () => {});
      send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'archipel-proof', version: '0' }, capabilities: { experimentalApi: true } } });
      child.stdout.on('data', b => {
        bytes += b.length; if (bytes > 300_000) { stop(); return; }
        buffer += b;
        let i; while ((i = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          let msg; try { msg = JSON.parse(line); } catch { continue; }
          messages.push(msg);
          if (msg.id === 1) {
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'thread/start', params: { cwd: work, model: 'gpt-5.4', modelProvider: 'archipel_fictif', approvalPolicy: 'never', permissions: 'narrow', dynamicTools: [], ephemeral: true } });
          }
          if (msg.id === 2) send({ id: 3, method: 'codex/sandbox-state', params: { threadId: msg.result?.thread?.id } });
          if (msg.id === 3) send({ id: 4, method: 'fs/readFile', params: { path: join(work, 'allowed.txt') } });
          if (msg.id === 4) send({ id: 5, method: 'fs/readFile', params: { path: trap } });
          if (msg.id === 5) send({ id: 6, method: 'fs/writeFile', params: { path: join(outside, 'client-write.txt'), dataBase64: Buffer.from('FICTIF').toString('base64') } });
          if (msg.id === 6) send({ id: 7, method: 'fs/writeFile', params: { path: join(home, 'client-write.txt'), dataBase64: Buffer.from('FICTIF').toString('base64') } });
          if (msg.id === 7) send({ id: 8, method: 'fs/writeFile', params: { path: join(work, 'client-write.txt'), dataBase64: Buffer.from('FICTIF').toString('base64') } });
          if (msg.id === 8) stop();
        }
      });
      child.stderr.on('data', b => { bytes += b.length; if (bytes > 300_000) stop(); else err += b; });
      child.on('error', reject);
      child.on('close', code => { clearTimeout(timer); records.push({ command: [cli.file, ...cli.args, ...args], cwd: work, kind: 'app-server-rpc', messages, err, code }); done(); });
    });
    assert.ok(messages.find(x => x.id === 1)?.result, 'initialize doit répondre');
    const thread = messages.find(x => x.id === 2);
    assert.ok(thread?.result, JSON.stringify(messages));
    assert.deepEqual(thread.result.instructionSources, []);
    assert.ok(messages.find(x => x.id === 4)?.result, 'le client doit lire le témoin autorisé');
    for (const id of [5, 6, 8]) {
      assert.ok(/denied|refusé|os error 5|permission/i.test(messages.find(x => x.id === id)?.error?.message || ''), JSON.stringify(messages.find(x => x.id === id)));
    }
    assert.ok(messages.find(x => x.id === 7)?.result, 'écriture dans HOME dédié nécessaire au client');
    assert.equal(existsSync(join(outside, 'client-write.txt')), false);
    assert.equal(existsSync(join(work, 'client-write.txt')), false);
    assert.equal(existsSync(join(home, 'client-write.txt')), true);
    assert.equal(existsSync(mcpMarker), false, 'le faux MCP désactivé ne doit pas démarrer');
    records.push({ kind: 'thread-verdict', created: !!thread?.result, reason: thread?.error?.message });
    assert.equal(requests.length, before, 'aucune requête fournisseur sans turn/start');
    // account/rateLimits/read n'est jamais appelé : peut utiliser le réseau d'authentification.
  });
});
