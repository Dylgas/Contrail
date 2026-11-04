// Contrail: flight lookup for the AI receptionist.
// GET /functions/v1/flight-lookup?from=BWI&to=Orlando&date=2026-12-04
// Returns a short, speakable list of the flights Contrail predicts for that day (same model as the website),
// plus a booking link with Contrail's affiliate marker. Public data only, so no key is needed.
// Deploy with JWT verification OFF.

const SITE = "https://dylgas.github.io/Contrail/";
const DATA = SITE + "data/";
const MARKER = "799756";
const AIRLINE: Record<string, string> = { AA: "American", DL: "Delta", UA: "United", WN: "Southwest", B6: "JetBlue", AS: "Alaska",
  HA: "Hawaiian", NK: "Spirit", F9: "Frontier", G4: "Allegiant", SY: "Sun Country", MX: "Breeze", XP: "Avelo" };
const DOW = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONL = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MIN_CONF = 30;

type T = { y: number; m: number; d: number };
type Row = [string, string, string, string, string, number, number, number | null, number, number, string];

const cache = new Map<string, { at: number; v: unknown }>();
async function getJSON(p: string): Promise<any> {
  const hit = cache.get(p);
  if (hit && Date.now() - hit.at < 6 * 3600e3) return hit.v;
  const r = await fetch(DATA + p);
  if (!r.ok) throw new Error(`${p}: ${r.status}`);
  const v = await r.json();
  cache.set(p, { at: Date.now(), v });
  return v;
}

const wd = (t: T) => (new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay() + 6) % 7;
const countWeekday = (y: number, m: number, w: number) => {
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); let n = 0;
  for (let d = 1; d <= days; d++) if (wd({ y, m, d }) === w) n++;
  return n;
};
const mins = (s: string) => (s ? +s.slice(0, 2) * 60 + +s.slice(2) : null);
const clock = (m: number) => { m = ((m % 1440) + 1440) % 1440; let h = Math.floor(m / 60); const mi = m % 60, ap = h < 12 ? "AM" : "PM"; h = h % 12 || 12; return `${h}:${String(mi).padStart(2, "0")} ${ap}`; };
const word = (c: number) => (c >= 85 ? "very likely" : c >= 65 ? "likely" : c >= 45 ? "possible" : "unlikely");

function evidence(months: string[], row: Row, t: T) {
  const w = wd(t), n = months.length;
  const ratio = (i: number) => { if (i < 0 || i >= n) return null; const [y, m] = months[i].split("-").map(Number);
    const poss = countWeekday(y, m, w); return poss ? Math.min(1, +row[10][i * 7 + w] / poss) : null; };
  let same = -1;
  for (let i = n - 1; i >= 0; i--) { const [y, m] = months[i].split("-").map(Number); if (m === t.m && y <= t.y) { same = i; break; } }
  const recent = [n - 1, n - 2].map(ratio).filter((v): v is number => v != null);
  const r2 = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const rs = same >= 0 ? ratio(same) : null;
  const adj = same >= 0 ? [same - 1, same + 1].map(ratio).filter((v): v is number => v != null) : [];
  const r3 = adj.length ? adj.reduce((a, b) => a + b, 0) / adj.length : r2;
  let s: number;
  if (rs != null) {
    s = 0.45 * rs + 0.4 * r2 + 0.15 * r3;
    if (r2 === 0 && rs > 0) s = 0.55 * rs; else if (rs === 0 && r2 > 0) s = 0.55 * r2;
  } else s = 0.75 * r2 + 0.25 * r3;
  const [ly, lm] = months[n - 1].split("-").map(Number);
  if ((t.y - ly) * 12 + (t.m - lm) > 10) s *= 0.9;
  return Math.round(Math.min(0.97, s) * 100);
}

function mergeSlots(months: string[], rows: Row[]): Row[] {
  const n = months.length * 7, groups: { c: string; times: number[]; months: Set<number>; rows: Row[] }[] = [];
  const monthsOf = (r: Row) => { const m = new Set<number>(); for (let i = 0; i < r[10].length; i++) if (+r[10][i]) m.add(Math.floor(i / 7)); return m; };
  const lastActive = (r: Row) => { for (let i = r[10].length - 1; i >= 0; i--) if (+r[10][i]) return i; return -1; };
  for (const r of rows.slice().sort((a, b) => mins(a[3])! - mins(b[3])!)) {
    const rm = monthsOf(r), t = mins(r[3])!;
    let best = null as null | typeof groups[0], bestGap = 99;
    for (const g of groups) {
      if (g.c !== r[0]) continue;
      const gap = Math.min(...g.times.map((x) => Math.abs(x - t))); if (gap > 30 || gap >= bestGap) continue;
      let both = 0; rm.forEach((m) => { if (g.months.has(m)) both++; });
      if (both <= Math.max(1, Math.floor(Math.min(rm.size, g.months.size) / 3))) { best = g; bestGap = gap; }
    }
    if (best) { best.rows.push(r); best.times.push(t); rm.forEach((m) => best!.months.add(m)); }
    else groups.push({ c: r[0], times: [t], months: rm, rows: [r] });
  }
  return groups.map((g) => {
    if (g.rows.length === 1) return g.rows[0];
    const lead = g.rows.reduce((a, b) => (lastActive(b) > lastActive(a) ? b : a));
    let grid = ""; for (let i = 0; i < n; i++) grid += Math.min(9, g.rows.reduce((s, r) => s + (+r[10][i] || 0), 0));
    return [...lead.slice(0, 10), grid] as Row;
  });
}

function tzOff(AP: any, code: string, t: T) {
  const tz = AP[code]?.tz; if (!tz) return null;
  try {
    const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const ms = Date.UTC(t.y, t.m - 1, t.d, 12), p: Record<string, string> = {};
    f.formatToParts(new Date(ms)).forEach((x) => (p[x.type] = x.value));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms) / 60000);
  } catch { return null; }
}

function leg(AP: any, months: string[], row: Row, from: string, to: string, t: T) {
  const conf = evidence(months, row, t), dep = mins(row[3])!;
  let arr = mins(row[4]); if (arr == null) arr = dep + (row[5] || 0);
  const o1 = tzOff(AP, from, t), o2 = tzOff(AP, to, t);
  const aDep = dep - (o1 ?? 0); let aArr = arr - (o2 ?? o1 ?? 0); while (aArr <= aDep) aArr += 1440;
  return { c: row[0], fn: row[1], from, to, dep, arr, aDep, aArr, conf, ot: row[7], nextDay: arr < dep };
}

function dist(AP: any, a: string, b: string) {
  const A = AP[a], B = AP[b]; if (!A || !B || A.la == null || B.la == null) return null;
  const r = (x: number) => (x * Math.PI) / 180, dl = r(B.la - A.la), dn = r(B.lo - A.lo);
  const h = Math.sin(dl / 2) ** 2 + Math.cos(r(A.la)) * Math.cos(r(B.la)) * Math.sin(dn / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
}

function resolve(AP: any, v: string): string | null {
  v = (v || "").trim(); if (!v) return null;
  const c = v.slice(0, 3).toUpperCase(); if (v.length <= 4 && AP[c]) return c;
  const m = /\(([A-Za-z]{3})\)/.exec(v); if (m && AP[m[1].toUpperCase()]) return m[1].toUpperCase();
  const q = v.toLowerCase().replace(/\b(international|intl|airport|regional)\b/g, "").replace(/\s+/g, " ").trim();
  const hits = Object.entries(AP).filter(([, a]: any) => (a.c || "").toLowerCase().startsWith(q) || (a.n || "").toLowerCase().includes(q));
  if (!hits.length) return AP[c] ? c : null;
  hits.sort((x: any, y: any) => (y[1].d || 0) - (x[1].d || 0));   // most-connected airport first
  return hits[0][0];
}

function parseDate(v: string): T | null {
  const s = (v || "").trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s); if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(s);
  const now = new Date(), Y = now.getUTCFullYear();
  if (m) { let y = m[3] ? +m[3] : Y; if (y < 100) y += 2000; const t = { y, m: +m[1], d: +m[2] };
    if (!m[3] && Date.UTC(t.y, t.m - 1, t.d) < Date.now() - 864e5) t.y++; return t; }
  const d = new Date(s + (/\d{4}/.test(s) ? "" : ` ${Y}`));
  if (!isNaN(+d)) { const t = { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    if (!/\d{4}/.test(s) && Date.UTC(t.y, t.m - 1, t.d) < Date.now() - 864e5) t.y++; return t; }
  return null;
}

const ddmm = (t: T) => String(t.d).padStart(2, "0") + String(t.m).padStart(2, "0");
const name = (c: string) => AIRLINE[c] || c;

async function lookup(fromQ: string, toQ: string, dateQ: string, retQ?: string) {
  const [meta, AP] = await Promise.all([getJSON("meta.json"), getJSON("airports.json")]);
  const o = resolve(AP, fromQ), d = resolve(AP, toQ), t = parseDate(dateQ), r = retQ ? parseDate(retQ) : null;
  if (!o || !d) return { ok: false, say: `I couldn't find the airport for "${!o ? fromQ : toQ}". Ask the caller for the city or airport again.` };
  if (!t) return { ok: false, say: `I couldn't read the date "${dateQ}". Ask the caller for the exact travel date.` };
  const months: string[] = meta.months;
  let out: Record<string, Row[]> = {}, inn: Record<string, Row[]> = {};
  try { out = await getJSON(`out/${o}.json`); } catch { /* no flights */ }
  try { inn = await getJSON(`in/${d}.json`); } catch { /* no flights */ }
  const M = (tab: Record<string, Row[]>, k: string) => mergeSlots(months, tab[k] || []);

  const nonstops = M(out, d).map((row) => leg(AP, months, row, o, d, t)).filter((l) => l.conf >= MIN_CONF)
    .sort((a, b) => b.conf - a.conf || a.dep - b.dep);
  const direct = dist(AP, o, d) || 0, conns: any[] = [];
  if (nonstops.length < 3) {
    for (const h of Object.keys(out)) {
      if (h === d || h === o || !inn[h]) continue;
      const d1 = dist(AP, o, h), d2 = dist(AP, h, d);
      if (direct && d1 != null && d2 != null && d1 + d2 > direct * 1.75 + 250) continue;
      const L1 = M(out, h).map((x) => leg(AP, months, x, o, h, t)).filter((l) => l.conf >= MIN_CONF && !l.nextDay);
      const L2 = M(inn, h).map((x) => leg(AP, months, x, h, d, t)).filter((l) => l.conf >= MIN_CONF);
      for (const a of L1) {
        const b = L2.filter((b) => b.c === a.c && b.aDep >= a.aArr + 40 && b.aDep <= a.aArr + 300).sort((x, y) => x.aDep - y.aDep)[0];
        if (b) conns.push({ a, b, hub: h, conf: Math.round(Math.min(a.conf, b.conf) * 0.95), dur: b.aArr - a.aDep });
      }
    }
    conns.sort((x, y) => y.conf - x.conf || x.dur - y.dur);
  }

  const day = `${DOW[wd(t)]}, ${MONL[t.m - 1]} ${t.d}, ${t.y}`;
  const city = (c: string) => (AP[c]?.c ? `${AP[c].c} (${c})` : c);
  const lines = [
    ...nonstops.slice(0, 5).sort((a, b) => a.dep - b.dep).map((l) => `${name(l.c)} flight ${l.fn}, nonstop, leaves ${clock(l.dep)}, arrives ${clock(l.arr)}${l.nextDay ? " the next day" : ""}: ${word(l.conf)} to run (${l.conf}%).`),
    ...conns.slice(0, nonstops.length ? 2 : 4).map((x) => `${name(x.a.c)} flights ${x.a.fn} and ${x.b.fn}, one stop in ${city(x.hub)}, leaves ${clock(x.a.dep)}, arrives ${clock(x.b.arr)}: ${word(x.conf)} (${x.conf}%).`),
  ];
  const link = `https://www.aviasales.com/search/${o}${ddmm(t)}${d}${r ? ddmm(r) : ""}1?marker=${MARKER}`;
  const route = `${SITE}#${o}-${d}-${t.y}${String(t.m).padStart(2, "0")}${String(t.d).padStart(2, "0")}`;
  return {
    ok: true, from: o, to: d, date: day,
    say: lines.length
      ? `Flights Contrail predicts from ${city(o)} to ${city(d)} on ${day}, based on what airlines flew in past months (predictions, not guarantees; prices are not included):\n- ${lines.join("\n- ")}`
      : `Contrail doesn't see a regular flight from ${city(o)} to ${city(d)} on ${day}. Offer a nearby airport or a different day, or have a specialist call back.`,
    booking_link: link,
    contrail_link: route,
  };
}

Deno.serve(async (req) => {
  const u = new URL(req.url);
  let q: Record<string, any> = Object.fromEntries(u.searchParams);
  if (req.method === "POST") { try { q = { ...q, ...(await req.json()) }; } catch { /* use query */ } }
  const from = q.from || q.origin || q.trip_from, to = q.to || q.destination || q.trip_to, date = q.date || q.departure_date;
  if (!from || !to || !date) return Response.json({ ok: false, say: "Send from, to and date (for example from=BWI, to=Orlando, date=2026-12-04)." }, { status: 400 });
  try { return Response.json(await lookup(String(from), String(to), String(date), q.return_date ? String(q.return_date) : undefined)); }
  catch (e) { console.error(e); return Response.json({ ok: false, say: "The flight lookup isn't available right now. Take the caller's details and have a specialist call back." }, { status: 200 }); }
});
