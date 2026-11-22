// Veille des versions de Codex CLI : détecte une version STABLE plus récente que celle testée et signale seulement si ses notes de version
// évoquent un des trois blocages d'isolation (catalogue d'outils, chargement skills/configuration, réseau). Aucune dépendance.
// NE FAIT JAMAIS : installer, mettre à jour ou exécuter Codex ; lire un fichier personnel ; envoyer une donnée du projet. Lectures publiques HTTPS seulement
// (registre npm, API GitHub des releases d'openai/codex). Un jeton GitHub éphémère de l'Action, s'il est fourni, n'est envoyé qu'à api.github.com.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const HOSTS = new Set(['registry.npmjs.org', 'api.github.com']);
export const PACKAGE = '@openai/codex';
export const releaseUrl = (version) => `https://api.github.com/repos/openai/codex/releases/tags/rust-v${version}`; // une release par appel : la liste complète dépasse plusieurs Mo (alphas)
export const DIST_TAGS_URL = 'https://registry.npmjs.org/-/package/@openai%2Fcodex/dist-tags';

// Blocages à résoudre : un signalement exige une formulation FORTE sur une même ligne de notes (pas un simple mot-clé), pour limiter le bruit.
export const BLOCKERS = [
  { id: 'tools', label: 'Catalogue d\'outils intégrés non restreint', re: /agents\.enabled|disabl\w*\s+(?:all\s+|the\s+|built-?in\s+)*(?:tools?|shell|exec|subagent|multi-?agent)|(?:tools?|shell|exec|subagents?)\s+(?:can be |are |is )?disabled|\bno[- ]tools?\b|\btoolless\b|tool\s+allow-?list|allowed[- ]tools|features\.(?:shell_tool|multi_agent|unified_exec)|--disable\b|read-only (?:mode|profile)/i },
  { id: 'profile', label: 'Chargement des skills et configurations du profil utilisateur', re: /(?:ignore|skip|disable|isolat|no longer load|don't load|do not load|opt[- ]out)\w*[^.]{0,40}(?:skills?|agents\.md|user config|codex_home|plugins?)|(?:skills?|agents\.md|user config|codex_home)[^.]{0,40}(?:ignored|skipped|disabled|isolated|opt[- ]out)|skills?\s+discovery|discover\w*\s+(?:repository\s+|user\s+|host\s+)?skills|skip_host_skill_discovery|ignore-user-config/i },
  { id: 'network', label: 'Restriction réseau vers un fournisseur unique', re: /(?:network|egress|outbound)[^.]{0,50}(?:allow-?list|only|restrict|per-host|enforce|domain)|(?:allow-?list|domains?|hosts?)[^.]{0,40}(?:network|proxy|egress)|managed\s+(?:network\s+)?proxy|transparent\s+tcp|network\s+(?:policy|requirements|sandbox)|proxy-only|firewall/i }
];
// Information seulement (n'entraîne pas de signalement) : nouveautés de modèles et du sandbox Windows.
export const INFO = [
  { id: 'models', label: 'Modèles annoncés', re: /\b(gpt-?\d[\w.-]*|astra|sol)\b/i },
  { id: 'windows', label: 'Sandbox Windows', re: /(windows sandbox|windows.{0,20}sandbox|mxc|appcontainer|restricted token)/i }
];

export function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v ?? '').trim().replace(/^rust-/, ''));
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, text: `${m[1]}.${m[2]}.${m[3]}${m[4] ? `-${m[4]}` : ''}` } : null;
}
export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b); if (!x || !y) throw new Error('version invalide');
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] < y[k] ? -1 : 1;
  if (x.pre === y.pre) return 0; if (!x.pre) return 1; if (!y.pre) return -1; return x.pre < y.pre ? -1 : 1;
}

const lines = (body) => String(body ?? '').split(/\r?\n/).map((l) => l.replace(/^[\s>*#-]+/, '').replace(/\(#\d+(?:,\s*#\d+)*\)/g, '').replace(/^\d{4,6}\s+/, '').replace(/\s+@[\w-]+$/, '').trim()).filter(Boolean);
export function analyzeNotes(body) {
  const ls = lines(body), hits = {}, info = {};
  for (const b of BLOCKERS) hits[b.id] = ls.filter((l) => b.re.test(l)).slice(0, 3).map((l) => l.slice(0, 220));
  for (const i of INFO) info[i.id] = ls.filter((l) => i.re.test(l)).slice(0, 2).map((l) => l.slice(0, 160));
  const groups = BLOCKERS.filter((b) => hits[b.id].length).map((b) => b.id);
  return { groups, hits, info, relevant: groups.length > 0 };
}

export function selectNewer(releases, tested) {
  return (Array.isArray(releases) ? releases : [])
    .filter((r) => r && !r.prerelease && !r.draft && parseVersion(r.tag_name) && !parseVersion(r.tag_name).pre)
    .filter((r) => compareVersions(r.tag_name, tested) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
}

const REQUIRED_TESTS = [
  'Décision séparée du propriétaire : installer la version dans un environnement de test (changement système : hors de ce suivi, jamais automatique).',
  'Windows seulement : `ARCHIPEL_CODEX_PROBES=1 node --test test/codex-client-catalog.test.js` (catalogue d\'outils, skills du profil réel, appel forcé).',
  'Windows seulement : `node --test test/codex-mxc.test.js test/codex-client-isolation.test.js` (fichiers, écritures, loopback, arrêt d\'arbre sous MXC).',
  'Réseau : rechercher une option imposant UN seul hôte/port côté client ou noyau, puis la prouver avec le faux fournisseur et des sondes vers un second port/127.0.0.2.',
  'Un test qui échoue après la mise à jour signale un changement à analyser (et non un bug) ; mettre à jour docs/PAL-HARDENING.md et `tools/codex-watch/baseline.json` seulement après validation.',
  'Conserver le refus fermé tant que les TROIS blocages ne sont pas démontrés levés ; aucune activation via PAL.'
];

export function buildReport({ baseline, latest, newer, analyses, notesAvailable, date }) {
  const rel = newer.filter((r) => analyses.get(r.tag_name)?.relevant), other = newer.filter((r) => !analyses.get(r.tag_name)?.relevant);
  const out = [`# Veille Codex CLI — ${date}`, '', `Version testée (baseline) : **${baseline.tested}** · dernière version stable publiée : **${latest ?? 'inconnue'}** · versions stables plus récentes : **${newer.length}**`, ''];
  if (!notesAvailable) out.push('> Notes de version indisponibles (API GitHub) : aucune analyse de pertinence possible ; seule la nouvelle version est signalée.', '');
  if (!newer.length) out.push('Aucune nouvelle version stable : rien à signaler.');
  for (const r of rel) {
    const a = analyses.get(r.tag_name), v = parseVersion(r.tag_name).text;
    out.push(`## Codex CLI ${v} — version PERTINENTE`, `Notes : ${r.html_url ?? 'n/d'}`, '');
    for (const b of BLOCKERS.filter((x) => a.hits[x.id].length)) out.push(`**${b.label}**`, ...a.hits[b.id].map((l) => `- ${l}`), '');
    for (const i of INFO.filter((x) => a.info[x.id].length)) out.push(`_${i.label} (information)_ : ${a.info[i.id].join(' | ')}`);
    out.push('');
  }
  if (other.length) out.push(`Versions sans mention pertinente : ${other.map((r) => parseVersion(r.tag_name).text).join(', ')}.`, '');
  if (!notesAvailable && newer.length) out.push(`Nouvelles versions : ${newer.map((r) => parseVersion(r.tag_name ?? r).text).join(', ')}.`, '');
  if (rel.length || (!notesAvailable && newer.length)) out.push('## Tests nécessaires avant toute reprise', ...REQUIRED_TESTS.map((t, i) => `${i + 1}. ${t}`), '', '**Ce rapport n\'installe, ne met à jour et n\'exécute rien. Codex reste refusé (refus fermé).**');
  return out.join('\n') + '\n';
}

// Versions stables candidates entre la baseline et la dernière publiée : X.Y.0 de chaque mineure (les correctifs X.Y.Z ne sont pas énumérés), plus la dernière elle-même. Borné à 25 appels.
export function candidateVersions(tested, latest) {
  const t = parseVersion(tested), l = parseVersion(latest); if (!t || !l || l.pre || compareVersions(latest, tested) <= 0) return [];
  const out = []; for (let m = t.minor + 1; m < l.minor && out.length < 24; m += 1) out.push(`${l.major}.${m}.0`);
  out.push(l.text); return [...new Set(out)].filter((v) => v !== t.text);
}

export async function runWatch({ baseline, fetchJson, date = new Date().toISOString().slice(0, 10) }) {
  let latest = null; const releases = []; let failures = 0;
  try { const tags = await fetchJson(DIST_TAGS_URL); latest = typeof tags?.latest === 'string' ? tags.latest : null; } catch { /* registre indisponible */ }
  for (const v of candidateVersions(baseline.tested, latest)) {
    try { releases.push(await fetchJson(releaseUrl(v))); } catch (e) { if (!/HTTP 404/.test(e.message)) failures += 1; } // 404 : pas de release stable pour cette mineure
  }
  const wanted = candidateVersions(baseline.tested, latest).length;
  const notesAvailable = wanted === 0 || (releases.length > 0 && failures === 0);
  let newer = selectNewer(releases, baseline.tested);
  if (!notesAvailable && latest && parseVersion(latest) && !parseVersion(latest).pre && compareVersions(latest, baseline.tested) > 0) newer = [{ tag_name: latest, html_url: null }];
  const analyses = new Map(newer.map((r) => [r.tag_name, analyzeNotes(r.body)]));
  const relevant = newer.filter((r) => analyses.get(r.tag_name).relevant).map((r) => parseVersion(r.tag_name).text);
  const fresh = newer.filter((r) => !baseline.lastReported || compareVersions(r.tag_name, baseline.lastReported) > 0);
  const toReport = relevant.length ? relevant : (!notesAvailable && newer.length ? newer.map((r) => parseVersion(r.tag_name).text) : []);
  return { latest, newer: newer.map((r) => parseVersion(r.tag_name).text), relevant: toReport, newToReport: fresh.length > 0, report: buildReport({ baseline, latest, newer, analyses, notesAvailable, date }), notesAvailable };
}

// Lecture HTTPS publique uniquement : hôtes en liste blanche, pas de redirection, délai et taille bornés, aucune donnée envoyée.
export function makeFetchJson({ fetchImpl = globalThis.fetch, token = null } = {}) {
  return async (url) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOSTS.has(u.hostname)) throw new Error(`hôte non autorisé : ${u.hostname}`);
    const headers = { accept: 'application/json', 'user-agent': 'archipel-codex-watch' };
    if (token && u.hostname === 'api.github.com') headers.authorization = `Bearer ${token}`; // jeton éphémère de l'Action : jamais vers un autre hôte
    const res = await fetchImpl(u, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text(); if (text.length > 5_000_000) throw new Error('réponse trop volumineuse');
    return JSON.parse(text);
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
  const baseline = JSON.parse(readFileSync(new URL('./baseline.json', import.meta.url), 'utf8'));
  const result = await runWatch({ baseline, fetchJson: makeFetchJson({ token: process.env.GITHUB_TOKEN ?? null }) });
  const out = arg('--out'); if (out) writeFileSync(out, result.report); else process.stdout.write(result.report);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `relevant=${result.relevant.length > 0}\nversions=${result.relevant.join(',')}\nlatest=${result.latest ?? ''}\n`);
  process.stderr.write(`codex-watch : testée ${baseline.tested}, dernière stable ${result.latest ?? '?'}, pertinentes : ${result.relevant.join(', ') || 'aucune'}\n`);
}
