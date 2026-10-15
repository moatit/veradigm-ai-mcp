/**
 * Helpers for reading Unity MagicJson results.
 *
 * Unity usually answers an action with `[{ "<action>info": [ {row}, {row} ] }]` and lower-case
 * field names, but shapes vary by action and product. These helpers flatten that into plain rows
 * and read fields case-insensitively so parsers don't depend on one exact shape.
 */

/** Flatten a Unity result into an array of row objects. */
export function unityRows(data: any): Record<string, any>[] {
  if (data === undefined || data === null || data === '') return [];
  const items = Array.isArray(data) ? data : [data];
  const rows: Record<string, any>[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const keys = Object.keys(item);
    // { "getxxxinfo": [rows] } wrapper (one or more wrapper keys, all arrays)
    if (keys.length > 0 && keys.every((k) => Array.isArray(item[k]))) {
      for (const k of keys) {
        for (const r of item[k]) {
          if (r && typeof r === 'object') rows.push(r);
        }
      }
    } else {
      rows.push(item);
    }
  }
  return rows;
}

/** Field-name key: case- and underscore-insensitive ("Appointment_ID" == "AppointmentID"). */
const fieldKey = (k: string) => k.toLowerCase().replace(/_/g, '');

/** Read the first present field from a row, matching names case- and underscore-insensitively. */
export function pick(row: Record<string, any> | undefined, ...names: string[]): string {
  if (!row) return '';
  const lower: Record<string, any> = {};
  for (const k of Object.keys(row)) {
    const key = fieldKey(k);
    const cur = lower[key];
    if (cur === undefined || cur === null || String(cur).trim() === '') lower[key] = row[k];
  }
  for (const n of names) {
    const v = lower[fieldKey(n)];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

/** Parse a money string like "$1,234.50" or "(12.00)" into a number (NaN if not a number). */
export function parseMoney(v: string): number {
  if (!v) return NaN;
  const negative = /^\(.*\)$/.test(v.trim()) || v.trim().startsWith('-');
  const n = parseFloat(v.replace(/[^0-9.]/g, ''));
  if (isNaN(n)) return NaN;
  return negative ? -n : n;
}
