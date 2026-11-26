import { Temporal } from '@js-temporal/polyfill';

export function validateSchedule(s = {}) {
  const zone = s.zone ?? 'Europe/Paris';
  if (zone !== 'Europe/Paris' && zone !== 'UTC') throw new Error('Fuseau non pris en charge.');
  if (s.kind === 'once') { Temporal.Instant.from(s.at); return { kind: s.kind, at: new Date(s.at).toISOString(), zone }; }
  if (s.kind === 'interval') {
    if (!Number.isInteger(s.minutes) || s.minutes < 15 || s.minutes > 525600) throw new Error('Intervalle : 15 à 525600 minutes.');
    Temporal.Instant.from(s.anchor ?? '2026-01-01T00:00:00Z');
    return { kind: s.kind, minutes: s.minutes, anchor: s.anchor ?? '2026-01-01T00:00:00Z', zone };
  }
  if (!['daily', 'weekly', 'monthly'].includes(s.kind) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time ?? '')) throw new Error('Horaire invalide.');
  if (s.kind === 'weekly' && !(Number.isInteger(s.weekday) && s.weekday >= 1 && s.weekday <= 7)) throw new Error('Jour de semaine invalide.');
  if (s.kind === 'monthly' && !(Number.isInteger(s.day) && s.day >= 1 && s.day <= 31)) throw new Error('Jour du mois invalide.');
  return { kind: s.kind, time: s.time, zone, ...(s.kind === 'weekly' ? { weekday: s.weekday } : {}), ...(s.kind === 'monthly' ? { day: s.day } : {}) };
}

export function nextSlots(input, after, count = 5) {
  const s = validateSchedule(input), from = Temporal.Instant.from(after), n = Math.min(5, Math.max(1, count));
  if (s.kind === 'once') return Temporal.Instant.compare(Temporal.Instant.from(s.at), from) > 0 ? [s.at] : [];
  if (s.kind === 'interval') {
    const anchor = Date.parse(s.anchor), step = s.minutes * 60000;
    const first = anchor + Math.max(0, Math.floor((from.epochMilliseconds - anchor) / step) + 1) * step;
    return Array.from({ length: n }, (_, i) => new Date(first + i * step).toISOString());
  }
  let day = from.toZonedDateTimeISO(s.zone).toPlainDate();
  const out = [];
  for (let i = 0; i < 1900 && out.length < n; i++, day = day.add({ days: 1 })) {
    if (s.kind === 'weekly' && day.dayOfWeek !== s.weekday || s.kind === 'monthly' && day.day !== s.day) continue;
    const plain = day.toPlainDateTime(s.time);
    const zoned = plain.toZonedDateTime(s.zone, { disambiguation: 'earlier' });
    if (!zoned.toPlainDateTime().equals(plain)) continue; // nonexistent spring wall time
    const instant = zoned.toInstant();
    if (Temporal.Instant.compare(instant, from) > 0) out.push(new Date(instant.epochMilliseconds).toISOString());
  }
  return out;
}
