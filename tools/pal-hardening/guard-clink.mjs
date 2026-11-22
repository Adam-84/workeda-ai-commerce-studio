// Proposition inactive : aucun accord ni nom de serveur ne contourne ce refus.
const deny = () => {
  process.stderr.write('Délégation PAL bloquée : Codex ou routage clink ambigu ; isolation non vérifiée. Aucun CLI lancé.\n');
  process.exitCode = 2;
};
let raw = '', oversized = false;
const timer = setTimeout(() => { deny(); process.exit(2); }, 4000);
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
    if (!/^mcp__.+__clink$/.test(name)) return;
    const input = event.tool_input;
    if (!input || Array.isArray(input) || typeof input !== 'object' || typeof input.cli_name !== 'string') return deny();
    // Seuls les identifiants réellement reconnus par le registre audité passent.
    if (!['claude', 'gemini', 'agy'].includes(input.cli_name.trim().toLowerCase())) return deny();
  } catch { deny(); }
});
