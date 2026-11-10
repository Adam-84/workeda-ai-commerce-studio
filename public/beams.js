// public/beams.js — faisceaux calculés uniquement à partir des messages et missions réels (pur).
export const LINK_WINDOW_MS = 24 * 3600 * 1000;
export function exchanges({ messages = [], missions = [], agents = [] }) {
  const dept = new Map(agents.map((a) => [a.id, a.department_id]));
  const out = [];
  for (const m of messages) {
    const from = dept.get(m.from_agent_id ?? m.fromAgentId), to = dept.get(m.to_agent_id ?? m.toAgentId);
    if (from && to) out.push({ id: `msg:${m.id}`, kind: 'message', from, to, at: Date.parse(m.created_at) });
  }
  for (const m of missions) {
    const to = m.assigned_to && dept.get(m.assigned_to); if (!to) continue;
    const from = (m.requested_by && dept.get(m.requested_by)) || 'hub';
    out.push({ id: `mission:${m.id}`, kind: 'mission', from, to, at: Date.parse(m.created_at) });
  }
  return out;
}
export function computeBeams({ messages, missions, agents, seen, now = Date.now() }) {
  const all = exchanges({ messages, missions, agents });
  const fresh = seen ? all.filter((e) => !seen.has(e.id)).map(({ id, kind, from, to }) => ({ id, kind, from, to, spark: from === to })) : [];
  const recent = all.filter((e) => e.from !== e.to && now - e.at <= LINK_WINDOW_MS);
  const links = [...new Map(recent.map((e) => [[e.from, e.to].sort().join('>'), { from: e.from, to: e.to }])).values()];
  return { fresh, links, ids: all.map((e) => e.id) };
}
