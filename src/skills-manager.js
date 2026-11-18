// src/skills-manager.js — opérations de la bibliothèque de Skills : créer, importer, modifier, archiver, affecter.
// Règles : skills/ (disque) reste la source de vérité, la base s'en déduit ; un Skill ne donne jamais de permission
// (en-têtes de permission refusés par l'analyse) ; seul SKILL.md est écrit ; aucun script n'est exécuté ; rien n'est supprimé.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSkillLibrary, analyzeSkill, hasBlocking, buildSkillText, fetchSkillText, recommendSkills, NAME_RE, MAX_NAME, MAX_DESCRIPTION } from './skills.js';
import { loadAgentFiles, parseAgentFile, MAX_PRELOADED } from './agent-files.js';
import { checkCopies, applyCopies, setFicheSkills } from './skills-sync.js';
import { auditSetup } from './skills-cli.js';

// Noms réservés : ils correspondent à des routes de l'API.
export const RESERVED = ['import', 'stats', 'health', 'categories', 'sources', 'recommend', 'sync'];
const SEMVER = /^\d+\.\d+\.\d+$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const one = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// Même mise en forme que le catalogue écrit à la main : une ligne par entrée, pour des diffs lisibles.
const fmt = (v) => Array.isArray(v) ? `[${v.map(fmt).join(', ')}]`
  : v && typeof v === 'object' ? (Object.keys(v).length ? `{ ${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${fmt(x)}`).join(', ')} }` : '{}')
    : JSON.stringify(v);
export const serializeCatalog = (c) => `{\n${Object.entries(c).map(([k, v]) => Array.isArray(v) && v.some((x) => x && typeof x === 'object')
  ? `  ${JSON.stringify(k)}: [\n${v.map((x) => `    ${fmt(x)}`).join(',\n')}\n  ]` : `  ${JSON.stringify(k)}: ${fmt(v)}`).join(',\n')}\n}\n`;

const atomicWrite = (file, text) => { const tmp = `${file}.tmp-${process.pid}`; writeFileSync(tmp, text); renameSync(tmp, file); };
const bumpPatch = (v) => { const [a, b, c] = SEMVER.test(v) ? v.split('.').map(Number) : [1, 0, 0]; return `${a}.${b}.${c + 1}`; };

export function createSkillManager({ root, studio, profiles = [], fetchImpl = fetch }) {
  const skillsDir = join(root, 'skills'), agentsDir = join(root, '.claude', 'agents'), catalogFile = join(skillsDir, 'catalog.json');
  let library = loadSkillLibrary(skillsDir);

  const readCatalog = () => {
    if (!existsSync(catalogFile)) return { version: 1, categories: [], skills: [], sources: [] };
    try { const c = JSON.parse(readFileSync(catalogFile, 'utf8')); if (!Array.isArray(c.skills)) c.skills = []; return c; }
    catch { throw fail('skills/catalog.json est illisible : corrigez-le avant de modifier la bibliothèque.', 500); }
  };
  const editCatalog = (fn) => {
    const catalog = readCatalog();
    fn(catalog);
    mkdirSync(skillsDir, { recursive: true });
    atomicWrite(catalogFile, serializeCatalog(catalog));
  };
  const upsertEntry = (catalog, name, patch) => {
    const i = catalog.skills.findIndex((s) => s.name === name);
    if (i >= 0) catalog.skills[i] = { ...catalog.skills[i], ...patch };
    else catalog.skills.push({ name, ...patch });
  };

  // Relit le disque, met la base à jour et aligne la mémoire du serveur sur les fiches.
  const refresh = () => {
    library = loadSkillLibrary(skillsDir);
    const fresh = loadAgentFiles(agentsDir);
    const synced = studio.syncSkills(library);
    const assigned = studio.syncAgentSkills(fresh.profiles);
    for (const p of profiles) { const f = fresh.profiles.find((x) => x.slug === p.slug); if (f) p.skills = f.skills; }
    return { fresh, synced, assigned };
  };
  const copies = () => applyCopies(root, library, loadAgentFiles(agentsDir).profiles);
  const skillByName = (name) => library.skills.find((s) => s.name === name) ?? null;
  const need = (name) => { const s = skillByName(name); if (!s) throw fail('Skill introuvable.', 404); return s; };
  const slugOf = (agentId) => {
    const link = studio.listAgentFiles().find((l) => l.agentId === agentId);
    if (!link) throw fail('Cet agent n’a pas de fiche .claude/agents : aucun Skill ne peut lui être affecté.', 404);
    return link.slug;
  };
  // Liste réelle de la fiche sur disque (la mémoire du serveur peut être en retard si la fiche a été éditée à la main).
  const ficheSkills = (slug) => {
    const file = join(agentsDir, `${slug}.md`);
    if (!existsSync(file)) throw fail('Fiche introuvable.', 404);
    const parsed = parseAgentFile(readFileSync(file, 'utf8'), `${slug}.md`);
    if (parsed.error) throw fail(`Fiche illisible : ${parsed.error}`, 500);
    return parsed.profile.skills ?? [];
  };
  const usersOf = (name) => loadAgentFiles(agentsDir).profiles.filter((p) => (p.skills ?? []).includes(name)).map((p) => p.slug);
  const cleanRoles = (roles) => [...new Set((Array.isArray(roles) ? roles : []).map((r) => one(r, 40).toLowerCase()).filter(Boolean))].slice(0, 12);
  const checkCategory = (category) => {
    if (category == null || category === '') return null;
    if (!readCatalog().categories?.some((c) => c.slug === category)) throw fail('Catégorie inconnue.');
    return category;
  };
  const checkDeps = (dependsOn, self) => {
    const deps = [...new Set(Array.isArray(dependsOn) ? dependsOn.map(String) : [])];
    for (const d of deps) {
      const s = skillByName(d);
      if (d === self || !s || s.archived) throw fail(`Dépendance impossible : « ${d} » n’existe pas ou est archivé.`);
    }
    return deps;
  };
  const refuseBlocking = (a) => {
    if (a.error) throw fail(`Skill invalide : ${a.error}`);
    // Nom et description doivent être valides pour Claude Code et Codex avant toute écriture (le nom devient un nom de dossier).
    if (!NAME_RE.test(a.name) || a.name.length > MAX_NAME) throw fail(`Skill invalide : nom « ${a.name} » non conforme (minuscules, chiffres et tirets, ${MAX_NAME} caractères au plus).`);
    const issues = [...new Set([...a.compat.claude.issues, ...a.compat.codex.issues])];
    if (issues.length) throw fail(`Skill invalide : ${issues.join(' ; ')}`);
    if (hasBlocking(a.findings)) throw fail(`Skill refusé : ${a.findings.filter((f) => f.severity === 'bloquant').map((f) => f.message).join(' ; ')}`, 422);
  };
  const summary = (a) => ({ name: a.name, description: a.description, license: a.license, tokens: a.tokens, hash: a.hash, findings: a.findings, compat: a.compat, content: a.content });

  return {
    get library() { return library; },
    // Au démarrage : synchronise la base et signale l'écart avec les copies générées, sans rien écrire sur le disque.
    startup() {
      const r = refresh();
      return { ...r, drift: checkCopies(root, library, r.fresh.profiles), problems: auditSetup(library, r.fresh.profiles) };
    },
    health() {
      const { profiles: fresh, warnings } = loadAgentFiles(agentsDir);
      return {
        problems: [...auditSetup(library, fresh), ...warnings.map((w) => `.claude/agents/${w.file} : ${w.reason}`)],
        copies: checkCopies(root, library, fresh),
        maxPreloaded: MAX_PRELOADED
      };
    },
    detail(name) {
      const s = need(name);
      return { ...studio.getSkill(name), content: s.content, findings: s.findings, compat: s.compat, extraFiles: s.extraFiles, archived: s.archived };
    },
    forAgent(agentId) {
      const slug = slugOf(agentId);
      const names = ficheSkills(slug);
      const byName = new Map(studio.listSkills().map((s) => [s.name, s]));
      const preloaded = names.map((n) => byName.get(n)).filter(Boolean);
      return {
        slug, max: MAX_PRELOADED, preloaded,
        preloadedTokens: preloaded.reduce((t, s) => t + s.tokens, 0),
        available: [...byName.values()].filter((s) => s.status === 'active' && !names.includes(s.name))
      };
    },
    recommend({ agentId, text }) {
      let query = String(text ?? ''), exclude = [];
      if (agentId) {
        const slug = slugOf(agentId);
        const p = profiles.find((x) => x.slug === slug);
        exclude = ficheSkills(slug);
        query = [query, p?.displayName, p?.role, p?.department, p?.description, p?.sections?.metier].filter(Boolean).join(' ');
      }
      if (!query.trim()) throw fail('Indiquez un agent ou un texte pour recommander des Skills.');
      return recommendSkills(studio.listSkills(), query, { exclude });
    },

    create({ name, title, description, body, category, roles, dependsOn }) {
      name = String(name ?? '').trim();
      if (!NAME_RE.test(name) || name.length > MAX_NAME) throw fail(`Nom invalide : minuscules, chiffres et tirets, ${MAX_NAME} caractères au plus.`);
      if (RESERVED.includes(name)) throw fail('Ce nom est réservé.');
      if (existsSync(join(skillsDir, name))) throw fail('Un Skill porte déjà ce nom : rien n’est écrasé.', 409);
      description = one(description, MAX_DESCRIPTION + 1);
      if (!description) throw fail('La description est obligatoire : c’est elle qui décide du chargement du Skill.');
      if (description.length > MAX_DESCRIPTION) throw fail(`La description dépasse ${MAX_DESCRIPTION} caractères.`);
      if (!String(body ?? '').trim()) throw fail('Le contenu du Skill est obligatoire.');
      const cat = checkCategory(category), deps = checkDeps(dependsOn, name);
      const text = buildSkillText({ name, title: one(title, 80) || name, description, body });
      const a = analyzeSkill(text, name);
      refuseBlocking(a);
      const dir = join(skillsDir, name);
      readCatalog(); // échoue avant toute écriture si le catalogue est illisible
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(dir); // sans « recursive » : échoue si le dossier est apparu entre-temps
      atomicWrite(join(dir, 'SKILL.md'), a.content);
      editCatalog((c) => upsertEntry(c, name, { title: one(title, 80) || name, category: cat, version: '1.0.0', license: 'Perso', roles: cleanRoles(roles), ...(deps.length ? { dependsOn: deps } : {}) }));
      refresh();
      return { skill: name, findings: a.findings, copies: copies() };
    },

    // Sans `hash` : aperçu seul, rien n'est écrit. Avec `hash` : importe seulement si le contenu est celui qui a été aperçu.
    async importSkill({ url, hash, category, roles }) {
      const { text, raw } = await fetchSkillText(url, fetchImpl);
      const a = analyzeSkill(text, null);
      if (a.error) throw fail(`Skill invalide : ${a.error}`);
      const preview = { ...summary(a), source: raw, blocked: hasBlocking(a.findings), exists: Boolean(skillByName(a.name)) };
      if (!hash) return { preview };
      if (hash !== a.hash) throw fail('Le fichier distant a changé depuis l’aperçu : relancez l’aperçu.', 409);
      refuseBlocking(a);
      if (RESERVED.includes(a.name)) throw fail('Ce nom est réservé.');
      if (existsSync(join(skillsDir, a.name))) throw fail('Un Skill porte déjà ce nom : rien n’est écrasé.', 409);
      const cat = checkCategory(category);
      readCatalog(); // échoue avant toute écriture si le catalogue est illisible
      mkdirSync(skillsDir, { recursive: true });
      mkdirSync(join(skillsDir, a.name));
      atomicWrite(join(skillsDir, a.name, 'SKILL.md'), a.content);
      editCatalog((c) => upsertEntry(c, a.name, { title: a.name, category: cat, version: '1.0.0', license: a.license ?? 'inconnue', source: raw, roles: cleanRoles(roles) }));
      refresh();
      return { skill: a.name, findings: a.findings, copies: copies() };
    },

    // Remplace le SKILL.md complet. La version monte d'un cran si l'appelant n'en donne pas.
    // `baseHash` (empreinte lue à l'ouverture de l'éditeur) évite d'écraser une modification faite entre-temps.
    update(name, { content, version, baseHash }) {
      const s = need(name);
      if (baseHash && baseHash !== s.hash) throw fail('Ce Skill a été modifié depuis l’ouverture de l’éditeur : rouvrez-le pour voir la version actuelle.', 409);
      const a = analyzeSkill(String(content ?? ''), name);
      refuseBlocking(a);
      if (a.name !== name) throw fail('Le nom ne peut pas changer ici : créez un nouveau Skill.');
      if (a.hash === s.hash) return { skill: name, changed: false, copies: copies() };
      readCatalog(); // échoue avant toute écriture si le catalogue est illisible
      const next = version == null || version === '' ? bumpPatch(s.version) : String(version);
      if (!SEMVER.test(next)) throw fail('Version attendue au format 1.2.3.');
      if (next === s.version) throw fail('Le contenu a changé : la version doit changer aussi.');
      atomicWrite(join(skillsDir, name, 'SKILL.md'), a.content);
      editCatalog((c) => upsertEntry(c, name, { version: next }));
      refresh();
      return { skill: name, changed: true, version: next, findings: a.findings, copies: copies() };
    },

    setArchived(name, archived) {
      const s = need(name);
      if (archived) {
        const users = usersOf(name);
        if (users.length) throw fail(`Retirez d’abord ce Skill des agents qui le préchargent : ${users.join(', ')}.`, 409);
        const deps = library.skills.filter((x) => !x.archived && x.dependsOn.includes(name)).map((x) => x.name);
        if (deps.length) throw fail(`Des Skills actifs en dépendent : ${deps.join(', ')}.`, 409);
      } else if (s.dependsOn.some((d) => skillByName(d)?.archived)) throw fail('Une dépendance de ce Skill est archivée : restaurez-la d’abord.', 409);
      editCatalog((c) => {
        upsertEntry(c, name, archived ? { archived: true } : {});
        if (!archived) { const e = c.skills.find((x) => x.name === name); if (e) delete e.archived; }
      });
      refresh();
      return { skill: name, archived: Boolean(archived), copies: copies() };
    },

    assign(agentId, name) {
      const slug = slugOf(agentId), s = need(name);
      if (s.archived) throw fail('Ce Skill est archivé.', 409);
      const current = ficheSkills(slug);
      if (current.includes(name)) return { skill: name, slug, skills: current, changed: false, copies: copies() };
      const missing = s.dependsOn.filter((d) => !current.includes(d));
      if (missing.length) throw fail(`« ${name} » dépend de : ${missing.join(', ')}. Affectez-le(s) d’abord.`, 409);
      const next = [...current, name];
      setFicheSkills(agentsDir, slug, next); // vérifie le plafond et la validité de la fiche avant d'écrire
      refresh();
      return { skill: name, slug, skills: next, changed: true, copies: copies(), notice: 'Pris en compte au prochain démarrage de Claude Code (la liste des agents est lue au lancement).' };
    },

    unassign(agentId, name) {
      const slug = slugOf(agentId);
      const current = ficheSkills(slug);
      if (!current.includes(name)) return { skill: name, slug, skills: current, changed: false, copies: copies() };
      const needing = current.filter((n) => n !== name && skillByName(n)?.dependsOn.includes(name));
      if (needing.length) throw fail(`${needing.join(', ')} dépend(ent) de « ${name} » : retirez-le(s) d’abord.`, 409);
      const next = current.filter((n) => n !== name);
      setFicheSkills(agentsDir, slug, next);
      refresh();
      return { skill: name, slug, skills: next, changed: true, copies: copies(), notice: 'Pris en compte au prochain démarrage de Claude Code.' };
    },

    // Écrit les copies lues par Claude Code et Codex (action explicite).
    sync() { refresh(); return copies(); }
  };
}
