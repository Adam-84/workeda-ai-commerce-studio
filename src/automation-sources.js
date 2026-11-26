import { hash } from './automation-core.js';
import { analyzeLogistics } from './integrations-core.js';
import { analyzeApps } from './shop-apps.js';

export function readAutomationSources(studio, d, now = Date.now()) {
  const entries = [], missing = [];
  for (const source of d.sources) {
    let snapshot = null, payload = null, at = null, partial = false, revision = null;
    if (['competitor', 'metrics'].includes(source)) { missing.push(`${source} : aucune source structurée disponible`); continue; }
    if (source === 'catalog') { snapshot = studio.shop.latest(); payload = snapshot; }
    else if (source === 'missions') { payload = studio.listMissions().filter((m) => !studio.automation.isAutomationMission(m.id)).map((m) => ({ id: m.id, state: m.state, updatedAt: m.updatedAt ?? m.created_at })); at = new Date(now).toISOString(); revision = hash(payload); }
    else if (source === 'recommendations') { payload = studio.memory.list({ state: 'pending', limit: 200 }).filter((m) => !m.missionId || !studio.automation.isAutomationMission(m.missionId)).map((m) => ({ id: m.id, state: m.state, updatedAt: m.updatedAt ?? m.createdAt })); at = new Date(now).toISOString(); revision = hash(payload); }
    else {
      if (!studio.integrations.store.hasGrant(source, d.agentSlug)) { missing.push(`${source} : accès non accordé à ${d.agentSlug}`); continue; }
      if (source === 'shopify_apps') { payload = studio.integrations.apps.list(); at = payload.map((a) => a.updatedAt).sort().at(-1); revision = studio.integrations.apps.revision(); if (!payload.length) payload = null; }
      else if (source === 'shopify_admin') { snapshot = studio.shop.latestAdmin(); payload = snapshot; if (snapshot) revision = hash({ domain: snapshot.domain, products: snapshot.products, orders: snapshot.orders, partial: snapshot.partial }); }
      else { snapshot = studio.integrations.store.latest(source, source === 'manual_import' ? 'import' : 'packages') ?? (source === 'dsers' ? studio.integrations.store.latest(source, 'products') : null); payload = snapshot?.payload; }
    }
    if (!payload) { missing.push(`${source} : données absentes`); continue; }
    at ??= snapshot?.fetchedAt; partial = Boolean(snapshot?.partial || payload.partial); revision ??= snapshot?.hash ?? hash(payload);
    if (!Number.isFinite(Date.parse(at)) || now - Date.parse(at) > d.freshnessMinutes * 60000 || Date.parse(at) > now + 60000) missing.push(`${source} : données périmées ou date inconnue`);
    entries.push({ source, revision, fetchedAt: at, partial, payload, id: snapshot?.id ?? revision });
  }
  const details = entries.map((e) => {
    if (e.source === 'shopify_apps') { const a = analyzeApps(e.payload, { now }); return { source: e.source, count: a.count, knownCosts: a.costs.totals, possibleOverlaps: a.duplicates.length, unknownCosts: a.costs.unknownCost.length }; }
    if (e.source === 'missions' || e.source === 'recommendations') return { source: e.source, records: e.payload.slice(0, 60), partial: e.payload.length > 60 };
    if (e.source === 'catalog') return { source: e.source, products: e.payload.products?.length ?? 0, collections: e.payload.collections?.length ?? 0 };
    if (e.payload.packages) { const a = analyzeLogistics(e.payload.packages, { now }); return { source: e.source, total: a.total, delayed: a.delayed, exceptions: a.exceptions, stale: a.stale }; }
    return { source: e.source, rows: e.payload.rows?.length ?? e.payload.products?.length ?? null };
  });
  return { entries, missing, hash: hash(entries.map(({ source, revision, partial }) => ({ source, revision, partial }))), summary: entries.map((e) => `${e.source} : ${e.fetchedAt}${e.partial ? ', partiel' : ''}`).join('\n') + '\nConstats déterministes (aperçu borné) : ' + JSON.stringify(details).slice(0, 10000) };
}

export function pollAutomationObservations(studio, now = Date.now()) {
  const a = studio.automation;
  for (const d of a.list().filter((d) => d.enabled && d.trigger.kind !== 'time')) {
    const data = readAutomationSources(studio, d, now);
    for (const e of data.entries) {
      if (d.trigger.kind === 'condition') {
        if (d.trigger.condition.kind === 'stale') a.evaluateCondition(d, e.source, { fetchedAt: e.fetchedAt });
        else if (!data.missing.length && !data.entries.some((entry) => entry.partial)) {
          if (d.trigger.condition.kind === 'variation') {
            const admin = data.entries.find((entry) => entry.source === 'shopify_admin');
            for (const p of admin?.payload.products ?? []) for (const v of p.variants ?? []) a.evaluatePrice(d, `variant:${v.id}`, { value: v.price, currency: p.currency, fetchedAt: admin.fetchedAt });
          } else for (const row of conditionRows(data.entries)) a.evaluateCondition(d, row.subject, row);
        }
        continue;
      }
      if (data.missing.length || e.partial) continue;
      if (e.source === 'catalog') a.observe({ source: e.source, subject: e.payload.domain ?? 'catalog', revision: e.revision, event: 'catalog.changed', fetchedAt: e.fetchedAt });
      if (e.source === 'missions') for (const m of e.payload) a.observe({ source: e.source, subject: m.id, revision: m.state, event: m.state === 'failed' ? 'mission.failed' : m.state === 'done' ? 'mission.done' : null, fetchedAt: m.updatedAt ?? e.fetchedAt });
      if (e.source === 'recommendations') for (const m of e.payload) a.observeNewRecommendation(m);
      if (['track17', 'dsers'].includes(e.source) && e.payload.packages) {
        const analysis = analyzeLogistics(e.payload.packages, { now });
        a.observe({ source: e.source, subject: 'logistics', revision: hash(analysis.anomalies), event: analysis.anomalies.length ? 'logistics.anomaly' : null, fetchedAt: e.fetchedAt });
      }
    }
  }
}

// Only matching SKU, unit purchase costs and same currency; shipping/tax unknown remains explicit.
function conditionRows(entries) {
  const admin = entries.find((e) => e.source === 'shopify_admin')?.payload;
  const rows = entries.find((e) => e.source === 'manual_import')?.payload?.rows ?? [];
  const out = [];
  for (const product of admin?.products ?? []) for (const v of product.variants ?? []) {
    const matches = rows.filter((r) => r.sku && r.sku === v.sku && r.costKind === 'purchase_unit');
    if (matches.length !== 1) continue;
    const r = matches[0];
    out.push({ subject: `sku:${v.sku}`, price: typeof v.price === 'number' ? v.price : NaN, cost: r.purchaseCost, currency: v.currency ?? product.currency, costCurrency: r.currency });
  }
  return out;
}
