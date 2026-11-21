// Filtrage ciblé des champs libres : coordonnées et formes de secrets reconnues, sans retirer les noms ni les adresses.
import { scrubSecrets } from './secret-store.js';
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const TRACK = /\b(?:1Z[A-Z0-9]{16}|[A-Z]{2,6}\d{8,24}[A-Z]{0,2}|\d{12,30})\b/gi;
const PHONE = /(?<![\p{L}\d])(?:\+|00)?\d[\d \t\u00a0().-]{6,}\d(?![\p{L}\d])/gu;
const STABLE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?/gi;
const decode = (text) => {
  let s = text.replace(/&#(x[0-9a-f]+|\d+);?/gi, (m, n) => { const cp = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; })
    .replace(/&(commat|period|plus|nbsp|amp);/gi, (_, n) => ({ commat: '@', period: '.', plus: '+', nbsp: ' ', amp: '&' })[n.toLowerCase()]);
  // Décodage limité aux séquences valides, même dans une URL partiellement encodée.
  s = s.replace(/(?:%[0-9a-f]{2})+/gi, (m) => { try { return decodeURIComponent(m); } catch { return m; } });
  return s;
};
export function scrubContacts(value) {
  const original = scrubSecrets(String(value ?? ''));
  let s = original;
  for (let i = 0; i < 3; i++) { const d = decode(s); if (d === s) break; s = d; }
  const redacted = scrubSecrets(s);
  let changed = redacted !== s;
  s = redacted;
  s = s.replace(EMAIL, () => { changed = true; return '[e-mail retiré]'; });
  const stable = [];
  s = s.replace(STABLE, (m) => { stable.push(m); return `\u0001${stable.length - 1}\u0001`; });
  s = s.replace(TRACK, () => { changed = true; return '[suivi retiré]'; })
    .replace(PHONE, (m) => { const n = m.replace(/\D/g, '').length; if (n < 9 || n > 15) return m; changed = true; return '[téléphone retiré]'; });
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => stable[Number(i)] ?? '');
  return changed ? s : original;
}
export function scrubContactData(value) {
  if (typeof value === 'string') return scrubContacts(value);
  if (Array.isArray(value)) return value.map(scrubContactData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrubContacts(k), scrubContactData(v)]));
  return value;
}
