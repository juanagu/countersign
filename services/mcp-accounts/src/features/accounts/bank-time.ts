const OFFSET_PREFIX = 'GMT';
const UTC_OFFSET = '+00:00';

function partsIn(instant: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  }).formatToParts(instant);
  return Object.fromEntries(parts.map((p) => [p.type, p.value]));
}

/** The bank-local calendar day (YYYY-MM-DD) an instant falls on. */
export function bankDay(instant: Date, timeZone: string): string {
  const { year, month, day } = partsIn(instant, timeZone);
  return `${year}-${month}-${day}`;
}

/** ISO 8601 with the bank's offset (e.g. `-03:00`), so whoever reads it sees the local date, not UTC's. */
export function toBankIso(instant: Date, timeZone: string): string {
  const { hour, minute, second, timeZoneName = OFFSET_PREFIX } = partsIn(instant, timeZone);
  const offset = timeZoneName.slice(OFFSET_PREFIX.length) || UTC_OFFSET;
  const millis = String(instant.getUTCMilliseconds()).padStart(3, '0');
  return `${bankDay(instant, timeZone)}T${hour}:${minute}:${second}.${millis}${offset}`;
}
