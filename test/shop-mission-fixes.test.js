// Correctifs issus de la mission de validation réelle (Lucas, catalogue Workeda) : relevé complet dans le prompt, source du même site reconnue.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogPrompt, SHOP_LIMITS } from '../src/shop-readonly.js';
import { evaluateResult, parseAgentOutput } from '../src/comm-core.js';
import { sourceLine, levelLabel } from '../public/comm-view.js';

const product = (i, extra = {}) => ({ id: String(i), title: `Série ${i} — Tapis de souris XXL en laine premium édition limitée numéro ${i}`, handle: `serie-${i}-tapis-de-souris-xxl-laine-premium`, vendor: 'W', type: '', tags: ['bureau', 'tapis', 'laine', 'gaming', 'x'], status: 'active', priceMin: 19.9, priceMax: 49.9, currency: null, available: true, images: 6, descChars: 1400, desc: 'd', seoTitle: '', updatedAt: null, url: `https://workeda.com/products/serie-${i}`, ...extra });
const snap = (n) => ({ domain: 'workeda.com', fetchedAt: '2026-11-21T20:38:18.320Z', mode: 'public', collections: Array.from({ length: 13 }, (_, i) => ({ title: `Collection numéro ${i} du bureau ergonomique`, handle: `collection-${i}`, count: i })), errors: [], products: Array.from({ length: n }, (_, i) => product(i)) });

test('F1. les 38 produits réels tiennent en entier dans le prompt, sans coupure silencieuse', () => {
  const t = catalogPrompt(snap(38));
  assert.ok(t.length < SHOP_LIMITS.promptChars + 300, `${t.length} caractères`);
  for (let i = 0; i < 38; i += 1) assert.match(t, new RegExp(`serie-${i}-tapis`), `produit ${i} listé`);
  assert.doesNotMatch(t, /NON listé/);
  assert.match(t, /adresse d'un produit = https:\/\/workeda\.com\/products\/‹identifiant›/);
  assert.equal((t.match(/<\/donnees-non-fiables>/g) ?? []).length, 1);
  assert.ok(t.trimEnd().endsWith('</donnees-non-fiables>'), 'le bloc est refermé par le Studio, pas coupé');
});

test('F1b. un catalogue trop grand est tronqué PROPREMENT et l’audit partiel est annoncé', () => {
  const t = catalogPrompt(snap(200));
  assert.match(t, /ATTENTION : \d+ produit\(s\) NON listé\(s\) faute de place/);
  const lines = t.split('\n').filter((l) => l.startsWith('- '));
  assert.ok(lines.length > 38 && lines.length < 200);
  assert.ok(lines.every((l) => l.split(' | ').length === 8), 'aucune ligne coupée en son milieu');
  assert.ok(t.trimEnd().endsWith('</donnees-non-fiables>'));
});

const task = { kind: 'work', requiresSources: true };
const provided = ['https://workeda.com/collections.json', 'https://workeda.com/products.json'];
const out = (url, observed = { provided }) => evaluateResult({ task, parsed: parseAgentOutput(JSON.stringify({ report: 'Audit.', sources: [{ label: 'Relevé', url }] })), observed });

test('F2. une source du même site que le relevé fourni est « fournie par le Studio », jamais une consultation', () => {
  for (const url of ['https://workeda.com', 'https://workeda.com/products/serie-1', 'https://www.workeda.com/collections/x', provided[0]]) {
    const r = out(url);
    assert.equal(r.verified, true, url); assert.equal(r.level, 'provided', url); assert.equal(r.sources[0].provided, true);
    assert.match(r.verification, /non consultée\(s\) par l'agent lui-même/); assert.match(r.verification, /à relire/);
  }
  assert.equal(out('https://evil.example/workeda.com').verified, false, 'un autre site n’est pas confirmé');
  assert.equal(out('https://workeda.com.evil.example/').verified, false, 'ni un domaine qui commence pareil');
  assert.equal(out('https://workeda.com', { provided: [] }).verified, false, 'sans relevé fourni, aucune source n’est confirmée');
});

test('F2b. une vraie consultation garde le niveau « observé » même si un relevé est fourni', () => {
  const r = out('https://example.com/etude', { fetched: ['https://example.com/etude'], provided });
  assert.equal(r.level, 'observed'); assert.equal(r.sources[0].provided, false);
});

test('F2c. affichage : la source fournie est marquée comme telle', () => {
  assert.match(sourceLine({ label: 'Relevé', url: 'https://workeda.com', checked: true, provided: true }), /✔ relevé fourni par le Studio/);
  assert.match(levelLabel('provided'), /non consulté par l’agent/);
});
