// Display format per CV (02-CONVENTIONS:438, :1164): A.D. `DD/MM/YYYY hh:mm A`, time zone Asia/Kathmandu.
const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kathmandu',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** IsoUtc -> "06/11/2026 10:00 AM"; unparseable input -> "—" (never "Invalid Date"). */
export function formatDateTime(iso: string | undefined): string {
  const d = iso ? new Date(iso) : undefined;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const p: Record<string, string> = {};
  for (const x of FMT.formatToParts(d)) p[x.type] = x.value;
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${(p.dayPeriod ?? '').toUpperCase()}`.trim();
}
