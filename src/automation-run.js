import { randomUUID } from 'node:crypto';
import { readAutomationSources, pollAutomationObservations } from './automation-sources.js';
import { condition } from './automation-core.js';

export function createAutomationRunner({ studio, clock = () => new Date().toISOString(), everyMs = 15000, canRun = () => true } = {}) {
  const a = studio.automation, worker = randomUUID(); let timer = null, busy = false, stopped = false;
  function reconcile() {
    for (const r of a.running()) {
      const t = studio.comm.task(r.task_id);
      if (t.state === 'done') a.finish(r.id, 'done', 'Résultat Comms vérifié');
      else if (t.state === 'review') a.finish(r.id, 'awaiting_approval', 'Résultat à vérifier dans Comms');
      else if (['failed', 'blocked', 'expired', 'cancelled'].includes(t.state)) a.finish(r.id, t.state === 'blocked' && t.attempts > 0 ? 'uncertain' : t.state, 'Consulter la mission Comms avant toute reprise');
    }
  }
  async function tick() {
    if (busy || stopped) return; busy = true;
    try {
      reconcile();
      if (!canRun() || !a.status().owner || a.status().paused) return;
      pollAutomationObservations(studio, Date.parse(clock())); a.scheduleDue(); a.purge();
      const r = a.claim(worker); if (!r) return;
      const heartbeat = setInterval(() => a.renew(r.id, worker), 25000); heartbeat.unref?.();
      try {
        const d = a.rule(r.rule_id);
        const valid = () => a.owns(r.id, worker) && a.allowed(r) && !stopped && canRun();
        for (const source of d.consent.collect ?? []) {
          if (!valid()) { if (a.owns(r.id, worker)) a.finish(r.id, 'cancelled', 'Suspension avant collecte'); return; }
          if (!a.allowed(r) || stopped) return a.finish(r.id, 'cancelled', 'Suspension avant collecte');
          const current = readAutomationSources(studio, { ...d, sources: [source] }, Date.parse(clock()));
          if (current.entries.length && !current.missing.length) continue;
          if (!studio.integrations.realNetworkAllowed()) return a.finish(r.id, 'blocked', 'Réseau réel désactivé');
          if (source !== 'catalog' && !studio.integrations.store.hasGrant(source, d.agentSlug)) return a.finish(r.id, 'blocked', 'Permission retirée avant collecte');
          if (source === 'catalog') await studio.shop.refresh();
          else await studio.integrations.sync(source);
        }
        if (!valid()) { if (a.owns(r.id, worker)) a.finish(r.id, 'cancelled', 'Suspension avant analyse'); return; }
        const data = readAutomationSources(studio, d, Date.parse(clock()));
        const staleTrigger = d.trigger.kind === 'condition' && d.trigger.condition.kind === 'stale';
        const metadataOnly = staleTrigger && data.entries.length === d.sources.length && data.entries.every((e) => Number.isFinite(Date.parse(e.fetchedAt)) && Date.parse(e.fetchedAt) <= Date.parse(clock()));
        if (data.missing.length && !metadataOnly) return a.finish(r.id, 'blocked', data.missing.join(' ; '));
        if (staleTrigger) {
          if (!data.entries.some((e) => condition(d.trigger.condition, { fetchedAt: e.fetchedAt }, Date.parse(clock())).matched)) return a.finish(r.id, 'skipped', 'Source actualisée : la condition de péremption ne se vérifie plus.');
          data.summary = 'Données périmées : seules les dates sont examinées, aucun contenu ancien analysé.\n' + data.entries.map((e) => `${e.source} : dernier relevé ${e.fetchedAt}`).join('\n');
        }
        const agentId = studio.comm.agentOfSlug(d.agentSlug);
        if (!d.allowAi || staleTrigger) {
          a.tx(() => { const m = studio.createMission({ title: d.name, assignedTo: agentId, objective: d.objective, contextText: `Relevés :\n${data.summary.slice(0, 1600)}\nAnalyse déterministe ; coûts absents inconnus. Aperçu borné.`, requiresApproval: true }); a.linkMission(r.id, m.id); a.finish(r.id, 'done', 'Mission préparée sans appel IA ; validation humaine des recommandations.'); });
          return;
        }
        const reusable = studio.comm.reusableAutomation(d.agentSlug, `${d.id}:${d.revision}:${data.hash}`, d.freshnessMinutes * 60000);
        if (reusable) { a.tx(() => { a.link(r.id, reusable.id, data.hash); a.finish(r.id, 'done', 'Résultat vérifié récent réutilisé sans nouvel appel IA'); }); return; }
        if (!a.reserveAi(r.id)) return a.finish(r.id, 'waiting_ai', 'Autorisation, moteur IA, quota ou place indisponible ; reprise explicite.');
        a.tx(() => {
          const created = studio.comm.createTask({ assigneeId: agentId, title: d.name, instruction: `${d.objective}\nSources choisies, datées (aperçu borné) :\n${data.summary.slice(0, 1600)}\nLecture seule. Coûts absents inconnus ; pas de délégation. Toute action sensible exige une validation humaine.`, withCatalog: d.sources.includes('catalog'), withIntegrations: d.sources.filter((s) => ['shopify_apps', 'manual_import', 'shopify_admin', 'dsers', 'track17'].includes(s)), budgetUsd: d.budgetUsd, requiresApproval: true, dueAt: r.due_at, cacheKey: `${d.id}:${d.revision}:${data.hash}` }, { type: 'automation', runId: r.id });
          a.link(r.id, created.task.id, data.hash);
          if (!created.created && created.task.state === 'done') a.finish(r.id, 'done', 'Résultat vérifié récent réutilisé');
        });
      } catch (e) { if (a.owns(r.id, worker)) a.finish(r.id, 'blocked', 'Collecte ou préparation refusée ; consultez les sources et permissions.'); }
      finally { clearInterval(heartbeat); }
    } finally { busy = false; }
  }
  return { tick, start() { stopped = false; if (!timer && everyMs > 0) { timer = setInterval(() => tick().catch(() => {}), everyMs); timer.unref?.(); } return this; }, stop() { stopped = true; clearInterval(timer); timer = null; }, async idle() { while (busy) await new Promise((resolve) => setTimeout(resolve, 10)); } };
}
