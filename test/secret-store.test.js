// Stockage des secrets : jamais en clair, DPAPI réel sous Windows (valeur factice), abstraction Linux/cloud, masquage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretStore, dpapiProtector, aesProtector, testProtector, defaultProtector, scrubSecrets, hasSecretShape } from '../src/secret-store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'archipel-secrets-'));
const FAKE = 'faux-jeton-de-test-0123456789-ABCDEF';

test('aller-retour avec le protecteur de test : jamais de texte lisible sur le disque', () => {
  const dir = tmp(), s = createSecretStore({ dir, protector: testProtector() });
  s.set('dsers.tokens', { access: FAKE, refresh: `${FAKE}-r` });
  assert.deepEqual(s.get('dsers.tokens', { json: true }), { access: FAKE, refresh: `${FAKE}-r` });
  assert.equal(s.has('dsers.tokens'), true); assert.deepEqual(s.names(), ['dsers.tokens']);
  const raw = readFileSync(join(dir, 'dsers.tokens.secret'), 'utf8');
  assert.ok(!raw.includes(FAKE), 'le fichier ne contient pas le secret en clair');
  assert.equal(s.get('absent'), null);
  assert.equal(s.delete('dsers.tokens'), true); assert.equal(s.has('dsers.tokens'), false); assert.equal(s.delete('dsers.tokens'), false);
});

test('noms et tailles contrôlés', () => {
  const s = createSecretStore({ dir: tmp(), protector: testProtector() });
  for (const n of ['../evil', 'A B', '', 'x'.repeat(80), '.cache']) assert.throws(() => s.set(n, 'v'), /Nom de secret invalide/, JSON.stringify(n));
  assert.throws(() => s.set('ok', ''), /vide/); assert.throws(() => s.set('ok', 'x'.repeat(20_000)), /trop volumineux/);
});

test('sans protecteur : INDISPONIBLE, jamais de repli en clair', () => {
  const dir = tmp(), s = createSecretStore({ dir, protector: aesProtector(undefined) });
  assert.equal(s.info().available, false); assert.equal(s.info().plaintextFallback, false);
  assert.throws(() => s.set('x', 'y'), /Stockage sécurisé indisponible/);
  assert.equal(readdirSync(dir).length, 0);
  assert.equal(createSecretStore({ dir: null, protector: testProtector() }).info().available, false);
});

test('AES-256-GCM (Linux / cloud) : clé d’environnement, altération détectée, mauvaise clé refusée', () => {
  const dir = tmp(), key = 'une-cle-de-trente-deux-caracteres-minimum!';
  const s = createSecretStore({ dir, protector: aesProtector(key) });
  assert.equal(s.info().backend, 'aes-gcm');
  s.set('track17.key', FAKE);
  assert.equal(s.get('track17.key'), FAKE);
  assert.ok(!readFileSync(join(dir, 'track17.key.secret'), 'utf8').includes(FAKE));
  assert.throws(() => createSecretStore({ dir, protector: aesProtector('une-autre-cle-de-trente-deux-caracteres!') }).get('track17.key'), /Secret illisible/);
  assert.equal(aesProtector('trop-court').available, false);
});

test('DPAPI réel sous Windows (valeur factice) : chiffré, non lisible, relisible dans la même session', { skip: process.platform !== 'win32' }, () => {
  const dir = tmp(), s = createSecretStore({ dir, protector: dpapiProtector() });
  assert.equal(s.info().backend, 'dpapi'); assert.equal(s.info().available, true);
  s.set('dsers.tokens', { access: FAKE });
  assert.deepEqual(s.get('dsers.tokens', { json: true }), { access: FAKE });
  const raw = readFileSync(join(dir, 'dsers.tokens.secret'), 'utf8');
  assert.ok(!raw.includes(FAKE) && !raw.includes('access'), 'blob DPAPI opaque');
  s.set('multi', `ligne un\nligne "deux" é ü € ' $x`);
  assert.equal(s.get('multi'), `ligne un\nligne "deux" é ü € ' $x`, 'caractères spéciaux préservés');
});

test('le texte clair ne passe pas par la ligne de commande de PowerShell', () => {
  const seen = [];
  const p = dpapiProtector({ run: (cmd, args, opts) => { seen.push({ args, input: opts.input }); return 'blob'; } });
  p.protect(FAKE);
  assert.ok(seen[0].args.every((a) => !a.includes(FAKE)), 'absent des arguments');
  assert.equal(seen[0].input, FAKE, 'transmis par l’entrée standard');
});

test('échec DPAPI : aucune sortie du sous-processus ni entrée secrète dans l’erreur', () => {
  const p = dpapiProtector({ run: () => { throw new Error(`échec : ${FAKE}`); } });
  assert.throws(() => p.protect(FAKE), (e) => !e.message.includes(FAKE));
});

test('protecteur par défaut : Windows → DPAPI ; sinon clé d’environnement', () => {
  const p = defaultProtector({ ARCHIPEL_SECRET_KEY: 'x'.repeat(40) });
  assert.equal(p.id, process.platform === 'win32' ? 'dpapi' : 'aes-gcm');
});

test('masquage des secrets dans les messages, journaux et prompts', () => {
  const shopifyFake = ['shpat', 'abcdef0123456789'].join('_');
  const dirty = `Échec : Authorization: Bearer abc123DEF456ghi789 ; "access_token":"zzzzzzzzzz1234" ; 17token: ABCDEF1234567890 ; ${shopifyFake} ; eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJl`;
  const clean = scrubSecrets(dirty);
  for (const leak of ['abc123DEF456ghi789', 'zzzzzzzzzz1234', 'ABCDEF1234567890', shopifyFake, 'eyJhbGciOiJIUzI1NiJ9', 'c2lnbmF0dXJl']) assert.ok(!clean.includes(leak), leak);
  assert.match(clean, /\[secret\]/);
  assert.equal(scrubSecrets('Aucun secret ici : 42 produits.'), 'Aucun secret ici : 42 produits.');
  assert.equal(hasSecretShape('Bearer abcdefghijkl'), true); assert.equal(hasSecretShape('bonjour'), false);
  assert.ok(existsSync(tmp()));
});
