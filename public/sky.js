// Cycle du ciel : logique pure (sans DOM). Source Auto = heure locale du navigateur.
export const PHASES = Object.freeze(['morning', 'noon', 'evening', 'night']);
export const PHASE_LABELS = Object.freeze({ auto: 'Automatique', morning: 'Matin', noon: 'Midi', evening: 'Soir', night: 'Nuit' });

export const phaseForHour = (hour) => hour >= 5 && hour < 10 ? 'morning' : hour >= 10 && hour < 17 ? 'noon' : hour >= 17 && hour < 21 ? 'evening' : 'night';
export const normalizeOverride = (value) => PHASES.includes(value) ? value : 'auto';
export const resolveSkyPhase = (date = new Date(), override = 'auto') => { const o = normalizeOverride(override); return o === 'auto' ? phaseForHour(date.getHours()) : o; };

const KEY = 'workeda.sky';
// Seul le choix manuel est mémorisé ; « auto » = rien de stocké.
export function loadOverride(storage) { try { return normalizeOverride((storage ?? globalThis.localStorage)?.getItem(KEY)); } catch { return 'auto'; } }
export function saveOverride(value, storage) {
  const v = normalizeOverride(value);
  try { const s = storage ?? globalThis.localStorage; if (v === 'auto') s.removeItem(KEY); else s.setItem(KEY, v); } catch { /* stockage indisponible : le choix vaut pour la session */ }
  return v;
}

const base = { lights: false, stars: false };
export const PALETTES = Object.freeze({
  morning: { ...base, skyTop: '#9fd3f0', skyBottom: '#fde2c4', cloud: '#ffffff', cloudShade: '#f4d9d0', far: '#eaf1f8', grass: '#7ccf6a', grassHi: '#9fe083', grassEdge: '#4f9f4f', rock: '#9a7b66', rockDark: '#6f5547', wall: '#f2e2c8', wallShade: '#d8c4a4', bridge: '#b58b5a', bridgeDark: '#8e6a42', route: '#ffffff', sun: { x: 0.15, y: 0.3, r: 9, color: '#fff3c4', glow: '#ffe3a8' } },
  noon: { ...base, skyTop: '#3d9be9', skyBottom: '#bfe8ff', cloud: '#ffffff', cloudShade: '#d6ecfa', far: '#e9f6ff', grass: '#5ccf4f', grassHi: '#86e36c', grassEdge: '#3a9a3d', rock: '#8f7458', rockDark: '#664e3c', wall: '#f7ecd6', wallShade: '#dccfb2', bridge: '#c19a62', bridgeDark: '#96744a', route: '#ffffff', sun: { x: 0.5, y: 0.12, r: 9, color: '#fffbe0', glow: '#fff2a0' } },
  evening: { ...base, lights: true, skyTop: '#4a3a86', skyBottom: '#ff9a5c', cloud: '#ffb48a', cloudShade: '#c8607a', far: '#e68b86', grass: '#5b9a5a', grassHi: '#79b565', grassEdge: '#35653f', rock: '#7d5a58', rockDark: '#563a48', wall: '#e8c9a8', wallShade: '#c2a088', bridge: '#a06a4a', bridgeDark: '#7a4e38', route: '#ffd9b8', sun: { x: 0.82, y: 0.42, r: 11, color: '#ffd27a', glow: '#ff9a5c' } },
  night: { ...base, lights: true, stars: true, skyTop: '#0b1030', skyBottom: '#2c2a6e', cloud: '#4a4f8f', cloudShade: '#353a78', far: '#3a3f80', grass: '#2f6a5a', grassHi: '#3d8470', grassEdge: '#1d4440', rock: '#4a4668', rockDark: '#2e2a48', wall: '#8f8aa8', wallShade: '#6f6a88', bridge: '#6a5a6a', bridgeDark: '#4a3e4e', route: '#aab4e8', moon: { x: 0.8, y: 0.16, r: 8, color: '#f4f1d8' } }
});
