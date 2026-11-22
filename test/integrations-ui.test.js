import { test } from 'node:test';
import assert from 'node:assert/strict';
import { integrationsCenter } from '../public/integrations-ui.js';

// DOM minimal : observe le focus et les annonces du contrôleur, sans bibliothèque.
function element(tagName, attrs = {}, ...children) {
  const el = { tagName: tagName.toUpperCase(), ...attrs, childNodes: [], parentNode: null, textContent: '',
    replaceChildren(...nodes) { this.childNodes = nodes; for (const n of nodes) if (typeof n === 'object') n.parentNode = this; },
    contains(node) { return node === this || this.childNodes.some((n) => typeof n === 'object' && n.contains(node)); },
    focus() { document.activeElement = this; } };
  el.replaceChildren(...children.flat(Infinity).filter((n) => n != null && n !== false));
  return el;
}
const find = (el, pred) => pred(el) ? el : el.childNodes.filter((n) => typeof n === 'object').map((n) => find(n, pred)).find(Boolean);

test('interface : le rafraîchissement conserve le focus et le résultat réel reste annoncé', async (t) => {
  globalThis.document = { activeElement: null };
  t.after(() => { delete globalThis.document; });
  let refresh, leave, loads = 0;
  t.mock.method(globalThis, 'setInterval', (fn) => { refresh = fn; return 1; });
  t.mock.method(globalThis, 'clearInterval', () => {});
  const announcements = [];
  const card = { id: 'dsers', label: 'DSers', state: 'authenticated', kind: 'mcp', auth: '', plan: '', realNetworkAllowed: true,
    storage: { available: true }, flags: { authenticated: true, configured: true }, permissions: { allowedTools: [], deniedTools: [] }, reasons: [], grants: [],
    quota: { cap: 100, remaining: 99 }, settings: { dailyCap: 100, shipCountry: 'FR' }, snapshots: [], recentErrors: [], lastTest: {}, lastSync: {} };
  const root = integrationsCenter({ setLeave: (fn) => { leave = fn; }, ui: { h: element, announce: (s) => announcements.push(s),
    get: async () => { loads += 1; return { cards: [card], agents: [], realNetworkAllowed: true, storage: { available: true } }; },
    send: async () => ({ result: { ok: false, error: 'Quota atteint' } }) } });
  await new Promise(setImmediate);
  const button = find(root, (e) => e.tagName === 'BUTTON' && e.childNodes.includes('Actualiser les données'));
  button.focus(); refresh(); await new Promise(setImmediate);
  assert.equal(loads, 1, 'pas de reconstruction automatique pendant la navigation au clavier');
  await button.onclick();
  assert.ok(root.contains(document.activeElement), 'focus conservé dans le panneau après action');
  assert.match(find(root, (e) => e.role === 'status').textContent, /échouée.*Quota atteint/);
  assert.ok(announcements.some((s) => /échouée.*Quota atteint/.test(s)));
  leave();
});
test('interface : échec de test HTTP200 et relevé Admin différé sont annoncés honnêtement', async t => {
  globalThis.document = { activeElement: null };
  t.after(() => { delete globalThis.document; });
  t.mock.method(globalThis, 'setInterval', () => 1); t.mock.method(globalThis, 'clearInterval', () => {});
  const announcements = [];
  const old = { id: 'track17', label: '17TRACK', state: 'authenticated', realNetworkAllowed: true, storage: { available: true }, flags: { authenticated: true, configured: true }, permissions: { allowedTools: [], deniedTools: [] }, reasons: [], grants: [], quota: { cap: 100, remaining: 99 }, settings: { dailyCap: 100 }, snapshots: [], recentErrors: [], lastTest: {}, lastSync: {} };
  const admin = { id: 'shopify_admin', label: 'Shopify Admin', provenance: 'Shopify Admin', stateLabel: 'Authentifié', local: true, flags: { authenticated: true }, settings: {}, grants: [], snapshots: [] };
  const root = integrationsCenter({ ui: { h: element, announce: s => announcements.push(s), get: async () => ({ cards: [old, admin], agents: [], realNetworkAllowed: true, storage: { available: true } }),
    send: async (_method, url) => url.endsWith('/test') ? { lastTest: { ok: false, error: 'Accès refusé' } } : { skipped: 'Attendre la fin de la pause fournisseur.' } } });
  await new Promise(setImmediate);
  const button = find(root, e => e.tagName === 'BUTTON' && e.childNodes.includes('Tester la connexion'));
  await button.onclick();
  assert.ok(announcements.some(s => /Accès refusé/.test(s)));
  const refresh = find(root, e => e.tagName === 'BUTTON' && e.childNodes.includes('Actualiser Shopify Admin'));
  await refresh.onclick();
  assert.ok(announcements.some(s => /Attendre la fin/.test(s)));
});
