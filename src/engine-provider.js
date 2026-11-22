// Contrat commun : run(engine, options) → { text, engine, usage, costUsd, quota }.
// options : system, prompt, tools, signal, timeoutMs, onText, onEvent ; erreurs .code.
import { runClaude } from './claude-reply.js';
import { runCodex, EngineError, UNKNOWN_QUOTA, codexContext } from './codex-runner.js';
export const ENGINES = ['claude', 'codex'];
export function engineOf(value) {
  if (!ENGINES.includes(value)) throw Object.assign(new Error('Moteur invalide : choisissez claude ou codex.'), { status: 400, code: 'engine' });
  return value;
}
export function createEngineProvider({ claude = runClaude, codex = runCodex } = {}) {
  let codexActive = false;
  return { async run(engine, options) {
    engineOf(engine);
    if (engine === 'codex' && options.tools?.length) throw new EngineError('capability', 'Codex est sans outils : relancez la tâche sans recherche web.');
    if (engine === 'codex' && codexActive) throw new EngineError('quota', 'Une exécution Codex est déjà en cours sur ce PC (concurrence : 1).');
    if (options.signal?.aborted) throw new EngineError('cancelled', 'Exécution annulée.');
    if (engine === 'codex') codexActive = true;
    let usage = null, costUsd = null;
    const emit = ev => { try { options.onEvent?.({ ...ev, engine }); } catch { /* observation seulement */ } };
    try {
      const context = engine === 'codex' ? { system: codexContext(options.system ?? ''), prompt: codexContext(options.prompt ?? '') } : {};
      const value = await (engine === 'codex' ? codex : claude)({ ...options, ...context, onText(text) {
        emit({ type: 'text', text }); options.onText?.(text);
      }, onEvent(ev) {
        if (ev.type === 'result') {
          usage = ev.usage ? { input: ev.usage.input_tokens ?? 0, output: ev.usage.output_tokens ?? 0 } : null;
          costUsd = Number.isFinite(ev.total_cost_usd) ? ev.total_cost_usd : null;
          emit({ type: 'usage', usage, costUsd: engine === 'codex' ? null : costUsd });
        } else if (ev.type === 'usage') { usage = ev.usage; emit({ type: 'usage', usage, costUsd: engine === 'codex' ? null : ev.costUsd }); }
        else if (ev.type !== 'completed') emit({ type: 'observation', event: ev });
      } });
      const result = typeof value === 'string' ? { text: value, usage, costUsd } : value;
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new EngineError('protocol', 'Le moteur n’a fourni aucun texte final exploitable.');
      emit({ type: 'completed' });
      return { ...result, engine, usage: result.usage ?? usage, costUsd: engine === 'codex' ? null : result.costUsd ?? null, quota: result.quota ?? UNKNOWN_QUOTA };
    } catch (e) { e.code ??= 'execution'; e.engine = engine; emit({ type: 'error', code: e.code }); throw e; }
    finally { if (engine === 'codex') codexActive = false; }
  } };
}
