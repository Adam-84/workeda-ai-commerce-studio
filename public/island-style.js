// public/island-style.js — personnalisation des îles : options, validation, fusion (pur, sans DOM).
import { supports } from './pixelfont.js';

export const LABEL_MAX = 24;
export const OPTIONS = Object.freeze({
  accent: Object.freeze({ gold: '#f2c14e', blue: '#4f8fd9', violet: '#b46be0', red: '#ff6f5c', teal: '#2fb39a', orange: '#e8853d', sky: '#3b9be0', lime: '#8ac23a' }),
  floor: Object.freeze({ sand: '#e9d3a8', ice: '#cfe0f2', lilac: '#ecd3ef', rose: '#ffd8cc', mint: '#cdeee2', stone: '#e3d6c4', mist: '#d4d9f2', moss: '#e4f2cf' }),
  wall: Object.freeze({ cream: '#efe4cc', sand: '#e2d8c8', slate: '#c8ccd8', white: '#f2f4f6', rose: '#f0d9d4', mint: '#dcebe3' }),
  ground: Object.freeze({
    grass: Object.freeze({ top: '#7fd36a', left: '#7a5a44', right: '#5f4636' }),
    sand: Object.freeze({ top: '#e8c778', left: '#a8794a', right: '#8a6038' }),
    snow: Object.freeze({ top: '#eef4fa', left: '#8a96aa', right: '#6a768c' }),
    stone: Object.freeze({ top: '#c9c2b0', left: '#8a8478', right: '#6a665c' })
  }),
  tree: Object.freeze(['round', 'pine', 'palm', 'blossom']),
  emblem: Object.freeze(['crown', 'package', 'brush', 'megaphone', 'headset', 'truck', 'chart', 'flask'])
});
export const STYLE_FIELDS = Object.freeze(['label', 'accent', 'floor', 'wall', 'emblem', 'tree', 'ground', 'lanterns']);
export const LABELS_FR = Object.freeze({
  accent: { gold: 'Or', blue: 'Bleu', violet: 'Violet', red: 'Corail', teal: 'Turquoise', orange: 'Orange', sky: 'Azur', lime: 'Citron vert' },
  floor: { sand: 'Sable', ice: 'Glace', lilac: 'Lilas', rose: 'Rose', mint: 'Menthe', stone: 'Pierre', mist: 'Brume', moss: 'Mousse' },
  wall: { cream: 'Crème', sand: 'Sable', slate: 'Ardoise', white: 'Blanc', rose: 'Rose', mint: 'Menthe' },
  ground: { grass: 'Herbe', sand: 'Sable', snow: 'Neige', stone: 'Pavés' },
  tree: { round: 'Arbres ronds', pine: 'Sapins', palm: 'Palmiers', blossom: 'Cerisiers' },
  emblem: { crown: 'Couronne', package: 'Colis', brush: 'Pinceau', megaphone: 'Mégaphone', headset: 'Casque', truck: 'Camion', chart: 'Graphique', flask: 'Fiole' }
});

const blank = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && v.trim() === '');
const has = (map, key) => typeof key === 'string' && Object.hasOwn(map, key);

/** Objet à 8 clés (null = « par défaut ») ou null si l'entrée n'est pas un objet. Ne valide pas les valeurs. */
export function normalizeIslandStyle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const k of STYLE_FIELDS) {
    let v = input[k];
    if (typeof v === 'string' && k === 'label') v = v.trim();
    if (blank(v)) { out[k] = null; continue; }
    if (k === 'lanterns') out[k] = v === true || v === 1 || v === '1' ? true : v === false || v === 0 || v === '0' ? false : undefined;
    else out[k] = v;
  }
  return out;
}

export function isValidIslandStyle(input) {
  const s = normalizeIslandStyle(input);
  if (!s) return false;
  if (Object.keys(input).some((k) => !STYLE_FIELDS.includes(k))) return false;
  const okLabel = s.label === null || (typeof s.label === 'string' && [...s.label].length <= LABEL_MAX && !/[\r\n\t]/.test(s.label) && supports(s.label));
  const okMap = (k) => s[k] === null || has(OPTIONS[k], s[k]);
  const okList = (k) => s[k] === null || OPTIONS[k].includes(s[k]);
  return okLabel && okMap('accent') && okMap('floor') && okMap('wall') && okMap('ground') && okList('tree') && okList('emblem') && (s.lanterns === null || typeof s.lanterns === 'boolean');
}

/** Fusionne un style (jetons) dans une identité par défaut ; valeurs invalides ignorées ; ne mute rien. */
export function applyStyle(identity, style) {
  const s = normalizeIslandStyle(style) || {};
  const pick = (map, key, fallback) => (has(map, key) ? map[key] : fallback);
  return {
    ...identity,
    accent: pick(OPTIONS.accent, s.accent, identity.accent),
    floor: pick(OPTIONS.floor, s.floor, identity.floor),
    wall: pick(OPTIONS.wall, s.wall, identity.wall),
    ground: has(OPTIONS.ground, s.ground) ? s.ground : identity.ground || 'grass',
    tree: OPTIONS.tree.includes(s.tree) ? s.tree : identity.tree || 'round',
    lanterns: typeof s.lanterns === 'boolean' ? s.lanterns : identity.lanterns ?? true,
    emblem: OPTIONS.emblem.includes(s.emblem) ? s.emblem : identity.emblem || null,
    label: typeof s.label === 'string' && s.label && [...s.label].length <= LABEL_MAX && supports(s.label) ? s.label : identity.label || null
  };
}
