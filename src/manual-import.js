// Contrat CSV Archipel v1. Aucun adaptateur DSers n'est supposé sans exemple de format vérifié.
import { scrubContacts } from './catalog-privacy.js';
import { maskTracking, trackingKey, normalizeCarrier, normalizeStatus, orderRefOf } from './integrations-core.js';

export const CSV_LIMITS = Object.freeze({ maxBytes: 500 * 1024, maxRows: 5000, maxColumns: 40, maxCellChars: 2000 });
export const CSV_HEADERS = Object.freeze(['id', 'sku', 'order_id', 'date', 'quantity', 'currency', 'cost_kind', 'purchase_cost', 'shipping_cost', 'carrier', 'status', 'tracking_number']);
export const CSV_TEMPLATE = `${CSV_HEADERS.join(';')}\r\n`;
const CURRENCIES = new Set(Intl.supportedValuesOf('currency').filter(c => !['XXX', 'XTS'].includes(c)));
const COST_KINDS = new Set(['purchase_unit', 'purchase_total']);
const error = (line, message) => ({ line, message });
const failed = (line, message) => ({ ok: false, rows: [], errors: [error(line, message)] });
const formula = value => /^[\s\u0000-\u001f]*[=+@]/.test(value) || /^[\s\u0000-\u001f]*-\s*[^\d.]/.test(value);

// Un seul passage borné : guillemets doublés et retours dans les cellules sont conservés.
function parse(text) {
  let separator = ';', inQuotes = false, semicolons = 0, commas = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (inQuotes && text[i + 1] === '"') i++; else inQuotes = !inQuotes; }
    else if (!inQuotes) { if (c === '\r' || c === '\n') break; if (c === ';') semicolons++; if (c === ',') commas++; }
  }
  if (commas > semicolons) separator = ',';
  const records = []; let row = [], cell = '', state = 'plain', physicalLine = 1, rowLine = 1;
  const pushCell = () => { row.push(cell); cell = ''; if (row.length > CSV_LIMITS.maxColumns) throw error(rowLine, 'Trop de colonnes (maximum 40).'); };
  const pushRow = () => {
    pushCell();
    if (row.some(v => v !== '')) records.push({ cells: row, line: rowLine });
    row = [];
    if (records.length > CSV_LIMITS.maxRows + 1) throw error(rowLine, 'Trop de lignes (maximum 5 000).');
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else state = 'closed'; }
      else { cell += c; if (c === '\n' || c === '\r' && text[i + 1] !== '\n') physicalLine++; }
    } else if (c === separator) { pushCell(); state = 'plain'; }
    else if (c === '\r' || c === '\n') {
      pushRow(); if (c === '\r' && text[i + 1] === '\n') i++;
      physicalLine++; rowLine = physicalLine; state = 'plain';
    } else if (state === 'closed') throw error(rowLine, 'CSV mal formé après un guillemet fermant.');
    else if (c === '"') { if (cell) throw error(rowLine, 'Guillemet inattendu dans une cellule.'); state = 'quoted'; }
    else cell += c;
    if (cell.length > CSV_LIMITS.maxCellChars) throw error(rowLine, 'Cellule trop longue (maximum 2 000 caractères).');
  }
  if (state === 'quoted') throw error(rowLine, 'CSV mal formé : guillemet non fermé.');
  if (cell || row.length || state === 'closed') pushRow();
  return records;
}

const decimal = value => {
  if (!value) return null;
  if (!/^\d+(?:[.,]\d{1,2})?$/.test(value)) return undefined;
  const n = Number(value.replace(',', '.'));
  return Number.isSafeInteger(Math.round(n * 100)) ? n : undefined;
};
const dateOf = value => {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?$/.test(value)) return undefined;
  const n = Date.parse(value);
  return Number.isFinite(n) && new Date(n).toISOString().startsWith(value.slice(0, 10)) ? new Date(n).toISOString() : undefined;
};

// ok=false interdit toute persistance ; rows ne contient que l'aperçu projeté des lignes valides.
export function validateManualCsv(text, { format = 'archipel' } = {}) {
  if (format !== 'archipel') return failed(1, 'Format DSers non reconnu : utilisez le modèle CSV Archipel. Aucun adaptateur DSers vérifié n’est disponible.');
  if (typeof text !== 'string') return failed(1, 'Fichier CSV UTF-8 attendu.');
  if (Buffer.byteLength(text, 'utf8') > CSV_LIMITS.maxBytes) return failed(1, 'Fichier trop volumineux (maximum 500 Ko).');
  if (/[\u0000\ufffd]/.test(text)) return failed(1, 'Encodage CSV invalide : UTF-8 exigé.');
  let records;
  try { records = parse(text.replace(/^\ufeff/, '')); } catch (e) { return failed(e.line ?? 1, e.message ?? 'CSV mal formé.'); }
  if (!records.length) return failed(1, 'Le fichier CSV est vide.');
  const headers = records[0].cells.map(v => v.trim());
  if (headers.some(h => !h) || new Set(headers).size !== headers.length) return failed(1, 'En-têtes vides ou dupliqués.');
  if (!['id', 'sku', 'order_id'].some(h => headers.includes(h))) return failed(1, 'Format non reconnu : une colonne id, sku ou order_id du modèle Archipel est requise.');
  const columns = headers.map((h, i) => CSV_HEADERS.includes(h) ? [h, i] : null).filter(Boolean);
  const rows = [], errors = [];
  for (const record of records.slice(1)) {
    if (record.cells.length !== headers.length) return failed(record.line, 'Nombre de cellules différent des en-têtes.');
    const raw = Object.fromEntries(columns.map(([h, i]) => [h, record.cells[i].trim()]));
    const fields = Object.fromEntries(Object.entries(raw).map(([h, v]) => [h, scrubContacts(v)]));
    const rowErrors = [];
    const reject = message => rowErrors.push(error(record.line, message));
    if (Object.values(raw).some(formula) || Object.values(fields).some(formula)) reject('Les formules ne sont pas acceptées dans les colonnes conservées.');
    if (![fields.id, fields.sku, fields.order_id].some(Boolean)) reject('Identifiant, SKU ou référence de commande requis.');
    const quantity = !raw.quantity ? null : /^[1-9]\d*$/.test(raw.quantity) && Number.isSafeInteger(Number(raw.quantity)) ? Number(raw.quantity) : undefined;
    if (quantity === undefined) reject('Quantité : entier positif attendu.');
    const purchaseCost = decimal(raw.purchase_cost ?? ''), shippingCost = decimal(raw.shipping_cost ?? '');
    if (purchaseCost === undefined) reject('Prix d’achat : nombre positif avec au plus deux décimales attendu.');
    if (shippingCost === undefined) reject('Coût de livraison : nombre positif avec au plus deux décimales attendu.');
    const currency = (raw.currency ?? '').toUpperCase() || null, costKind = raw.cost_kind || null;
    if (currency && !CURRENCIES.has(currency)) reject('Devise ISO 4217 non reconnue.');
    if (costKind && !COST_KINDS.has(costKind)) reject('Nature du coût : purchase_unit ou purchase_total attendu.');
    if (purchaseCost != null || shippingCost != null) {
      if (!currency) reject('Une devise est obligatoire lorsqu’un coût est fourni.');
      if (!costKind) reject('La nature du coût est obligatoire lorsqu’un coût est fourni.');
    }
    const date = dateOf(raw.date ?? ''); if (date === undefined) reject('Date ISO valide attendue (AAAA-MM-JJ ou date UTC).');
    const tracking = raw.tracking_number ?? '';
    // Une valeur arbitraire ne doit pas exposer de coordonnées via les extrémités du masque.
    if (tracking && !/^[A-Za-z0-9]{8,40}$/.test(tracking)) reject('Numéro de suivi : format alphanumérique de 8 à 40 caractères attendu.');
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({ source: 'manual_import', line: record.line, id: /^(?:gid:\/\/shopify\/(?:Product|ProductVariant)\/)?\d{1,20}$/.test(raw.id ?? '') ? raw.id : fields.id ?? '', sku: fields.sku ?? '', orderRef: orderRefOf(raw.order_id), date, quantity,
      currency, costKind, purchaseCost, shippingCost, missingCosts: { purchaseCost: purchaseCost === null ? 'absent' : null, shippingCost: shippingCost === null ? 'absent' : null },
      calculationReady: purchaseCost !== null && shippingCost !== null && Boolean(currency && costKind),
      carrier: normalizeCarrier(raw.carrier), status: normalizeStatus(raw.status), tracking: maskTracking(tracking), trackingKey: tracking ? trackingKey(tracking) : '' });
  }
  return { ok: errors.length === 0, rows, errors };
}

export { parse as parseCsvRecords, formula as isFormula };
