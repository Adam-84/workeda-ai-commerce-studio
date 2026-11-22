// Réglage local, dans les briques de formulaire existantes de la fiche agent.
export function engineSettings({ agent, h, get, send, announce }) {
  const selected = h('select', { 'aria-label': 'Moteur de cet agent sur ce PC' },
    h('option', { value: 'claude', selected: agent.engine !== 'codex' }, 'Claude'),
    h('option', { value: 'codex', selected: agent.engine === 'codex' }, 'Codex'));
  const note = h('p', { class: 'note', role: 'status' });
  const err = h('p', { class: 'err', role: 'alert' });
  const save = h('button', { type: 'submit' }, 'Enregistrer le moteur');
  const path = `/api/comm/agents/${encodeURIComponent(agent.id)}/engine`;
  get(path).then(r => { agent.engine = r.engine; selected.value = r.engine; }).catch(e => { err.textContent = e.message; save.disabled = true; });
  return h('form', { class: 'memory-form', onsubmit: async e => {
    e.preventDefault(); err.textContent = ''; save.disabled = true;
    try { const r = await send('PUT', path, { engine: selected.value }); agent.engine = r.engine; note.textContent = 'Moteur enregistré sur ce PC. Les tâches existantes gardent leur moteur.'; announce('Moteur enregistré'); }
    catch (e) { err.textContent = e.message; } finally { save.disabled = false; }
  } }, h('label', {}, 'Moteur local de l’agent', selected),
  h('p', { class: 'note' }, 'Claude par défaut. Chaque tâche Comms peut choisir son moteur. Codex : contexte filtré envoyé à OpenAI pour la demande explicite, sans outils ; lancement bloqué si l’isolation requise manque. Aucun changement automatique de moteur. Les anciens fils agrégés demandent de passer par une tâche Comms.'), save, note, err);
}
