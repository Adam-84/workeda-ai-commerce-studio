// Applications Shopify : inventaire DÉCLARÉ, ajout/correction à la main, import CSV, détection publique (désactivée par défaut) et mesures.
// Rien ici n'installe, ne désinstalle ni ne modifie quoi que ce soit chez Shopify : ce sont des fiches locales. Aucun secret, aucune donnée client.
const enc = encodeURIComponent;
const kb = (n) => (n == null ? '—' : n >= 1024 ? `${(n / 1024).toFixed(1)} Ko` : `${n} o`);
const money = (a, labels) => (a.costAmount == null ? 'coût inconnu' : `${a.costAmount} ${a.costCurrency} · ${labels.billing[a.billingPeriod] ?? a.billingPeriod}`);

export function appsPanel({ ui, act, status, data, setPreview, getPreview }) {
  const { h, get, send } = ui;
  const L = data.labels, list = data.apps;
  let editing = null;
  const select = (name, options, value, label) => h('select', { name, 'aria-label': label, ...(value !== undefined ? {} : {}) }, Object.entries(options).map(([k, v]) => h('option', { value: k, ...(k === value ? { selected: true } : {}) }, v)));
  const f = {
    name: h('input', { name: 'name', maxlength: 80, required: true, 'aria-label': 'Nom de l’application' }), vendor: h('input', { name: 'vendor', maxlength: 80, 'aria-label': 'Éditeur' }),
    fn: select('function', L.functions, 'autre', 'Fonction'), status: select('status', { declared: 'Déclarée', confirmed: 'Confirmée par moi dans mon admin Shopify' }, 'declared', 'Statut'),
    plan: h('input', { name: 'plan', maxlength: 80, 'aria-label': 'Offre ou formule' }), amount: h('input', { name: 'amount', inputmode: 'decimal', 'aria-label': 'Montant (laisser vide si inconnu)', style: 'width:7em' }),
    currency: h('input', { name: 'currency', maxlength: 3, placeholder: 'EUR', 'aria-label': 'Devise', style: 'width:4em' }), billing: select('billing', L.billing, 'unknown', 'Périodicité'),
    installed: h('input', { name: 'installed', type: 'date', 'aria-label': 'Date d’installation' }), note: h('input', { name: 'note', maxlength: 400, 'aria-label': 'Note' })
  };
  const fill = (a) => {
    editing = a?.id ?? null;
    f.name.value = a?.name ?? ''; f.vendor.value = a?.vendor ?? ''; f.fn.value = a?.function ?? 'autre'; f.status.value = a?.status === 'confirmed' ? 'confirmed' : 'declared'; f.plan.value = a?.plan ?? '';
    f.amount.value = a?.costAmount ?? ''; f.currency.value = a?.costCurrency ?? ''; f.billing.value = a?.billingPeriod ?? 'unknown'; f.installed.value = a?.installedOn ?? ''; f.note.value = a?.note ?? '';
    form.querySelector('legend').textContent = a ? `Corriger « ${a.name} »` : 'Ajouter une application';
    f.name.focus();
  };
  const body = () => ({ name: f.name.value, vendor: f.vendor.value, function: f.fn.value, status: f.status.value, plan: f.plan.value, costAmount: f.amount.value.trim() === '' ? null : f.amount.value.trim(), costCurrency: f.currency.value || null, billingPeriod: f.billing.value, installedOn: f.installed.value || null, note: f.note.value });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); act(editing ? 'Fiche corrigée' : 'Application ajoutée', async () => { await send('POST', editing ? `/api/shop-apps/${editing}` : '/api/shop-apps', body()); fill(null); }); } },
    h('fieldset', {}, h('legend', {}, 'Ajouter une application'),
      h('div', { class: 'skill-chips' }, h('label', {}, 'Nom ', f.name), h('label', {}, 'Éditeur ', f.vendor), h('label', {}, 'Fonction ', f.fn), h('label', {}, 'Statut ', f.status)),
      h('div', { class: 'skill-chips' }, h('label', {}, 'Offre ', f.plan), h('label', {}, 'Montant ', f.amount), h('label', {}, 'Devise ', f.currency), h('label', {}, 'Périodicité ', f.billing), h('label', {}, 'Installée le ', f.installed)),
      h('div', { class: 'skill-chips' }, h('label', {}, 'Note ', f.note), h('button', { type: 'submit' }, 'Enregistrer'), h('button', { type: 'button', onclick: () => fill(null) }, 'Nouvelle fiche')),
      h('p', { class: 'note' }, 'Montant vide = coût inconnu (jamais compté comme zéro). Un montant exige une devise et une périodicité. « Confirmée » : à ne choisir que si vous avez vu l’application dans votre admin Shopify.')));

  const row = (a) => h('li', { class: 'skill-row' }, h('div', {}, h('strong', {}, a.name), ' ', h('span', { class: 'chip soft' }, L.statuses[a.status]),
    h('p', { class: 'note' }, `${L.functions[a.function]}${a.vendor ? ` · ${a.vendor}` : ''}${a.plan ? ` · ${a.plan}` : ''} · ${money(a, L)}${a.installedOn ? ` · installée le ${a.installedOn}` : ''}`),
    a.detectedKeys.length ? h('p', { class: 'note' }, `Indices liés : ${a.detectedKeys.join(', ')}`) : null, a.note ? h('p', { class: 'note' }, a.note) : null),
    h('div', { class: 'skill-chips' },
      h('button', { type: 'button', 'aria-label': `Corriger ${a.name}`, onclick: () => fill(a) }, 'Corriger'),
      a.status !== 'confirmed' ? h('button', { type: 'button', 'aria-label': `Marquer ${a.name} comme confirmée`, onclick: () => { if (confirm(`Confirmer que « ${a.name} » est bien installée (vérifiée dans votre admin Shopify) ?`)) act('Application confirmée', () => send('POST', `/api/shop-apps/${a.id}`, { status: 'confirmed' })); } }, 'Confirmer l’installation') : null,
      h('button', { type: 'button', 'aria-label': `Supprimer la fiche ${a.name}`, onclick: () => { if (confirm(`Supprimer la fiche locale « ${a.name} » ? Aucun effet sur Shopify.`)) act('Fiche supprimée', () => send('POST', `/api/shop-apps/${a.id}/delete`, { confirm: true })); } }, 'Supprimer la fiche')));

  const A = data.analysis;
  const analysis = h('div', {},
    h('h4', {}, 'Analyse (calculée, sans IA)'),
    h('p', { class: 'note' }, `${A.count} application(s) : ${A.byStatus.confirmed} confirmée(s), ${A.byStatus.declared} déclarée(s), ${A.byStatus.detected} détectée(s) non confirmée(s).`),
    A.duplicates.length ? h('ul', {}, A.duplicates.map((d) => h('li', { class: 'note' }, `${d.label} : ${d.apps.map((x) => x.name).join(', ')} — chevauchement possible, à vérifier.`))) : h('p', { class: 'note' }, 'Aucun doublon de fonction déclaré.'),
    A.costs.totals.length ? h('ul', {}, A.costs.totals.map((t) => h('li', { class: 'note' }, `${t.monthly} ${t.currency} par mois · ${t.yearly} ${t.currency} par an (${t.apps} application(s), montants connus seulement).`))) : h('p', { class: 'note' }, 'Aucun coût récurrent connu.'),
    A.costs.unknownCost.length ? h('p', { class: 'note' }, `Coût inconnu (non compté) : ${A.costs.unknownCost.map((x) => x.name).join(', ')}.`) : null,
    A.stale.length ? h('p', { class: 'note' }, `À revérifier (non mises à jour depuis plus de 30 jours) : ${A.stale.map((x) => x.name).join(', ')}.`) : null);

  // --- import CSV ---
  const input = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Fichier CSV des applications' });
  const preview = getPreview();
  const importBox = h('div', {},
    h('button', { type: 'button', onclick: () => act('Modèle CSV', async () => { const r = await get('/api/shop-apps/template'); const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv;charset=utf-8' })); const a = document.createElement('a'); a.href = url; a.download = r.filename; a.click(); URL.revokeObjectURL(url); }) }, 'Télécharger le modèle CSV'),
    h('p', { class: 'note' }, 'Import optionnel : fusion par nom, les fiches absentes du fichier ne sont jamais supprimées. Vous pouvez aussi tout saisir à la main ci-dessus.'),
    h('label', {}, 'Fichier local ', input),
    h('button', { type: 'button', onclick: () => act('Validation CSV', async () => { setPreview(null); const file = input.files?.[0]; if (!file) throw new Error('Choisissez un fichier CSV local.'); if (file.size > 500 * 1024) throw new Error('Fichier trop volumineux (maximum 500 Ko).'); const text = await file.text(); input.value = ''; const r = await send('POST', '/api/shop-apps/import/preview', { text }); setPreview(r); status.textContent = r.ok ? 'Aperçu validé : confirmez pour importer.' : 'Import refusé : corrigez les erreurs indiquées.'; }) }, 'Valider et prévisualiser'),
    preview && h('div', {}, h('p', { role: 'status' }, `${preview.rows.length} application(s) valide(s) ; rien n’est enregistré à ce stade.`), h('ul', {}, preview.errors.map((e) => h('li', { class: 'err' }, `Ligne ${e.line} : ${e.message}`))),
      preview.rows.length ? h('div', { style: 'overflow-x:auto;max-width:100%' }, h('table', {},
        h('caption', {}, 'Contenu du CSV à confirmer'),
        h('thead', {}, h('tr', {}, ['Ligne', 'Nom', 'Éditeur', 'Fonction', 'Statut', 'Offre', 'Coût', 'Date d’installation', 'Note'].map((label) => h('th', { scope: 'col' }, label)))),
        h('tbody', {}, preview.rows.map((a) => h('tr', {}, [String(a.line), a.name, a.vendor, L.functions[a.function] ?? a.function, L.statuses[a.status] ?? a.status, a.plan, money(a, L), a.installedOn, a.note].map((value) => h('td', {}, value ?? '—'))))))) : null,

      preview.ok && h('button', { type: 'button', onclick: () => act('Import CSV', async () => { if (!confirm('Importer ces applications dans l’inventaire local ?')) return; const r = await send('POST', '/api/shop-apps/import/commit', { previewId: preview.previewId, confirm: true }); setPreview(null); status.textContent = `${r.added} ajoutée(s), ${r.updated} mise(s) à jour.`; }) }, 'Confirmer l’import')));

  // --- détection publique et mesure : désactivée par défaut ---
  const S = data.settings, scan = data.scan;
  const enabled = h('input', { type: 'checkbox', ...(S.detectionEnabled ? { checked: true } : {}), 'aria-label': 'Autoriser la détection publique et la mesure de chargement', onchange: (e) => act('Réglage de la détection', () => send('POST', '/api/shop-apps/detection/settings', { enabled: e.target.checked })) });
  const linkable = (key) => h('select', { 'aria-label': `Lier l’indice ${key} à une application`, onchange: (e) => { const id = e.target.value; if (id) act('Indice lié', () => send('POST', `/api/shop-apps/${id}/link`, { key })); } }, h('option', { value: '' }, 'Lier à une fiche…'), list.map((a) => h('option', { value: a.id }, a.name)));
  const detect = h('div', {},
    h('h4', {}, 'Détection publique et mesure de chargement (désactivée par défaut)'),
    h('p', { class: 'note' }, `Lit la page d’accueil publique de ${S.domain} uniquement : taille et durée du téléchargement HTML. Les ressources tierces repérées ne sont pas téléchargées ; leur impact reste non mesuré. Un script repéré est un INDICE, jamais la preuve qu’une application est installée. Pas de rendu navigateur : ni LCP ni INP. Aucune donnée client, aucune écriture.`),
    h('label', { class: 'check' }, enabled, ' Autoriser cette fonction'),
    h('button', { type: 'button', disabled: !S.detectionEnabled, onclick: () => act('Détection et mesure', async () => { if (!confirm(`Lancer maintenant la lecture publique de ${S.domain} uniquement (lecture seule, sans télécharger les ressources tierces) ?`)) return; await send('POST', '/api/shop-apps/detection/run', { confirm: true }); }) }, 'Lancer la détection et la mesure'),
    !S.realNetworkAllowed ? h('p', { class: 'note' }, 'Mode hors ligne : le serveur refusera tant que ARCHIPEL_ALLOW_REAL_NETWORK=1 n’est pas défini avec votre accord.') : null,
    scan ? h('div', {}, h('p', { class: 'note' }, `Dernier relevé : ${scan.at} · page ${scan.page?.status ?? '?'} en ${scan.page?.ms ?? '?'} ms${scan.error ? ` · ${scan.error}` : ''}${scan.partial ? ' · partiel (limite de ressources)' : ''}. ${scan.method ?? ''}`),
      scan.totals ? h('p', { class: 'note' }, `Ressources tierces : impact non mesuré · ${scan.totals.renderBlocking} potentiellement bloquante(s) selon le HTML.`) : null,
      h('ul', {}, (scan.findings ?? []).map((x) => h('li', { class: 'skill-row' }, h('div', {}, h('strong', {}, x.label), h('p', { class: 'note' }, `Indice non prouvé · ${x.count} script(s) · ${kb(x.bytes)} · ${x.ms == null ? "durée non mesurée" : `${x.ms} ms`} · ${x.renderBlocking} potentiellement bloquant(s)`)),
        h('div', { class: 'skill-chips' }, linkable(x.key), h('button', { type: 'button', onclick: () => { const name = prompt(`Nom à donner à la fiche créée depuis l’indice « ${x.label} » (statut « détectée », non confirmée) :`); if (name) act('Fiche créée', () => send('POST', '/api/shop-apps/from-indice', { key: x.key, name })); } }, 'Créer une fiche')))))) : h('p', { class: 'note' }, 'Aucun relevé.'));

  return h('div', {}, analysis, h('h4', {}, 'Applications déclarées'), list.length ? h('ul', { class: 'skill-list' }, list.map(row)) : h('p', { class: 'note' }, 'Aucune application déclarée : Archipel ne connaît aucune application installée.'), form, h('h4', {}, 'Import CSV'), importBox, detect);
}
