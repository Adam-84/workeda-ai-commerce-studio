// Réponse d'un agent par Claude Code (claude -p), sans aucun outil ni connecteur.
// La connexion Claude existante est utilisée telle quelle : aucun jeton n'est lu ni transmis ici.
import { spawn as nodeSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { SECTIONS } from './agent-files.js';

// Tout agent relié à une fiche .claude/agents répond ; un agent recruté à la main n'a pas de consigne et ne répond pas.
const TIMEOUT_MS = 180_000;
const PRIORITY = { low: 'basse', normal: 'normale', high: 'haute', urgent: 'urgente' };
const STATE = { draft: 'brouillon' };
const KIND = { fact: 'Fait', decision: 'Décision', open: 'Point ouvert' };
export const MAX_MISSIONS = 10, MAX_NOTES = 20; // ponytail: plafonds fixes du contexte, résumer si les missions s'allongent

export const claudeArgs = (model, system) => [
  '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose',
  '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands', '--no-session-persistence',
  '--model', model, '--system-prompt', system
];

export function systemPrompt(p) {
  const fiche = SECTIONS.map(([title, key]) => `## ${title}\n${p.sections[key]}`).join('\n\n');
  return `Tu es ${p.displayName}, ${p.role} chez Workeda (département ${p.department}). Voici ta fiche métier :\n\n${fiche}\n\n` +
    `Tu réponds à l'utilisateur dans la messagerie du Studio Workeda, en français, de façon directe et concise, en texte simple sans Markdown (pas d'astérisques ni de dièses ; listes avec des tirets ou des numéros). ` +
    `Dans cette messagerie tu n'as aucun outil ni connecteur : pas de fichiers, pas de commandes, pas d'accès à Shopify ni au web. ` +
    `Ne prétends jamais avoir consulté la boutique ou un document ; travaille avec ce que l'utilisateur écrit et dis-le quand une donnée manque. ` +
    `Le message contient aussi tes missions et leur mémoire, saisies à la main dans le Studio : appuie-toi dessus sans inventer ce qui n'y figure pas. Les liens qui y sont cités sont de simples références : tu ne les as pas consultés et tu ne peux pas les ouvrir. ` +
    `Tu ne peux pas contacter les autres agents depuis cette messagerie : ne dis pas que tu leur as transmis quelque chose.`;
}

// Missions confiées à l'agent (responsable, collaborateur ou demandeur) et leur mémoire non archivée → texte de contexte.
// memory(missionId) renvoie les notes de la plus récente à la plus ancienne.
export function missionsPrompt(missions, agentId, names, memory) {
  const roleOf = (m) => (m.assigned_to === agentId ? 'responsable' : m.collaborators.includes(agentId) ? 'collaborateur' : m.requested_by === agentId ? 'demandeur' : null);
  const mine = missions.filter((m) => roleOf(m) && !['done', 'cancelled'].includes(m.state)).slice(0, MAX_MISSIONS);
  if (!mine.length) return 'Missions : aucune mission ne t’est confiée dans le Studio pour le moment.';
  const blocks = mine.map((m) => {
    const notes = memory(m.id).filter((n) => !n.archivedAt).slice(0, MAX_NOTES);
    return [
      `Mission « ${m.title} » (ton rôle : ${roleOf(m)} ; priorité ${PRIORITY[m.priority] ?? m.priority} ; état ${STATE[m.state] ?? m.state} ; validation humaine ${m.requiresApproval ? 'requise' : 'non requise'})`,
      `Responsable : ${m.assigned_to ? names(m.assigned_to) : 'aucun'} ; collaborateurs : ${m.collaborators.map(names).join(', ') || 'aucun'}`,
      m.objective && `Objectif : ${m.objective}`,
      m.expectedResult && `Résultat attendu : ${m.expectedResult}`,
      m.contextText && `Contexte : ${m.contextText}`,
      m.contextLinks.length > 0 && `Liens de référence (non consultés, tu ne peux pas les ouvrir) :\n${m.contextLinks.map((u) => `- ${u}`).join('\n')}`,
      m.constraints && `Contraintes : ${m.constraints}`,
      m.validations && `Validations nécessaires : ${m.validations}`,
      notes.length
        ? `Mémoire (notes saisies à la main par l'utilisateur, la plus récente d'abord ; la source est déclarée, pas vérifiée) :\n${notes.map((n) => `- [${n.createdAt}${n.updatedAt ? `, corrigée ${n.updatedAt}` : ''}] ${KIND[n.kind] ?? n.kind} (source : ${n.sourceAgentId ? names(n.sourceAgentId) : 'l’utilisateur'}) : ${n.body}`).join('\n')}`
        : 'Mémoire : aucune note.'
    ].filter(Boolean).join('\n');
  });
  return `Tes missions enregistrées dans le Studio :\n\n${blocks.join('\n\n')}`;
}

// Historique (du plus ancien au plus récent) → texte envoyé sur l'entrée standard.
export function conversationPrompt(items, names, agentName) {
  const who = (m) => m.senderType === 'user' ? 'Utilisateur' : m.senderType === 'assistant' ? agentName : `${names(m.fromAgentId)} → ${names(m.toAgentId)} (échange entre agents)`;
  const lines = items.map((m) => `[${m.created_at}] ${who(m)} :\n${m.body}`);
  return `Historique de la discussion (le dernier message de l'Utilisateur attend ta réponse) :\n\n${lines.join('\n\n')}\n\nRéponds maintenant au dernier message de l'Utilisateur.`;
}

const explain = (text) => {
  const t = String(text || '');
  if (/not logged in|\/login|authenticat|invalid api key|credential|401/i.test(t)) return 'Claude Code n’est pas connecté sur ce PC. Lancez « claude » dans un terminal pour vous reconnecter, puis réessayez.';
  if (/rate.?limit|usage limit|429|quota/i.test(t)) return 'Limite d’utilisation de Claude atteinte. Réessayez plus tard.';
  if (/overload|529|503/i.test(t)) return 'Claude est momentanément surchargé. Réessayez dans un instant.';
  return `Claude n’a pas pu répondre${t ? ` : ${t.slice(0, 300)}` : '.'}`;
};

export function runClaude({ model, system, prompt, onText, spawn = nodeSpawn, timeoutMs = TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn('claude', claudeArgs(model, system), { cwd: tmpdir(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch (e) { return reject(new Error(explain(e.message))); }
    let buffer = '', streamed = '', result = null, stderr = '', settled = false;
    const finish = (error, text) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(text); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Claude n’a pas répondu à temps (3 minutes). Réessayez.')); }, timeoutMs);
    child.on('error', (e) => finish(new Error(e.code === 'ENOENT' ? 'Claude Code est introuvable sur ce PC (commande « claude » absente du PATH).' : explain(e.message))));
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim(); buffer = buffer.slice(i + 1);
        if (!line) continue;
        let event; try { event = JSON.parse(line); } catch { continue; }
        const delta = event.type === 'stream_event' && event.event?.type === 'content_block_delta' && event.event.delta?.type === 'text_delta' ? event.event.delta.text : '';
        if (delta) { streamed += delta; onText?.(delta); }
        if (event.type === 'result') result = event;
      }
    });
    child.on('close', (code) => {
      if (result && !result.is_error && result.subtype === 'success' && (result.result ?? streamed).trim()) return finish(null, (result.result ?? streamed).trim());
      finish(new Error(explain(result?.result || result?.errors?.join(' ') || stderr || (code ? `code de sortie ${code}` : 'réponse vide'))));
    });
    child.stdin.on('error', () => {}); // processus déjà terminé : l'erreur remonte par « close »
    child.stdin.end(prompt);
  });
}
