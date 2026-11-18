// public/app.js — carte isométrique : rendu, interface, fenêtres (navigateur).
import { PALETTES, PHASE_LABELS, resolveSkyPhase, loadOverride, saveOverride } from './sky.js';
import { tinter, mix } from './iso.js';
import { appearanceFor, expressionFor, spriteGrid, OPTIONS, hashStr } from './sprites.js';
import { drawPixelText } from './pixelfont.js';
import { computeBeams } from './beams.js';
import { createViewport, toScreen, toWorld, centerOn, zoomAt, panBy, nextZoom, visibleRect, lerpView } from './viewport.js';
import { computeWorld, placeAgents, drawIsland, drawHub, drawDesk, spriteCanvas, islandBounds, recruitSpot, pillSpot, doorSpot, styledIdentity } from './world.js';
import { drawEmblem } from './emblems.js';
import { OPTIONS as ISLAND_OPTIONS, LABELS_FR, LABEL_MAX, normalizeIslandStyle, isValidIslandStyle } from './island-style.js'; // OPTIONS de sprites.js = personnages : alias
import { connectorText, modelLabel, colleagues, ignoredText, helpLine, FULL_SECTIONS } from './agent-profile.js';
import { createConversation } from './conversation.js';
import { missionsTab } from './missions.js';

const $ = (s) => document.querySelector(s);
const get = (p) => fetch(p).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
const send = (method, p, data) => fetch(p, { method, headers: { 'content-type': 'application/json' }, body: data && JSON.stringify(data) }).then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); return d; });
const h = (tag, props = {}, ...kids) => { const el = document.createElement(tag); for (const [k, v] of Object.entries(props)) { if (k.startsWith('on')) el.addEventListener(k.slice(2), v); else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v); } el.append(...kids.flat().filter((k) => k != null && k !== false)); return el; };
const announce = (t) => { $('#live').textContent = t; };
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const STATUS_LABELS = { idle: 'En attente', working: 'Au travail', waiting: 'En attente d’une réponse', blocked: 'Bloqué' };
const ICONS = {
  working: '<svg viewBox="-8 -8 16 16" width="30" height="30"><circle r="7.5" fill="#fff" stroke="#2f8f5a"/><path d="M0-4.6l1 .9 1.4-.3.5 1.3 1.3.5-.3 1.4.9 1-.9 1 .3 1.4-1.3.5-.5 1.3-1.4-.3-1 .9-1-.9-1.4.3-.5-1.3-1.3-.5.3-1.4-.9-1 .9-1-.3-1.4 1.3-.5.5-1.3 1.4.3z" fill="#2f8f5a"/><circle r="1.5" fill="#fff"/></svg>',
  waiting: '<svg viewBox="-8 -8 16 16" width="30" height="30"><circle r="7.5" fill="#fff" stroke="#c9a23a"/><path d="M-3.2-4.2h6.4M-3.2 4.2h6.4M-2.6-4.2c0 2.6 2.6 2.8 2.6 4.2s-2.6 1.6-2.6 4.2M2.6-4.2c0 2.6-2.6 2.8-2.6 4.2s2.6 1.6 2.6 4.2" fill="none" stroke="#6b4e10" stroke-width="1.1" stroke-linecap="round"/></svg>',
  blocked: '<svg viewBox="-8 -8 16 16" width="30" height="30"><circle r="7.5" fill="#fff" stroke="#e8853d"/><path d="M0-4.5L4.6 3.6H-4.6Z" fill="#e8853d"/><path d="M0-1.4v2.4" stroke="#fff" stroke-width="1.2" stroke-linecap="round"/><circle cy="2.4" r=".6" fill="#fff"/></svg>'
}; // icônes : SVG statiques écrits ici, aucune donnée de la base

export const state = { departments: [], agents: [], missions: [], messages: [], appearances: new Map(), styles: new Map(), profiles: new Map(), health: null, world: null, placed: [] };
let override = loadOverride(), phase = resolveSkyPhase(new Date(), override), firstLoad = true;
const seenExchanges = new Set(), knownAgents = new Set();
const beamQueue = [], walkers = new Map();
const canvas = $('#map'), ctx = canvas.getContext('2d'), overlay = $('#overlay');
let vp = createViewport(2400, 1600, innerWidth, innerHeight);
const islandCache = new Map(); let hubCache = null;
const deptOf = (id) => state.departments.find((d) => d.id === id);
const islandOf = (deptId) => state.world?.islands.find((i) => i.id === deptId);

// ---------- phase et ciel ----------
function updatePhasePill() {
  document.documentElement.dataset.phase = phase;
  $('#sky').value = override;
  const now = new Date(), hh = String(now.getHours()).padStart(2, '0'), mm = String(now.getMinutes()).padStart(2, '0');
  const glyph = { morning: '◐', noon: '☀', evening: '◒', night: '☾' }[phase];
  $('#phase-pill').textContent = `${glyph} ${PHASE_LABELS[phase]} · ${hh}:${mm} · ${override === 'auto' ? 'auto' : 'manuel'}`;
}
function applyPhase() { updatePhasePill(); rebuildCaches(); }
$('#sky').addEventListener('change', (e) => { override = saveOverride(e.target.value); phase = resolveSkyPhase(new Date(), override); applyPhase(); announce(`Ciel : ${PHASE_LABELS[override]}`); });
setInterval(() => { const p = resolveSkyPhase(new Date(), override); if (p === phase) return updatePhasePill(); phase = p; applyPhase(); }, 30000);

// ---------- personnages ----------
const spriteCache = new Map();
export const lookOf = (agent) => appearanceFor(agent, deptOf(agent.department_id)?.name, state.appearances.get(agent.id));
let userSprites = null; // feuilles fournies par l'utilisateur (licence obligatoire), sinon personnages générés
export function spriteFor(agent, { dir = 'down', frame = 0, look, walking = false } = {}) {
  if (userSprites && !look) {
    const v = userSprites[hashStr(`${agent.name}|${agent.role}`) % userSprites.length];
    const sheet = v[walking ? `walk-${dir}` : agent.status] || (!walking && v.idle);
    if (sheet) { const key = `user|${sheet.img.src}|${frame % sheet.frames}`; if (!spriteCache.has(key)) { const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').drawImage(sheet.img, (frame % sheet.frames) * 64, 0, 64, 64, 0, 0, 64, 64); spriteCache.set(key, c); } return spriteCache.get(key); }
  }
  const L = look || lookOf(agent), expr = expressionFor(agent.status);
  const key = `${JSON.stringify(L)}|${expr}|${dir}|${frame}`;
  if (!spriteCache.has(key)) spriteCache.set(key, spriteCanvas(spriteGrid(L, { expr, dir, frame })));
  return spriteCache.get(key);
}
async function loadUserSprites() {
  try {
    const r = await fetch('/assets/characters/manifest.json'); if (!r.ok) return; // absent : personnages générés
    const m = await r.json();
    if (!m.license?.trim() || !Array.isArray(m.variants) || !m.variants.length || m.frameWidth !== 64 || m.frameHeight !== 64) { console.warn('Sprites ignorés : manifest sans licence, sans variantes ou pas en 64×64.'); return; }
    const load = (src) => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error(`image introuvable : ${src}`)); i.src = `/assets/characters/${encodeURI(src)}`; });
    userSprites = await Promise.all(m.variants.map(async (v) => Object.fromEntries(await Promise.all(Object.entries(v).map(async ([k, sh]) => [k, { img: await load(sh.src), frames: Math.max(1, sh.frames | 0) }])))));
    spriteCache.clear();
  } catch (e) { console.warn('Sprites ignorés :', e.message); }
}

// ---------- calques en cache ----------
const lighting = () => ({ lit: phase === 'evening' || phase === 'night', neon: phase === 'night' });
function rebuildIslandCache(deptId) {
  const isl = islandOf(deptId); if (!isl) return;
  const b = islandBounds(isl), c = document.createElement('canvas'); c.width = b.w; c.height = b.h;
  const g = c.getContext('2d'); g.translate(-b.x, -b.y); drawIsland(g, tinter(phase), isl, lighting());
  islandCache.set(deptId, { canvas: c, b, y: isl.y });
}
function rebuildCaches() {
  if (!state.world) return;
  const P = lighting(), C = tinter(phase);
  islandCache.clear();
  for (const isl of state.world.islands) rebuildIslandCache(isl.id);
  const hub = state.world.hub, hc = document.createElement('canvas'); hc.width = 520; hc.height = 420;
  const hg = hc.getContext('2d'); hg.translate(-(hub.x - 260), -(hub.y - 260)); drawHub(hg, C, hub, P);
  hubCache = { canvas: hc, x: hub.x - 260, y: hub.y - 260 };
  draw(performance.now() / 1000);
}

// ---------- rendu ----------
function drawSky(t) {
  const P = PALETTES[phase], H = canvas.height, W = canvas.width;
  for (let i = 0; i < 16; i++) { ctx.fillStyle = mix(P.skyTop, P.skyBottom, i / 15); ctx.fillRect(0, Math.floor((i * H) / 16), W, Math.ceil(H / 16) + 1); }
  if (P.stars) { ctx.fillStyle = '#d8dcff'; for (let i = 0; i < 140; i++) ctx.fillRect((i * 397) % W, (i * 211) % H, i % 9 ? 2 : 3, i % 9 ? 2 : 3); }
  ctx.fillStyle = P.cloud;
  for (let k = 0; k < 6; k++) { const w = 140 + (k % 3) * 40, x = ((k * 431 + (reduce ? 0 : t * (6 + k))) % (W + 300)) - 150, y = 120 + ((k * 173) % (H - 200)); ctx.globalAlpha = 0.8; ctx.fillRect(x, y, w, 22); ctx.fillRect(x + 28, y - 20, w - 70, 20); ctx.globalAlpha = 1; }
}
function draw(t) {
  if (!state.world) return;
  if (canvas.width !== innerWidth || canvas.height !== innerHeight) { canvas.width = innerWidth; canvas.height = innerHeight; }
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.imageSmoothingEnabled = false;
  drawSky(t);
  ctx.setTransform(vp.zoom, 0, 0, vp.zoom, -vp.x * vp.zoom, -vp.y * vp.zoom); ctx.imageSmoothingEnabled = false;
  const C = tinter(phase, 0.5), hub = state.world.hub;
  const layers = [...islandCache.values()].map((l) => ({ y: l.y, f: () => ctx.drawImage(l.canvas, l.b.x, l.b.y) }));
  if (hubCache) layers.push({ y: hub.y, f: () => ctx.drawImage(hubCache.canvas, hubCache.x, hubCache.y) });
  layers.sort((a, b) => a.y - b.y).forEach((l) => l.f());
  drawLinks(t); drawAgents(C, t); drawBeams(t);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
const centerOf = (key) => (key === 'hub' ? [state.world.hub.x, state.world.hub.y - 80] : (() => { const i = islandOf(key); return i ? [i.x, i.y - 140] : null; })());
function drawLinks() {
  ctx.fillStyle = phase === 'night' ? '#7ff0ff' : '#ffffff'; ctx.globalAlpha = 0.55;
  for (const l of state.links || []) { const a = centerOf(l.from), b = centerOf(l.to); if (!a || !b) continue; const n = Math.hypot(b[0] - a[0], b[1] - a[1]); for (let d = 0; d < n; d += 10) ctx.fillRect(Math.round(a[0] + ((b[0] - a[0]) * d) / n), Math.round(a[1] + ((b[1] - a[1]) * d) / n - Math.sin((Math.PI * d) / n) * 60), 3, 3); }
  ctx.globalAlpha = 1;
}
function drawAgents(C, t) {
  for (const p of state.placed) {
    const w = walkers.get(p.agent.id);
    ctx.globalAlpha = p.agent.enabled === false ? 0.45 : 1;
    if (w) { const k = Math.min(1, (t - w.start) / w.duration), x = w.from[0] + (p.x - w.from[0]) * k, y = w.from[1] + (p.y - w.from[1]) * k; const dir = Math.abs(p.x - w.from[0]) > Math.abs(p.y - w.from[1]) ? (p.x < w.from[0] ? 'left' : 'right') : (p.y < w.from[1] ? 'up' : 'down'); ctx.drawImage(spriteFor(p.agent, { dir, frame: 1 + (Math.floor(t * 8) % 2), walking: true }), Math.round(x - 32), Math.round(y - 61)); drawDesk(ctx, C, p.x, p.y, false); if (k >= 1) walkers.delete(p.agent.id); continue; }
    const breath = reduce || p.agent.status === 'blocked' ? 0 : Math.floor(t * 0.7 + (p.x % 7)) % 2;
    const frame = p.agent.status === 'working' && !reduce ? Math.floor(t * 4) % 2 : 0;
    ctx.drawImage(spriteFor(p.agent, { frame }), p.x - 32, p.y - 61 + breath);
    drawDesk(ctx, C, p.x, p.y, p.agent.status === 'working');
  }
  ctx.globalAlpha = 1;
}
function drawBeams(t) {
  const crystal = centerOf('hub');
  for (let k = beamQueue.length - 1; k >= 0; k--) {
    const b = beamQueue[k], age = t - (b.start ??= t), dur = 2.6;
    if (age > dur) { beamQueue.splice(k, 1); continue; }
    const a = centerOf(b.from), z = centerOf(b.to); if (!a || !z) { beamQueue.splice(k, 1); continue; }
    const color = phase === 'night' ? '#bff8ff' : '#a070ff';
    if (b.spark) { ctx.fillStyle = color; for (let i = 0; i < 6; i++) ctx.fillRect(a[0] + Math.cos(i + age * 6) * 20 * age, a[1] + Math.sin(i + age * 6) * 10 * age, 3, 3); continue; }
    const half = age < dur / 2, f = half ? age / (dur / 2) : (age - dur / 2) / (dur / 2), p = half ? [a, crystal] : [crystal, z];
    const x = p[0][0] + (p[1][0] - p[0][0]) * f, y = p[0][1] + (p[1][1] - p[0][1]) * f - Math.sin(Math.PI * f) * 80;
    ctx.globalAlpha = 0.3; ctx.fillStyle = color; ctx.fillRect(x - 9, y - 9, 18, 18); ctx.globalAlpha = 1; ctx.fillStyle = '#ffffff'; ctx.fillRect(x - 3, y - 3, 6, 6);
    if (Math.abs(age - dur / 2) < 0.3) { ctx.globalAlpha = 0.35; ctx.fillStyle = color; ctx.fillRect(crystal[0] - 10, crystal[1] - 600, 20, 600); ctx.globalAlpha = 1; } // éclair vertical au passage du cristal
  }
}
function frame(ts) { stepCamera(ts); draw(ts / 1000); requestAnimationFrame(frame); } // chaque image : carte et boutons HTML restent synchrones

// ---------- superposition HTML (boutons, pastilles, icônes) ----------
const overlayNodes = [];
function buildOverlay() {
  overlay.replaceChildren(); overlayNodes.length = 0;
  const addNode = (el, wx, wy, w, hh, ax = 0.5, ay = 0.5) => { overlay.append(el); overlayNodes.push({ el, wx, wy, w, hh, ax, ay }); };
  for (const isl of state.world.islands) {
    const d = deptOf(isl.id), team = state.agents.filter((a) => a.department_id === isl.id);
    const [px, py] = pillSpot(isl);
    const pill = h('button', { class: 'pill panel hit island', type: 'button', 'data-key': `island:${isl.id}`, onclick: () => show('island', isl.id) });
    fillPill(pill, isl, team);
    addNode(pill, px, py, 0, 0, 0, 0);
    const [rx, ry] = recruitSpot(isl);
    addNode(h('button', { class: 'hit plot', type: 'button', 'data-key': `plot:${isl.id}`, title: `Recruter un agent — ${d.name}`, 'aria-label': `Recruter un agent — ${d.name}`, onclick: () => show('island', isl.id, { recruit: true }) }), rx, ry, 34, 24);
  }
  const hub = state.world.hub;
  addNode(h('button', { class: 'hit island', type: 'button', 'data-key': 'hub:hub', 'aria-label': 'Place centrale : missions et connexions', onclick: () => show('hub', 'hub') }), hub.x, hub.y - 60, 140, 180);
  const q = $('#search').value.trim().toLowerCase();
  for (const p of state.placed) {
    const a = p.agent, match = q && (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q));
    addNode(h('button', { class: `hit agent${match ? ' match' : ''}`, type: 'button', 'data-key': `agent:${a.id}`, title: a.name, 'aria-label': `${a.name}, ${a.role}, statut ${STATUS_LABELS[a.status] || a.status}`, onclick: () => show('agent', a.id) }), p.x, p.y - 30, 40, 64);
    if (ICONS[a.status] && a.enabled !== false) { const icon = h('div', { class: 'status-icon', 'aria-hidden': 'true' }); icon.innerHTML = ICONS[a.status]; addNode(icon, p.x, p.y - 66, 0, 0, 0, 0); }
  }
  positionOverlay(); updateMinimap(); state.world.islands.forEach(paintDot);
}
function fillPill(pill, isl, team) {
  const em = isl.identity.emblem && h('canvas', { class: 'emblem', width: '9', height: '9', 'aria-hidden': 'true' });
  if (em) drawEmblem(em.getContext('2d'), isl.identity.emblem, 0, 0, isl.identity.accent);
  pill.setAttribute('aria-label', `Département ${isl.name}${isl.label !== isl.name ? ` (affiché : ${isl.label})` : ''}, ${team.length} agent${team.length > 1 ? 's' : ''}`);
  pill.replaceChildren(...[
    h('span', { class: 'sw', style: `background:${isl.identity.accent}` }), em,
    h('span', {}, h('b', {}, isl.label), h('small', {}, `${team.length} agents · ${team.filter((a) => a.status === 'working').length} en cours`)),
    h('span', { class: 'ini' }, team.slice(0, 3).map((a) => h('span', {}, a.name.slice(0, 1).toUpperCase())))
  ].filter(Boolean));
}
const dotOf = (isl) => [...$('#minimap-grid').children].find((el) => el.dataset.id === isl.id);
const paintDot = (isl) => { const el = dotOf(isl); if (el) el.style.background = isl.identity.accent; };
function refreshPill(isl) {
  const el = [...overlay.children].find((n) => n.dataset.key === `island:${isl.id}`);
  if (el) fillPill(el, isl, state.agents.filter((a) => a.department_id === isl.id));
  paintDot(isl);
}
// aperçu en direct : modifie seulement l'île affichée (jamais state.styles, jamais buildOverlay)
export function previewIsland(deptId, draft) {
  const isl = islandOf(deptId); if (!isl) return;
  isl.identity = styledIdentity(isl.name, isl.index, draft);
  isl.label = isl.identity.label || isl.name;
  rebuildIslandCache(deptId); refreshPill(isl); if (reduce) draw(0);
}
export const restoreIsland = (deptId) => previewIsland(deptId, state.styles.get(deptId) || null);
function positionOverlay() {
  for (const n of overlayNodes) {
    const [sx, sy] = toScreen(vp, n.wx, n.wy);
    n.el.style.left = `${Math.round(sx - n.w * vp.zoom * n.ax)}px`; n.el.style.top = `${Math.round(sy - n.hh * vp.zoom * n.ay)}px`;
    if (n.w) { n.el.style.width = `${n.w * vp.zoom}px`; n.el.style.height = `${n.hh * vp.zoom}px`; }
  }
  if (!$('#pop').hidden) positionPop();
}

// ---------- déplacement et zoom ----------
let drag = null, cam = null; // cam : transition de caméra en cours { from, to, start }
// applique fn (centerOn, zoomAt, panBy…) à une copie de la vue visée, puis y glisse en ~350 ms (saut direct si mouvement réduit)
function moveView(fn) {
  const to = fn({ ...(cam?.to ?? vp) });
  if (reduce) { Object.assign(vp, { x: to.x, y: to.y, zoom: to.zoom }); return afterView(); }
  cam = { from: { x: vp.x, y: vp.y, zoom: vp.zoom }, to, start: performance.now() };
}
function stepCamera(now) {
  if (!cam) return;
  const k = Math.min(1, (now - cam.start) / 350);
  Object.assign(vp, k < 1 ? lerpView(cam.from, cam.to, 1 - (1 - k) ** 3) : { x: cam.to.x, y: cam.to.y, zoom: cam.to.zoom });
  if (k >= 1) cam = null;
  afterView();
}
canvas.addEventListener('pointerdown', (e) => { if (cam?.from.zoom !== cam?.to.zoom) stepCamera(Infinity); cam = null; drag = { x: e.clientX, y: e.clientY }; canvas.classList.add('dragging'); canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener('pointermove', (e) => { if (!drag) return; panBy(vp, e.clientX - drag.x, e.clientY - drag.y); drag = { x: e.clientX, y: e.clientY }; afterView(); });
canvas.addEventListener('pointerup', () => { drag = null; canvas.classList.remove('dragging'); });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); moveView((v) => zoomAt(v, nextZoom(v.zoom, e.deltaY < 0 ? 1 : -1), e.clientX, e.clientY)); }, { passive: false });
canvas.addEventListener('keydown', (e) => { const s = 60, m = { ArrowLeft: [s, 0], ArrowRight: [-s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }[e.key]; if (m) { e.preventDefault(); moveView((v) => panBy(v, ...m)); } });
$('#zoom-in').addEventListener('click', () => moveView((v) => zoomAt(v, nextZoom(v.zoom, 1), innerWidth / 2, innerHeight / 2)));
$('#zoom-out').addEventListener('click', () => moveView((v) => zoomAt(v, nextZoom(v.zoom, -1), innerWidth / 2, innerHeight / 2)));
function afterView() { $('#zoom-label').textContent = `${Math.round(vp.zoom * 100)} %`; positionOverlay(); updateMinimap(); if (reduce) draw(0); }
export function centerOnWorld(x, y) { moveView((v) => centerOn(v, x, y)); }
addEventListener('resize', () => { stepCamera(Infinity); Object.assign(vp, { viewW: innerWidth, viewH: innerHeight }); centerOn(vp, ...toWorld(vp, innerWidth / 2, innerHeight / 2)); afterView(); });

// ---------- mini-plan ----------
function updateMinimap() {
  if (!state.world) return;
  const grid = $('#minimap-grid'), W = grid.clientWidth || 196, H = grid.clientHeight || 150, sx = W / state.world.width, sy = H / state.world.height;
  if (grid.children.length !== state.world.islands.length + 2) {
    grid.replaceChildren($('#minimap-view') || h('div', { id: 'minimap-view' }));
    for (const isl of state.world.islands) grid.append(h('button', { class: 'mm-dot', type: 'button', 'data-id': isl.id, style: `left:${isl.x * sx}px;top:${isl.y * sy}px;background:${isl.identity.accent}`, 'aria-label': `Aller à ${isl.name}`, onclick: () => { centerOnWorld(isl.x, isl.y - 60); show('island', isl.id); } }));
    grid.append(h('button', { class: 'mm-dot', type: 'button', style: `left:${state.world.hub.x * sx}px;top:${state.world.hub.y * sy}px;background:linear-gradient(135deg,#e0c8ff,#8a5af0)`, 'aria-label': 'Aller à la place centrale', onclick: () => centerOnWorld(state.world.hub.x, state.world.hub.y) }));
  }
  const r = visibleRect(vp), v = $('#minimap-view');
  Object.assign(v.style, { left: `${r.x * sx}px`, top: `${r.y * sy}px`, width: `${r.w * sx}px`, height: `${r.h * sy}px` });
}
$('#minimap-toggle').addEventListener('click', () => { const m = $('#minimap'); m.classList.toggle('collapsed'); $('#minimap-toggle').textContent = m.classList.contains('collapsed') ? '▸' : '▾'; });

// ---------- données ----------
export async function refresh() {
  const [departments, agents, missions, messages, appearances, styles, profiles] = await Promise.all([get('/api/departments'), get('/api/agents'), get('/api/missions'), get('/api/messages'), get('/api/appearances'), get('/api/island-styles'), get('/api/agent-profiles').catch(() => [])]);
  Object.assign(state, { departments, agents, missions, messages, appearances: new Map(appearances.map((a) => [a.agentId, a])), styles: new Map(styles.map((s) => [s.departmentId, s])), profiles: new Map(profiles.map((p) => [p.agentId, p])) });
  const prevW = state.world?.width;
  state.world = computeWorld(departments, agents, state.styles); state.placed = placeAgents(state.world, agents);
  if (prevW !== state.world.width) { Object.assign(vp, { worldW: state.world.width, worldH: state.world.height }); if (firstLoad) centerOn(vp, state.world.hub.x, state.world.hub.y); }
  const beams = computeBeams({ messages, missions, agents, seen: firstLoad ? null : seenExchanges });
  beams.ids.forEach((id) => seenExchanges.add(id)); state.links = beams.links;
  if (!reduce) beamQueue.push(...beams.fresh);
  for (const a of agents) { if (!firstLoad && !knownAgents.has(a.id) && !reduce) { const isl = islandOf(a.department_id); if (isl) walkers.set(a.id, { from: doorSpot(isl), start: performance.now() / 1000, duration: 2 }); } knownAgents.add(a.id); }
  firstLoad = false;
  $('#missions-count').textContent = (() => { const n = missions.filter((m) => !['done', 'cancelled'].includes(m.state)).length; return `${n} mission${n > 1 ? 's' : ''} ouverte${n > 1 ? 's' : ''}`; })();
  const sel = $('#missionbar select'); sel.replaceChildren(h('option', { value: '' }, 'Sans agent'), ...agents.map((a) => h('option', { value: a.id }, a.name)));
  rebuildCaches(); buildOverlay();
  if (closeHook && liveDraft) previewIsland(liveDraft.id, liveDraft.get()); // garde l'aperçu du brouillon ouvert
}
get('/api/health').then((v) => {
  state.health = v; const d = (x) => (x ? 'détecté' : 'non détecté'), warns = v.agentFiles?.warnings ?? [];
  $('#connections').title = $('#connections').textContent = `Claude ${d(v.connectors.claudeCode)} · Codex ${d(v.connectors.codexCli)} · Shopify CLI ${d(v.connectors.shopifyCli)}${ignoredText(warns.length)}`;
  showAgentWarnings(warns);
}).catch(() => { $('#connections').title = $('#connections').textContent = 'Serveur local injoignable'; });
function showAgentWarnings(warns) {
  const box = $('#agent-warnings'); box.hidden = !warns.length;
  box.replaceChildren(h('p', { class: 'note' }, 'Fiches d’agents ignorées :'), h('ul', {}, warns.map((w) => h('li', {}, `${w.file} : ${w.reason}`))));
}
loadUserSprites();
{ const logo = $('#logo').getContext('2d'); drawPixelText(logo, 'WORKEDA', 1, 0, getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#6c5ce7'); }

// ---------- fenêtres contextuelles ----------
const pop = $('#pop'); let current = null;
const anchorEl = () => current && overlay.querySelector(`[data-key="${current.key}"]`);
function positionPop() {
  if (current?.kind === 'agent') { pop.style.left = pop.style.top = ''; return; }
  if (matchMedia('(max-width: 700px)').matches) { pop.style.left = pop.style.top = ''; return; }
  const a = anchorEl(); if (!a) return;
  const r = a.getBoundingClientRect(), w = pop.offsetWidth, hh = pop.offsetHeight;
  let left = r.right + 14, right = false; if (left + w > innerWidth - 8) { left = r.left - w - 14; right = true; }
  pop.classList.toggle('right', right);
  pop.style.left = `${Math.max(8, Math.min(left, innerWidth - w - 8))}px`; pop.style.top = `${Math.max(76, Math.min(r.top, innerHeight - hh - 90))}px`;
}
let closeHook = null; // l'éditeur d'île y met l'annulation de son aperçu non enregistré
let liveDraft = null; // { id, get } tant que le formulaire de personnalisation est ouvert
const runCloseHook = () => { const f = closeHook; closeHook = null; liveDraft = null; f?.(); };
export function close(restore = true) { runCloseHook(); if (pop.hidden) return; const key = current?.key; pop.hidden = true; current = null; announce('Fenêtre fermée'); if (restore && key) overlay.querySelector(`[data-key="${key}"]`)?.focus(); }
export function show(kind, id, opts = {}) {
  runCloseHook();
  const key = opts.recruit ? `plot:${id}` : `${kind}:${id}`; current = { kind, id, key };
  pop.classList.toggle('agent-panel', kind === 'agent');
  const view = { island: islandView, agent: agentView, hub: hubView }[kind](id, opts);
  pop.replaceChildren(h('button', { class: 'x', type: 'button', 'aria-label': 'Fermer', onclick: () => close() }, '×'), view);
  pop.scrollTop = 0; pop.hidden = false; positionPop(); pop.focus(); announce(`${pop.querySelector('h2')?.textContent ?? ''} ouvert`);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); $('#settings').hidden = true; $('#search-results').hidden = true; } });
document.addEventListener('pointerdown', (e) => { if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('.hit')) close(false); if (!$('#settings').hidden && !e.target.closest('#settings, #settings-btn, #phase-pill')) $('#settings').hidden = true; });

const field = (label, control) => h('label', {}, label, control);
function form(fields, submitLabel, onSubmit) {
  const err = h('p', { class: 'err', role: 'alert' });
  const f = h('form', { onsubmit: async (e) => { e.preventDefault(); err.textContent = ''; const btn = f.querySelector('button[type=submit]'); btn.disabled = true; try { await onSubmit(Object.fromEntries(new FormData(f))); } catch (x) { err.textContent = x.message; btn.disabled = false; } } }, fields, h('button', { type: 'submit', class: 'primary' }, submitLabel), err);
  return f;
}
const missionLine = (m) => h('li', {}, `${m.title} — ${m.state}, validation ${m.requiresApproval ? 'requise' : 'non requise'}`);
const deptSelect = (sel) => h('select', { name: 'departmentId', required: true }, state.departments.map((d) => h('option', { value: d.id, selected: d.id === sel }, d.name)));

function recruitFlow(slot, id, values = {}) {
  slot.replaceChildren(form([
    field('Nom', h('input', { name: 'name', required: true, maxlength: 60, value: values.name ?? '' })),
    field('Rôle', h('input', { name: 'role', required: true, maxlength: 80, value: values.role ?? '' })),
    field('Département', deptSelect(values.departmentId ?? id))
  ], 'Continuer', async (data) => {
    const err = h('p', { class: 'err', role: 'alert' });
    const ok = h('button', { type: 'button', class: 'primary', onclick: async () => { ok.disabled = true; try { await send('POST', '/api/agents', data); await refresh(); show('island', data.departmentId); announce(`${data.name} recruté`); } catch (x) { err.textContent = x.message; ok.disabled = false; } } }, 'Confirmer le recrutement');
    slot.replaceChildren(h('div', { class: 'confirm' }, h('p', {}, `Recruter ${data.name} (${data.role}) dans ${deptOf(data.departmentId)?.name ?? '?'}.`), h('p', {}, 'Enregistré dans la base locale, statut En attente (source : manual). Il entrera par la porte.'), h('div', {}, ok, ' ', h('button', { type: 'button', onclick: () => recruitFlow(slot, id, data) }, 'Modifier')), err));
    ok.focus();
  }));
  slot.querySelector('input').focus();
}

// onglets accessibles (rôles tab/tabpanel, flèches, Début/Fin). defs : [{ label, render: () => Node }]
let tabSeq = 0;
function tabset(defs, initial = 0, onChange = () => {}, ariaLabel = '') {
  const uid = ++tabSeq, panel = h('div', { role: 'tabpanel', id: `tp-${uid}`, tabindex: '0' });
  const btns = defs.map((d, k) => h('button', { class: 'tab', type: 'button', role: 'tab', id: `tb-${uid}-${k}`, 'aria-controls': `tp-${uid}`, 'aria-selected': 'false', tabindex: '-1', onclick: () => select(k, true) }, d.label));
  const list = h('div', { class: 'tabs', role: 'tablist', 'aria-label': ariaLabel || false, onkeydown: (e) => { const i = btns.indexOf(document.activeElement); const n = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: btns.length - 1 }[e.key]; if (n !== undefined && i >= 0) { e.preventDefault(); select((n + btns.length) % btns.length, true); } } }, btns);
  let cur = -1;
  function select(k, focus) { if (k === cur) { if (focus) btns[k].focus(); return; } if (cur >= 0) defs[cur].leave?.(); cur = k; btns.forEach((b, j) => { b.setAttribute('aria-selected', String(j === k)); b.tabIndex = j === k ? 0 : -1; }); panel.setAttribute('aria-labelledby', `tb-${uid}-${k}`); panel.replaceChildren(defs[k].render()); if (!$('#pop').hidden) positionPop(); if (focus) btns[k].focus(); onChange(k); }
  select(initial, false);
  return { el: h('div', {}, list, panel), select };
}

function islandView(id, opts) {
  const d = deptOf(id), team = state.agents.filter((a) => a.department_id === id), ids = new Set(team.map((a) => a.id));
  const list = state.missions.filter((m) => ids.has(m.assigned_to) || ids.has(m.requested_by));
  let autoRecruit = opts.recruit, tabs;
  const agentsTab = () => {
    const slot = h('div'), recruit = h('button', { type: 'button', class: 'primary', onclick: () => { recruit.hidden = true; recruitFlow(slot, id); } }, 'Recruter un agent');
    if (autoRecruit) { autoRecruit = false; queueMicrotask(() => recruit.click()); }
    return h('div', {}, team.length ? h('ul', {}, team.map((a) => h('li', {}, h('button', { type: 'button', onclick: () => show('agent', a.id) }, `${a.name} — ${a.role}`)))) : h('p', {}, 'Aucun agent recruté.'),
      h('div', { style: 'margin-top:8px' }, recruit, slot));
  };
  tabs = tabset([
    { label: `Agents (${team.length})`, render: agentsTab },
    { label: 'Missions', render: () => (list.length ? h('ul', {}, list.map(missionLine)) : h('p', {}, 'Aucune mission.')) },
    { label: 'Personnaliser', render: () => islandEditor(id, () => tabs.select(0, true)) }
  ], opts.tab === 'custom' ? 2 : 0, (k) => { if (k !== 2) runCloseHook(); }, 'Sections de l’île'); // quitter l'onglet annule l'aperçu non enregistré
  return h('div', {}, h('h2', {}, d.name), h('p', {}, d.description || ''), tabs.el);
}

// ---------- onglet « Personnaliser » : aperçu en direct, enregistrement explicite ----------
let lastPreviewSay = 0;
function announcePreview() { const t = 'Aperçu mis à jour', now = Date.now(); if ($('#live').textContent === t || now - lastPreviewSay < 1000) return; lastPreviewSay = now; announce(t); }
function islandEditor(id, back) {
  const isl = islandOf(id), saved = normalizeIslandStyle(state.styles.get(id)) || {}, url = `/api/departments/${encodeURIComponent(id)}/style`;
  centerOnWorld(isl.x, isl.y - 60);
  const mine = { open: true }; // jeton de cette instance : invalidé par closeHook (fermeture, autre fenêtre, changement d'onglet, Annuler)
  closeHook = () => { mine.open = false; restoreIsland(id); };
  const err = h('p', { class: 'err', role: 'alert' });
  const choice = (name, key, labels, tokens) => h('select', { name, onchange: onEdit }, h('option', { value: '' }, 'Par défaut'), tokens.map((t) => h('option', { value: t, selected: t === saved[key] }, labels[t])));
  const O = ISLAND_OPTIONS, L = LABELS_FR;
  const label = h('input', { name: 'label', maxlength: LABEL_MAX, placeholder: isl.name, value: saved.label ?? '', 'aria-describedby': `lh-${id}`, oninput: onEdit });
  const accent = choice('accent', 'accent', L.accent, Object.keys(O.accent)), floor = choice('floor', 'floor', L.floor, Object.keys(O.floor)), wall = choice('wall', 'wall', L.wall, Object.keys(O.wall));
  const ground = choice('ground', 'ground', L.ground, Object.keys(O.ground)), tree = choice('tree', 'tree', L.tree, O.tree), emblem = choice('emblem', 'emblem', L.emblem, O.emblem);
  const lanterns = h('select', { name: 'lanterns', onchange: onEdit }, h('option', { value: '' }, 'Par défaut'), h('option', { value: '1', selected: saved.lanterns === true }, 'Oui'), h('option', { value: '0', selected: saved.lanterns === false }, 'Non'));
  emblem.firstChild.textContent = 'Aucun'; // pour l'emblème, « par défaut » = aucun
  const controls = [label, accent, floor, wall, ground, tree, lanterns, emblem];
  const draft = () => normalizeIslandStyle({ label: label.value, accent: accent.value, floor: floor.value, wall: wall.value, ground: ground.value, tree: tree.value, lanterns: lanterns.value === '' ? null : lanterns.value === '1', emblem: emblem.value });
  liveDraft = { id, get: draft };
  function onEdit() { err.textContent = ''; previewIsland(id, draft()); announcePreview(); }
  const save = h('button', { type: 'submit', class: 'primary' }, 'Enregistrer');
  const cancel = h('button', { type: 'button', onclick: () => { if (pending) return; runCloseHook(); back(); } }, 'Annuler');
  const resetBtn = h('button', { type: 'button', onclick: () => reset() }, 'Revenir à l’identité d’origine');
  let pending = false;
  const busy = (v) => { pending = v; [save, cancel, resetBtn].forEach((b) => { b.disabled = v; }); };
  const reopen = () => show('island', id, { tab: 'custom' });
  // requête + rechargement ; après chaque await on vérifie que la fenêtre est toujours ouverte (sinon : rechargement silencieux)
  async function commit(request, done, partial) {
    busy(true);
    try { await request(); } catch (x) { if (mine.open) { err.textContent = x.message; busy(false); } return; }
    try { await refresh(); } catch (x) { if (mine.open) { err.textContent = `${partial}, mais le rechargement a échoué : ${x.message}`; busy(false); } return; }
    if (!mine.open) return;
    mine.open = false; closeHook = null; liveDraft = null; reopen(); announce(done);
  }
  function reset() {
    if (pending) return; err.textContent = '';
    if (!state.styles.has(id)) { controls.forEach((c) => { c.value = ''; }); previewIsland(id, draft()); announce('Valeurs par défaut rétablies'); return; }
    return commit(() => send('DELETE', url), 'Identité d’origine rétablie', 'Identité rétablie');
  }
  return h('form', { onsubmit: (e) => {
    e.preventDefault(); if (pending) return; err.textContent = ''; const body = draft();
    if (!isValidIslandStyle(body)) { err.textContent = isValidIslandStyle({ ...body, label: null }) ? `Le nom ne peut contenir que des lettres, des chiffres, des espaces, un point, un tiret et une apostrophe (${LABEL_MAX} caractères au plus).` : 'Une des valeurs choisies n’est pas valide.'; return; }
    return commit(() => send('PUT', url, body), 'Île enregistrée', 'Enregistré');
  } },
  field('Nom affiché', label), h('p', { class: 'note', id: `lh-${id}` }, 'Laisser vide pour garder le nom du département. Lettres, chiffres, espace, point, tiret et apostrophe.'),
  h('fieldset', {}, h('legend', {}, 'Couleurs'), field('Accent', accent), field('Sol de la pièce', floor), field('Murs', wall)),
  h('fieldset', {}, h('legend', {}, 'Décor extérieur'), field('Sol de la plateforme', ground), field('Arbres', tree), field('Lanternes', lanterns)),
  field('Emblème', emblem),
  err,
  h('div', { class: 'row' }, save, cancel, resetBtn));
}

// Recentre la carte sur un agent puis ouvre sa fenêtre (recherche, boutons « Collabore avec »).
function focusAgent(id) { const p = state.placed.find((x) => x.agent.id === id); if (p) centerOnWorld(p.x, p.y - 40); show('agent', id); }
function profileBlock(p) {
  const team = colleagues(p, state.agents);
  return h('div', { class: 'profile' },
    h('p', { class: 'metier' }, p.sections.metier),
    h('span', { class: 'chip accent' }, `Modèle ${modelLabel(p.model)}`),
    p.connectors.length > 0 && [h('h3', {}, 'Outils externes'), h('ul', {}, p.connectors.map((c) => h('li', {}, connectorText(c))))],
    team.length > 0 && [h('h3', {}, 'Collabore avec'), h('div', { class: 'colleagues' }, team.map((c) => (c.agentId ? h('button', { type: 'button', 'aria-label': `Voir ${c.label}`, onclick: () => focusAgent(c.agentId) }, c.label) : h('span', { class: 'chip soft' }, c.label))))],
    h('h3', {}, 'Livrable attendu'), h('p', { class: 'pre' }, p.sections.livrable),
    h('details', {}, h('summary', {}, 'Fiche complète'), FULL_SECTIONS.flatMap(([key, title]) => [h('h3', {}, title), h('p', { class: 'pre' }, p.sections[key])])),
    h('p', { class: 'note' }, helpLine(p.displayName)));
}
function agentView(id, opts = {}) {
  const a = state.agents.find((x) => x.id === id), d = deptOf(a.department_id);
  let conversation = null;
  const leave = () => { conversation?.destroy(); conversation = null; };
  closeHook = leave;
  const defs = [
    { label: 'Discussion', render: () => { conversation = createConversation({ agent: a, agents: state.agents, get, send, announce, replies: Boolean(state.profiles.get(a.id)?.replies) }); return conversation.el; }, leave },
    { label: 'Missions', render: () => missionsTab({ agent: a, agents: state.agents, missions: () => state.missions, announce, h, get, send,
      save: async (method, path, data) => { const saved = await send(method, path, data); await refresh(); return saved; } }) },
    ...['Profil', 'Apparence'].map((label) => ({ label, render: () => TABS[label](a) })),
    { label: 'Activité', render: () => TABS.Journal(a) }
  ];
  const selected = opts.tab === 'Messages' ? 'Discussion' : opts.tab === 'Journal' ? 'Activité' : opts.tab;
  const tabs = tabset(defs, Math.max(0, defs.findIndex((d) => d.label === selected)), undefined, 'Sections de l’agent');
  const portrait = h('canvas', { class: 'agent-portrait', width: 64, height: 64, 'aria-hidden': 'true' });
  queueMicrotask(() => portrait.getContext('2d').drawImage(spriteFor(a), 0, 0));
  return h('div', { class: 'agent-detail' }, h('header', { class: 'agent-heading' }, portrait,
    h('div', {}, h('h2', {}, a.name), h('p', {}, a.role), h('p', { class: 'agent-department' }, d?.name ?? ''))),
    h('p', { class: 'agent-state' }, `${STATUS_LABELS[a.status] || a.status} · ${a.statusSource === 'manual' ? 'statut manuel' : a.statusSource}${a.enabled ? '' : ' · désactivé'}`), tabs.el);
}
const TABS = {
  Profil: (a) => h('div', {},
    h('div', { class: 'status' }, `${STATUS_LABELS[a.status] || a.status} · source : ${a.statusSource}`),
    a.statusSource === 'manual' && h('p', { style: 'margin-top:6px' }, 'Statut déclaré manuellement : aucun connecteur n’a vérifié d’activité.'),
    state.profiles.has(a.id) && profileBlock(state.profiles.get(a.id)),
    ),
  Apparence: (a) => {
    const look = { ...lookOf(a) }, preview = h('canvas', { class: 'preview', width: 64, height: 64, 'aria-label': `Aperçu de ${a.name}`, role: 'img' });
    const paint = () => { const g = preview.getContext('2d'); g.clearRect(0, 0, 64, 64); g.drawImage(spriteFor(a, { look }), 0, 0); };
    const labels = { hairStyle: 'Coiffure', hairColor: 'Cheveux', skin: 'Peau', eyes: 'Yeux', outfit: 'Tenue', topColor: 'Couleur de tenue', accessory: 'Accessoire' };
    const names = { short: 'courte', long: 'longue', spiky: 'en pics', bun: 'chignon', ponytail: 'queue de cheval', bob: 'carré', blazer: 'blazer', hoodie: 'sweat', sweater: 'pull', jacket: 'veste', labcoat: 'blouse', apron: 'tablier', none: 'aucun', glasses: 'lunettes', headset: 'casque', cap: 'casquette', scarf: 'écharpe' };
    const selects = Object.keys(labels).map((k) => field(labels[k], h('select', { name: k, onchange: (e) => { look[k] = e.target.value; paint(); } }, OPTIONS[k].map((v, i) => h('option', { value: v, selected: v === look[k] }, names[v] || `Teinte ${i + 1}`)))));
    queueMicrotask(paint);
    const err = h('p', { class: 'err', role: 'alert' });
    return h('div', {}, preview, h('form', { onsubmit: async (e) => { e.preventDefault(); try { await send('PUT', `/api/agents/${encodeURIComponent(a.id)}/appearance`, look); await refresh(); show('agent', a.id, { tab: 'Apparence' }); announce('Apparence enregistrée'); } catch (x) { err.textContent = x.message; } } }, selects, h('button', { type: 'submit', class: 'primary' }, 'Enregistrer'),
      h('button', { type: 'button', onclick: async () => { try { await send('DELETE', `/api/agents/${encodeURIComponent(a.id)}/appearance`); await refresh(); show('agent', a.id, { tab: 'Apparence' }); announce('Apparence automatique rétablie'); } catch (x) { err.textContent = x.message; } } }, 'Revenir à l’automatique'), err));
  },
  Journal: (a) => { const ul = h('ul', {}, h('li', {}, 'Chargement…')); get(`/api/events?agentId=${encodeURIComponent(a.id)}`).then((ev) => ul.replaceChildren(...ev.slice(0, 8).map((e) => h('li', {}, `${new Date(e.created_at).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })} · ${e.kind} · ${e.detail} (source : ${e.source})`)))).catch((x) => ul.replaceChildren(h('li', { class: 'err' }, x.message))); return ul; },
};
function hubView() {
  const d = (x) => (x ? 'détecté' : 'non détecté'), c = state.health?.connectors;
  return h('div', {}, h('h2', {}, 'Place centrale'), h('p', {}, `${state.departments.length} départements · ${state.agents.length} agents · ${state.missions.length} missions`),
    h('h3', {}, 'Missions'), state.missions.length ? h('ul', {}, state.missions.slice(0, 10).map(missionLine)) : h('p', {}, 'Aucune mission.'),
    h('h3', {}, 'Connexions'), c ? h('ul', {}, [['Shopify CLI', c.shopifyCli], ['Claude Code', c.claudeCode], ['Codex CLI', c.codexCli], ['clink', c.clink]].map(([n, v]) => h('li', {}, `${n} : ${d(v)}`))) : h('p', {}, 'Indisponible.'),
    h('p', { class: 'note' }, '« Détecté » signifie seulement que le programme est présent. Aucune écriture Shopify sans approbation explicite.'));
}

// ---------- barre du haut : recherche, réglages ----------
$('#search').addEventListener('input', (e) => {
  if (!state.world) return;
  const q = e.target.value.trim().toLowerCase(), res = $('#search-results');
  for (const b of overlay.querySelectorAll('.hit.agent')) { const a = state.agents.find((x) => `agent:${x.id}` === b.dataset.key); b.classList.toggle('match', !!(q && a && (a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)))); }
  if (!q) { res.hidden = true; return; }
  const found = state.agents.filter((a) => a.name.toLowerCase().includes(q) || a.role.toLowerCase().includes(q)).slice(0, 8);
  res.replaceChildren(...(found.length ? found.map((a) => h('li', {}, h('button', { type: 'button', onclick: () => { res.hidden = true; focusAgent(a.id); } }, `${a.name} — ${a.role} · ${deptOf(a.department_id)?.name ?? ''}`))) : [h('li', {}, 'Aucun agent trouvé.')]));
  res.hidden = false;
});
const toggleSettings = () => { const s = $('#settings'); s.hidden = !s.hidden; if (!s.hidden) $('#sky').focus(); };
$('#settings-btn').addEventListener('click', toggleSettings); $('#phase-pill').addEventListener('click', toggleSettings);

// ---------- barre de mission ----------
$('#missionbar').addEventListener('submit', async (e) => {
  e.preventDefault(); const data = Object.fromEntries(new FormData(e.target));
  if (!data.assignedTo) delete data.assignedTo;
  try { await send('POST', '/api/missions', data); e.target.reset(); await refresh(); announce('Mission créée (validation requise)'); } catch (x) { announce(x.message); }
});

// ---------- démarrage ----------
applyPhase();
refresh().catch((e) => { $('#connections').title = $('#connections').textContent = e.message; });
addEventListener('focus', () => { if (pop.hidden) refresh().catch(() => {}); });
if (!reduce) requestAnimationFrame(frame);
