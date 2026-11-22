// Integration Center : état réel de DSers et 17TRACK (lecture seule), permissions, quotas, dernières synchronisations, accès par agent, révocation.
// Réutilise les briques de app.js (h, get, send, announce) et les classes existantes (skill-row, chip, note, err). Aucun secret n'est jamais affiché.
import { stateInfo, quotaLine, quotaRatio, lastLine, snapshotLine, grantCandidates, actionsFor, revokeText, dateFr } from './integrations-view.js';

const enc = encodeURIComponent;
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));

export function integrationsCenter({ ui, setLeave = () => {} }) {
  const { h, get, send, announce } = ui;
  const root = h('div', { class: 'integrations-center' });
  const status = h('p', { class: 'note', role: 'status' }), err = h('p', { class: 'err', role: 'alert' });
  let data = null, busy = false, importPreview = null;
  const interacting = () => root.contains(document.activeElement);

  async function load() {
    try { data = await get('/api/integrations'); draw(); } catch (x) { put(root, h('p', { class: 'err', role: 'alert' }, x.message)); }
  }
  async function act(label, fn) {
    if (busy) return; busy = true; err.textContent = ''; status.textContent = `${label}…`;
    try { const r = await fn(); if (status.textContent === `${label}…`) status.textContent = `${label} : terminé`; announce(status.textContent); return r; }
    catch (x) { status.textContent = ''; err.textContent = x.message; announce(x.message); }
    finally { busy = false; await load(); }
  }

  function permissions(c) {
    const p = c.permissions;
    return h('details', {}, h('summary', {}, `Permissions : lecture seule (${p.allowedTools.length} outil${p.allowedTools.length > 1 ? 's' : ''} autorisé${p.allowedTools.length > 1 ? 's' : ''}, ${p.deniedToolsCount} refusé${p.deniedToolsCount > 1 ? 's' : ''})`),
      h('p', { class: 'note' }, p.note),
      p.requestedScopes?.length ? h('p', { class: 'note' }, `Portées demandées : ${p.requestedScopes.join(', ')}.`) : null,
      p.grantedScopes?.length ? h('p', { class: 'note' }, `Portées accordées par le service : ${p.grantedScopes.join(', ')}.`) : null,
      h('p', { class: 'note' }, `Autorisés : ${p.allowedTools.join(', ')}.`),
      h('p', { class: 'note' }, `Refusés (écriture, commande, paiement, publication, suppression, facturation…) : ${p.deniedTools.length} outils, jamais appelés.`));
  }

  function grants(c) {
    const cand = grantCandidates(c, data.agents), pick = h('select', { 'aria-label': `Donner l’accès en lecture à ${c.label}` }, h('option', { value: '' }, 'Choisir un agent…'),
      cand.map((a) => h('option', { value: a.slug }, `${a.name}${a.suggested ? ` — suggéré : ${a.why}` : ''}`)));
    return h('div', {}, h('h4', {}, 'Accès par agent (aucun par défaut)'),
      c.grants.length ? h('ul', { class: 'skill-list' }, c.grants.map((g) => h('li', { class: 'skill-row' }, h('div', {}, h('strong', {}, g.agent), h('p', { class: 'note' }, `Lecture seule depuis le ${dateFr(g.grantedAt)}`)),
        h('button', { type: 'button', 'aria-label': `Retirer l’accès de ${g.agent}`, onclick: () => act('Accès retiré', () => send('POST', `/api/integrations/${enc(c.id)}/grants/${enc(g.agent)}/revoke`, {})) }, 'Retirer'))))
        : h('p', { class: 'note' }, 'Aucun agent n’a accès : leurs tâches ne reçoivent aucune donnée de ce service.'),
      h('div', { class: 'skill-chips' }, pick, h('button', { type: 'button', onclick: () => { if (pick.value) act('Accès accordé', () => send('POST', `/api/integrations/${enc(c.id)}/grants`, { agent: pick.value })); } }, 'Accorder la lecture')));
  }

  function settings(c) {
    const cap = h('input', { type: 'number', min: '1', max: '2000', value: String(c.settings.dailyCap), 'aria-label': `Plafond quotidien d’appels ${c.label}`, style: 'width:6em' });
    const plan = c.id === 'dsers' ? h('select', { 'aria-label': 'Plan DSers déclaré localement', value: c.settings.plan }, ['unknown', 'basic', 'advanced', 'pro', 'enterprise'].map((v) => h('option', { value: v, selected: v === c.settings.plan }, v === 'unknown' ? 'Inconnu' : v === 'basic' ? 'Basic' : v[0].toUpperCase() + v.slice(1)))) : null;
    const country = c.id === 'dsers' ? h('input', { maxlength: 2, value: c.settings.shipCountry, 'aria-label': 'Pays de livraison pour les frais d’expédition', style: 'width:3em' }) : null;
    return h('div', { class: 'skill-chips' }, plan && h('label', {}, 'Plan DSers (déclaré) ', plan), h('label', {}, 'Plafond d’appels par jour ', cap), country && h('label', {}, ' Pays d’expédition ', country),
      h('button', { type: 'button', onclick: () => act('Réglages enregistrés', () => send('POST', `/api/integrations/${enc(c.id)}/settings`, { dailyCap: Number(cap.value), ...(plan ? { plan: plan.value } : {}), ...(country ? { shipCountry: country.value.toUpperCase() } : {}) })) }, 'Enregistrer'));
  }

  function keyForm(c) {
    const input = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Clé API 17TRACK déjà existante', placeholder: 'Clé 17TRACK existante' });
    const f = h('form', { class: 'skill-chips', onsubmit: (e) => { e.preventDefault(); const key = input.value; input.value = ''; act('Clé enregistrée', () => send('POST', `/api/integrations/${enc(c.id)}/key`, { key, confirm: true })); } },
      input, h('button', { type: 'submit' }, 'Enregistrer la clé'));
    return h('div', {}, f, h('p', { class: 'note' }, 'La clé est chiffrée sur cet ordinateur et n’est jamais réaffichée. Archipel ne crée aucun compte, n’active aucun essai et n’enregistre aucun numéro de suivi.'));
  }

  function runAction(c, a) {
    if (a.id === 'connect') return act('Connexion DSers', async () => {
      if (!confirm('Ouvrir la page de connexion DSers ? Archipel demandera uniquement des portées de lecture (boutiques, produits, fournisseurs, commandes, suivi, plan).')) return;
      const r = await send('POST', `/api/integrations/${enc(c.id)}/connect`, { confirm: true });
      window.open(r.authorizationUrl, '_blank', 'noopener,noreferrer'); status.textContent = 'Terminez la connexion dans le nouvel onglet, puis revenez ici.';
    });
    if (a.id === 'test') return act('Test de connexion', async () => { const r = await send('POST', `/api/integrations/${enc(c.id)}/test`, {}); if (r.lastTest?.ok === false || r.flags?.unavailable) throw new Error(r.lastTest?.error || r.stateLabel || 'Test échoué.'); });
    if (a.id === 'sync') return act('Actualisation', async () => { const r = await send('POST', `/api/integrations/${enc(c.id)}/sync`, { force: false }); status.textContent = r.result.ok ? 'Données actualisées (le cache évite les appels inutiles).' : `Actualisation partielle ou échouée : ${r.result.error ?? ''}`; });
    if (a.id === 'revoke') return act('Révocation', async () => {
      if (!confirm(`${revokeText(c)}\n\nSupprimer aussi les données déjà relevées ?`) ) return;
      await send('POST', `/api/integrations/${enc(c.id)}/revoke`, { purge: true });
    });
    return null;
  }

  function importForm() {
    const input = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Fichier CSV local UTF-8' });
    const format = h('select', { 'aria-label': 'Format du fichier CSV' }, h('option', { value: 'archipel' }, 'Modèle Archipel'), h('option', { value: 'dsers' }, 'Export DSers — format à vérifier'));
    const template = h('button', { type: 'button', onclick: () => act('Modèle CSV', async () => {
      const r = await get('/api/integrations/manual_import/template');
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' }));
      const link = document.createElement('a'); link.href = url; link.download = r.filename; link.click(); URL.revokeObjectURL(url);
    }) }, 'Télécharger le modèle CSV Archipel');
    const check = h('button', { type: 'button', onclick: () => act('Validation CSV', async () => {
      importPreview = null;
      const file = input.files?.[0];
      if (!file) throw new Error('Choisissez un fichier CSV local.');
      if (file.size > 500 * 1024) throw new Error('Fichier trop volumineux (maximum 500 Ko).');
      const text = await file.text(); input.value = '';
      importPreview = await send('POST', '/api/integrations/manual_import/preview', { text, format: format.value });
      status.textContent = importPreview.ok ? 'Aperçu nettoyé validé : confirmez pour importer.' : 'Import refusé : corrigez les erreurs indiquées.';
    }) }, 'Valider et prévisualiser');
    return h('div', {}, template,
      h('p', { class: 'note' }, 'CSV UTF-8 ; ou , · 500 Ko · 5 000 lignes · 40 colonnes · 2 000 caractères par cellule. Aucun adaptateur DSers vérifié : utilisez le modèle Archipel. Colonnes clients et inconnues supprimées. Nature du coût : purchase_unit ou purchase_total ; devise ISO obligatoire avec un coût. Un coût absent reste inconnu.'),
      h('label', {}, 'Format ', format), h('label', {}, 'Fichier local ', input), check,
      importPreview && h('div', {},
        h('p', { role: 'status' }, `${importPreview.rows.length} ligne(s) valide(s). Aperçu limité à 20 lignes ; aucune donnée importée à ce stade.`),
        h('ul', {}, importPreview.errors.map((e) => h('li', { class: 'err' }, `Ligne ${e.line} : ${e.message}`))),
        h('pre', { tabindex: '0', 'aria-label': 'Aperçu des données nettoyées', style: 'max-height:20em;overflow:auto;white-space:pre-wrap' }, JSON.stringify(importPreview.rows.slice(0, 20), null, 2)),
        importPreview.ok && h('button', { type: 'button', onclick: () => act('Import CSV', async () => {
          if (!confirm('Importer atomiquement ces données nettoyées pendant 30 jours sur cet ordinateur ? Aucun accès agent automatique.')) return;
          const r = await send('POST', '/api/integrations/manual_import/commit', { previewId: importPreview.previewId, confirm: true }); importPreview = null; status.textContent = `${r.imported} ligne(s) importée(s).`;
        }) }, 'Confirmer l’import')));
  }
  function localCard(c) {
    const admin = c.id === 'shopify_admin', manual = c.id === 'manual_import';
    const orders = h('input', { type: 'checkbox', checked: Boolean(c.settings?.consent?.orders), 'aria-label': 'Autoriser séparément les commandes récentes Shopify Admin' });
    return h('section', { class: 'integration-card' }, h('h3', {}, c.label), h('span', { class: 'chip soft' }, c.stateLabel), h('p', { class: 'note' }, `Provenance : ${c.provenance} · Lecture seule`),
      (c.reasons ?? []).map((r) => h('p', { class: 'note' }, r)),
      (c.snapshots ?? []).map((r) => h('p', { class: 'note' }, snapshotLine(r))),
      manual && importForm(),
      admin && h('div', {}, h('p', { class: 'note' }, 'Accord local daté ET autorisation réseau du serveur requis. Jeton via environnement uniquement. Catalogue et stocks : read_products + read_inventory. Les commandes (read_orders, 60 jours maximum) sont une capacité séparée. Aucun compte contacté par l’enregistrement de cet accord.'),
        h('p', { class: 'note' }, `Accord : ${dateFr(c.settings?.consent?.at) || 'aucun'} · Portées vérifiées : ${(c.settings?.scopes ?? []).join(', ') || 'aucune'}`),
        h('label', { class: 'check' }, orders, ' Ajouter les commandes récentes et leurs suivis masqués (read_orders)'),
        h('button', { type: 'button', onclick: () => act('Accord Shopify Admin', async () => {
          if (!confirm(`Enregistrer votre accord local daté pour lire catalogue et stocks${orders.checked ? ', plus les commandes des 60 derniers jours' : ''} ? La connexion restera bloquée sans autorisation réseau du serveur.`)) return;
          await send('POST', '/api/integrations/shopify_admin/configure', { confirm: true, enabled: true, orders: orders.checked });
        }) }, 'Enregistrer mon accord'),
        h('button', { type: 'button', disabled: c.stateLabel === 'À configurer', onclick: () => act('Test Shopify Admin', async () => { const r = await send('POST', '/api/integrations/shopify_admin/test', {}); if (r.skipped) { status.textContent = r.skipped; return; } if (!r.ok) throw new Error((r.errors ?? []).join(' ; ') || 'Test échoué.'); }) }, 'Tester Shopify Admin'),
        h('button', { type: 'button', disabled: !c.flags?.authenticated, onclick: () => act('Relevé Shopify Admin', async () => { const r = await send('POST', '/api/integrations/shopify_admin/sync', {}); if (r.skipped) { status.textContent = r.skipped; return; } if (r.ok === false) throw new Error((r.errors ?? []).join(' ; ') || 'Relevé échoué.'); }) }, 'Actualiser Shopify Admin')),
      (admin || manual) && h('button', { type: 'button', onclick: () => act('Suppression locale', async () => {
        if (!confirm('Supprimer les données locales et retirer les accès agents de cette source ? Les sauvegardes ne sont pas effacées physiquement.')) return;
        await send('POST', `/api/integrations/${c.id}/revoke`, { purge: true }); if (manual) importPreview = null;
      }) }, admin ? 'Retirer mon accord et supprimer le cache' : 'Supprimer les imports'),
      (admin || manual) && grants(c));
  }
  function card(c) {
    if (c.local) return localCard(c);
    const st = stateInfo(c.state), acts = actionsFor(c), ratio = quotaRatio(c.quota);
    return h('section', { class: 'integration-card' },
      h('div', { class: 'skill-chips' }, h('h3', {}, c.label), h('span', { class: `chip ${st.cls}`.trim() }, c.stateLabel ?? st.label), h('span', { class: 'chip soft' }, 'Lecture seule'),),
      h('p', { class: 'note' }, `${c.kind} · ${c.auth} · ${c.plan}`), h('p', { class: 'note' }, st.help),
      h('p', { class: 'note' }, `Configuré : ${c.flags.configured ? 'oui' : 'non'} · Authentifié : ${c.flags.authenticated ? 'oui' : 'non'} · Testé : ${c.flags.tested ? 'oui' : 'non'}`),
      c.reasons.length ? h('ul', {}, c.reasons.map((r) => h('li', { class: 'note' }, r))) : null,
      permissions(c),
      h('p', { class: 'note' }, quotaLine(c.quota)), h('progress', { max: 1, value: ratio, 'aria-label': `Quota ${c.label}`, style: 'width:100%' }),
      c.settings.blockedUntil ? h('p', { class: 'err' }, `Pause demandée par le service jusqu’au ${dateFr(c.settings.blockedUntil)}.`) : null,
      h('p', { class: 'note' }, c.quotaNote),
      h('p', { class: 'note' }, lastLine('Dernier test', c.lastTest)), h('p', { class: 'note' }, lastLine('Dernière synchronisation', c.lastSync)),
      c.snapshots.length ? h('ul', {}, c.snapshots.map((s) => h('li', { class: 'note' }, snapshotLine(s)))) : h('p', { class: 'note' }, 'Aucune donnée relevée.'),
      c.recentErrors.length ? h('details', {}, h('summary', {}, `Erreurs récentes (${c.recentErrors.length})`), h('ul', {}, c.recentErrors.map((e) => h('li', { class: 'note' }, `${dateFr(e.at)} · ${e.tool} · ${e.error ?? ''}`)))) : null,
      h('div', { class: 'skill-chips' }, acts.map((a) => h('button', { type: 'button', disabled: Boolean(a.disabled), title: a.why ?? '', onclick: () => runAction(c, a) }, a.label))),
      h('p', { class: 'note' }, `Provenance : ${c.provenance ?? c.label}`),
      c.id === 'track17' && !c.flags.authenticated ? keyForm(c) : null,
      settings(c), grants(c));
  }

  function draw() {
    const path = []; let focused = document.activeElement;
    if (root.contains(focused)) while (focused !== root) { path.unshift(Array.from(focused.parentNode.childNodes).indexOf(focused)); focused = focused.parentNode; }
    put(root, h('h2', { tabindex: '-1' }, 'Integration Center'),
      h('p', { class: 'note' }, 'Connexions en LECTURE SEULE : Archipel ne modifie jamais DSers, 17TRACK ni Shopify. Les agents autorisés reçoivent des données projetées et nettoyées, avec suivis masqués. Imports : conservation maximale 30 jours ; caches Shopify : 7 jours. Purge à l’ouverture et chaque minute, sans effacement physique garanti des sauvegardes.'),
      !data.realNetworkAllowed ? h('p', { class: 'note', role: 'status' }, 'Mode hors ligne : aucune connexion réelle n’est possible tant que ARCHIPEL_ALLOW_REAL_NETWORK=1 n’est pas défini avec votre accord explicite.') : null,
      h('p', { class: 'note' }, `Stockage des jetons : ${data.storage.available ? `protégé (${data.storage.backend})` : 'indisponible (DPAPI sous Windows, ou ARCHIPEL_SECRET_KEY)'} · jamais synchronisé par git.`),
      status, err, data.cards.map(card));
    if (path.length) {
      const target = path.reduce((node, i) => node?.childNodes[i], root);
      (target?.focus && !target.disabled ? target : root.childNodes[0]).focus();
    }
  }
  setLeave(() => clearInterval(timer));
  const timer = setInterval(() => { if (!busy && !interacting()) load(); }, 20_000);
  load();
  return root;
}
