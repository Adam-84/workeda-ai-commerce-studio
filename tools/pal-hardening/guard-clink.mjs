// Garde PreToolUse : refuse toute délégation Codex/OpenAI non sécurisée. FERMÉ par défaut ; aucun accord ni nom de serveur ne le contourne.
//  - clink : liste d'autorisation de clients (claude, gemini, agy) ; Codex, inconnu, ambigu = refus ;
//  - autres outils PAL (API) : un modèle EXPLICITE appartenant à une liste d'autorisation non-OpenAI est exigé (absent/auto/inconnu = refus,
//    car PAL choisit alors le fournisseur et une clé OpenAI existe côté PAL) ; listmodels/version/apilookup ne contactent aucun modèle ;
//  - shell (Bash, PowerShell, terminal MCP) : une commande qui lance le CLI Codex en position de commande est refusée.
// Le réglage du projet ajoute « || exit 2 » : un échec de lancement du garde bloque aussi (Claude Code ne bloque que sur le code 2).
const deny = (msg = 'Délégation PAL bloquée : Codex ou routage clink ambigu ; isolation non vérifiée. Aucun CLI lancé.') => {
  process.stderr.write(`${msg}\n`);
  process.exitCode = 2;
};
const PAL_NO_MODEL = new Set(['listmodels', 'version', 'apilookup']);
// Seuls des noms de modèles reconnus comme NON-OpenAI passent (liste d'autorisation, pas de liste de refus : les alias OpenAI sont ouverts).
const ALLOWED_MODEL = /^(?:gemini|flash|pro$|flash-lite|grok|x-ai\/|xai\/|claude|sonnet|opus|haiku|anthropic\/|google\/|meta-llama\/|llama|mistral|mixtral|deepseek|qwen)/;
const OPENAI_MODEL = /codex|gpt|openai|chatgpt|davinci|(?:^|[^a-z0-9])o[1-9]/;
const modelOk = (m) => {
  if (typeof m !== 'string') return false;
  const t = m.normalize('NFKC').replace(/\p{Cf}/gu, '').trim().toLowerCase();
  return t !== '' && t !== 'auto' && ALLOWED_MODEL.test(t) && !OPENAI_MODEL.test(t);
};
// Lancement du CLI Codex dans une commande shell : paquet, fichiers du CLI, ou « codex » en position de commande (début, après ; & | ( ou un lanceur courant).
const CODEX_SHELL = /@openai\/codex|codex\.(?:js|cmd|exe|ps1)\b|(?:^|[;&|(]\s*|\b(?:cmd(?:\.exe)?\s+\/[ck]|bash\s+-c|sh\s+-c|env|sudo|call|start|npx(?:\s+-y)?|pnpm\s+dlx|bunx|yarn\s+dlx|npm\s+exec)\s+["']?)codex(?:\s|$|["'])/i;
const SHELL_TOOL = /^(?:bash|powershell|pwsh|mcp__.*terminal.*__(?:run_in_terminal|run_command|execute.*))$/;
let raw = '', oversized = false;
const timer = setTimeout(() => { deny(); process.exit(2); }, 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (Buffer.byteLength(raw) + Buffer.byteLength(chunk) > 262144) { oversized = true; raw = ''; }
  else if (!oversized) raw += chunk;
});
process.stdin.on('error', () => { clearTimeout(timer); deny(); });
process.stdin.on('end', () => {
  clearTimeout(timer);
  try {
    if (oversized) return deny();
    const event = JSON.parse(raw);
    if (!event || Array.isArray(event) || typeof event.tool_name !== 'string' || !event.tool_name.trim()) return deny();
    const name = event.tool_name.trim().toLowerCase();
    const input = event.tool_input;
    if (SHELL_TOOL.test(name)) {
      if (!input || Array.isArray(input) || typeof input !== 'object') return;
      const cmds = [input.command, input.cmd, input.script, input.input, input.text].filter((v) => typeof v === 'string');
      if (cmds.some((c) => CODEX_SHELL.test(c.normalize('NFKC').replace(/\p{Cf}/gu, '')))) return deny('Commande bloquée : lancement direct du CLI Codex non autorisé (isolation non vérifiée).');
      return;
    }
    if (/^mcp__.+__clink$/.test(name)) {
      if (!input || Array.isArray(input) || typeof input !== 'object' || typeof input.cli_name !== 'string') return deny();
      // Seuls les identifiants réellement reconnus par le registre audité passent.
      if (!['claude', 'gemini', 'agy'].includes(input.cli_name.trim().toLowerCase())) return deny();
      return;
    }
    const pal = /^mcp__[^]*pal[^]*?__(.+)$/.exec(name);
    if (pal) {
      if (PAL_NO_MODEL.has(pal[1])) return;
      if (!input || Array.isArray(input) || typeof input !== 'object') return deny('Délégation PAL bloquée : entrée inattendue sur une route API.');
      const listed = Array.isArray(input.models) ? input.models.map((m) => (m && typeof m === 'object' ? m.model : m)) : [];
      const models = input.model === undefined && listed.length ? listed : [input.model, ...listed]; // consensus : seulement models[] ; sinon model est obligatoire
      if (!models.length || models.some((m) => !modelOk(m))) return deny('Délégation PAL bloquée : modèle explicite non-OpenAI requis sur les routes API (absent, auto, OpenAI ou inconnu refusé).');
    }
  } catch { deny(); }
});
