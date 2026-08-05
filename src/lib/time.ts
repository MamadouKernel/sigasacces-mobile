export const MIN = 60_000;

/** HH:MM local. */
export function fmt(ts: number): string {
  const d = new Date(ts);
  return (
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  );
}

export function fmtDur(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
}

export function durSince(from: number, now: number = Date.now()): string {
  return fmtDur(Math.max(0, Math.floor((now - from) / MIN)));
}
