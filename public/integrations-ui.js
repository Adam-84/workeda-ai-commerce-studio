// Integration Center : état réel de DSers et 17TRACK (lecture seule), permissions, quotas, dernières synchronisations, accès par agent, révocation.
// Réutilise les briques de app.js (h, get, send, announce) et les classes existantes (skill-row, chip, note, err). Aucun secret n'est jamais affiché.
import { stateInfo, quotaLine, quotaRatio, lastLine, snapshotLine, grantCandidates, actionsFor, revokeText, dateFr } from './integrations-view.js';

const enc = encodeURIComponent;
const put = (el, ...nodes) => el.replaceChildren(...nodes.flat(Infinity).filter((n) => n != null && n !== false));

export function integrationsCenter({ ui, setLeave = () => {} }) {
  const { h, get, send, announce } = ui;
  const root = h('div', { class: 'integrations-center' });
  const status = h('p', { class: 'note', role: 'status' }), err = h('p', { class: 'err', role: 'alert' });
  let data = null, busy = false;
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
    const country = c.id === 'dsers' ? h('input', { maxlength: 2, value: c.settings.shipCountry, 'aria-label': 'Pays de livraison pour les frais d’expédition', style: 'width:3em' }) : null;
    return h('div', { class: 'skill-chips' }, h('label', {}, 'Plafond d’appels par jour ', cap), country && h('label', {}, ' Pays d’expédition ', country),
      h('button', { type: 'button', onclick: () => act('Réglages enregistrés', () => send('POST', `/api/integrations/${enc(c.id)}/settings`, { dailyCap: Number(cap.value), ...(country ? { shipCountry: country.value.toUpperCase() } : {}) })) }, 'Enregistrer'));
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
    if (a.id === 'test') return act('Test de connexion', () => send('POST', `/api/integrations/${enc(c.id)}/test`, {}));
    if (a.id === 'sync') return act('Actualisation', async () => { const r = await send('POST', `/api/integrations/${enc(c.id)}/sync`, { force: false }); status.textContent = r.result.ok ? 'Données actualisées (le cache évite les appels inutiles).' : `Actualisation partielle ou échouée : ${r.result.error ?? ''}`; });
    if (a.id === 'revoke') return act('Révocation', async () => {
      if (!confirm(`${revokeText(c)}\n\nSupprimer aussi les données déjà relevées ?`) ) return;
      await send('POST', `/api/integrations/${enc(c.id)}/revoke`, { purge: true });
    });
    return null;
  }

  function card(c) {
    const st = stateInfo(c.state), acts = actionsFor(c), ratio = quotaRatio(c.quota);
    return h('section', { class: 'integration-card' },
      h('div', { class: 'skill-chips' }, h('h3', {}, c.label), h('span', { class: `chip ${st.cls}`.trim() }, st.label), h('span', { class: 'chip soft' }, 'Lecture seule'),),
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
      c.id === 'track17' && !c.flags.authenticated ? keyForm(c) : null,
      settings(c), grants(c));
  }

  function draw() {
    const path = []; let focused = document.activeElement;
    if (root.contains(focused)) while (focused !== root) { path.unshift(Array.from(focused.parentNode.childNodes).indexOf(focused)); focused = focused.parentNode; }
    put(root, h('h2', { tabindex: '-1' }, 'Integration Center'),
      h('p', { class: 'note' }, 'Connexions en LECTURE SEULE : Archipel ne modifie jamais DSers, 17TRACK ni Shopify. Les agents ne reçoivent que des données nettoyées (sans nom, adresse, e-mail ni téléphone ; numéros de suivi masqués), uniquement s’ils ont reçu l’accès.'),
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
