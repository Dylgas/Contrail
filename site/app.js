/* Contrail: predicts flights from U.S. DOT on-time records. */
(() => {
"use strict";
const $ = s => document.querySelector(s);
const DATA = "data/";
const AIRLINE = {AA:"American",DL:"Delta",UA:"United",WN:"Southwest",B6:"JetBlue",AS:"Alaska",HA:"Hawaiian",NK:"Spirit",F9:"Frontier",
  G4:"Allegiant",SY:"Sun Country",MX:"Breeze",XP:"Avelo",VX:"Virgin America"};
const OPERATOR = {OH:"PSA Airlines",MQ:"Envoy",PT:"Piedmont","9E":"Endeavor Air",OO:"SkyWest",YX:"Republic Airways",ZW:"Air Wisconsin",
  C5:"CommuteAir",G7:"GoJet",QX:"Horizon Air",YV:"Mesa Airlines",EV:"ExpressJet",CP:"Compass",AX:"Trans States"};
const BRAND = {AA:"American Eagle",DL:"Delta Connection",UA:"United Express",AS:"Alaska Horizon"};
const DOW = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];
const DOWS = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONL = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const al = c => AIRLINE[c] || c;

/* ---------- data loading ---------- */
const cache = {};
const getJSON = p => cache[p] || (cache[p] = fetch(DATA + p).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }));
let META, AP;

/* ---------- dates ---------- */
const parseDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ""); return m ? {y:+m[1], m:+m[2], d:+m[3]} : null; };
const wd = t => (new Date(Date.UTC(t.y, t.m - 1, t.d)).getUTCDay() + 6) % 7;           // 0 = Monday
const iso = t => `${t.y}-${String(t.m).padStart(2,"0")}-${String(t.d).padStart(2,"0")}`;
const nice = t => `${DOWS[wd(t)]}, ${MON[t.m-1]} ${t.d}`;
const monthKey = (y, m) => `${y}-${String(m).padStart(2,"0")}`;
const monthName = k => { const [y, m] = k.split("-"); return `${MONL[+m-1]} ${y}`; };
function countWeekday(y, m, w) { const days = new Date(Date.UTC(y, m, 0)).getUTCDate(); let n = 0;
  for (let d = 1; d <= days; d++) if (wd({y, m, d}) === w) n++; return n; }
function todayLocal() { const n = new Date(); return {y:n.getFullYear(), m:n.getMonth()+1, d:n.getDate()}; }
const cmpDate = (a, b) => (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
const addDays = (t, n) => { const x = new Date(Date.UTC(t.y, t.m-1, t.d + n)); return {y:x.getUTCFullYear(), m:x.getUTCMonth()+1, d:x.getUTCDate()}; };

/* ---------- time helpers ---------- */
const mins = s => s ? (+s.slice(0,2)) * 60 + (+s.slice(2)) : null;
const clock = m => { m = ((m % 1440) + 1440) % 1440; let h = Math.floor(m/60), mi = m % 60, ap = h < 12 ? "AM" : "PM"; h = h % 12 || 12; return `${h}:${String(mi).padStart(2,"0")} ${ap}`; };
const hm = m => `${Math.floor(m/60)}h ${String(m%60).padStart(2,"0")}m`;

/* ---------- prediction ---------- */
// Row: [carrier, flight, operator, dep, arr, minutes, miles, ontime%, cancel%, avgDelay, weekdayGrid]
function evidence(row, t) {
  const w = wd(t), months = META.months, n = months.length;
  const ratio = i => { if (i < 0 || i >= n) return null; const [y, m] = months[i].split("-").map(Number);
    const poss = countWeekday(y, m, w); return poss ? Math.min(1, (+row[10][i*7 + w]) / poss) : null; };
  const ran = i => +row[10][i*7 + w];
  // same calendar month: the target month itself if in the data, else the latest earlier one
  let same = -1;
  for (let i = n - 1; i >= 0; i--) { const [y, m] = months[i].split("-").map(Number); if (m === t.m && (y < t.y || (y === t.y))) { same = i; break; } }
  const recent = [n-1, n-2].map(ratio).filter(v => v != null);
  const r2 = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const rs = same >= 0 ? ratio(same) : null;
  const adj = same >= 0 ? [same-1, same+1].map(ratio).filter(v => v != null) : [];
  const r3 = adj.length ? adj.reduce((a, b) => a + b, 0) / adj.length : r2;
  let s, kind = "steady";
  if (rs != null) {
    s = .45 * rs + .40 * r2 + .15 * r3;
    if (r2 === 0 && rs > 0) { s = .55 * rs; kind = "seasonal"; }
    else if (rs === 0 && r2 > 0) { s = .55 * r2; kind = "new"; }
  } else { s = .75 * r2 + .25 * r3; }
  const [ly, lm] = months[n-1].split("-").map(Number);
  const ahead = (t.y - ly) * 12 + (t.m - lm);
  if (ahead > 10) s *= .9;
  const conf = Math.round(Math.min(.97, s) * 100);
  const ev = {conf, kind, same: same >= 0 ? {k: months[same], ran: ran(same), of: (()=>{const [y,m]=months[same].split("-").map(Number);return countWeekday(y,m,w)})()} : null,
    last: {k: months[n-1], ran: ran(n-1), of: (()=>{const [y,m]=months[n-1].split("-").map(Number);return countWeekday(y,m,w)})()}};
  return ev;
}
const MIN_CONF = 30;

const offC = {};
function tzOff(code, t) {          // minutes ahead of UTC at noon on date t
  const tz = AP[code] && AP[code].tz; if (!tz) return null;
  const k = tz + iso(t); if (k in offC) return offC[k];
  try {
    const f = new Intl.DateTimeFormat("en-US", {timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"});
    const ms = Date.UTC(t.y, t.m - 1, t.d, 12), p = {}; f.formatToParts(new Date(ms)).forEach(x => p[x.type] = x.value);
    return offC[k] = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - ms) / 60000);
  } catch (e) { return offC[k] = null; }
}
function legOf(row, from, to, t) {
  const ev = evidence(row, t);
  const dep = mins(row[3]); let el = row[5] || 0;
  let arr = mins(row[4]); if (arr == null) arr = dep + el;
  const o1 = tzOff(from, t), o2 = tzOff(to, t);
  // absolute (UTC-based) minutes so durations and layovers are right across time zones
  const aDep = dep - (o1 ?? 0);
  let aArr = arr - (o2 ?? o1 ?? 0); while (aArr <= aDep) aArr += 1440;
  if (o1 != null && o2 != null) el = aArr - aDep;
  return {c: row[0], fn: row[1], op: row[2], from, to, dep, arr, el, aDep, aArr, mi: row[6], ot: row[7], cx: row[8], dl: row[9], ev,
    nextDay: arr < dep};
}

function dist(a, b) { const A = AP[a], B = AP[b]; if (!A || !B || A.la == null || B.la == null) return null;
  const r = x => x * Math.PI / 180, dl = r(B.la - A.la), dn = r(B.lo - A.lo);
  const h = Math.sin(dl/2)**2 + Math.cos(r(A.la)) * Math.cos(r(B.la)) * Math.sin(dn/2)**2; return 2 * 3958.8 * Math.asin(Math.sqrt(h)); }

async function forecast(o, d, t) {
  let out = {}, inn = {};
  try { out = await getJSON(`out/${o}.json`); } catch (e) {}
  try { inn = await getJSON(`in/${d}.json`); } catch (e) {}
  const its = [];
  for (const row of out[d] || []) {
    const leg = legOf(row, o, d, t);
    if (leg.ev.conf >= MIN_CONF) its.push({c: leg.c, legs: [leg], stops: 0, dur: leg.el, conf: leg.ev.conf, ot: leg.ot});
  }
  const direct = dist(o, d) || 0;
  const conns = [];
  for (const h of Object.keys(out)) {
    if (h === d || h === o || !inn[h]) continue;
    const d1 = dist(o, h), d2 = dist(h, d);
    if (direct && d1 != null && d2 != null && d1 + d2 > direct * 1.75 + 250) continue;
    const L1 = out[h].map(r => legOf(r, o, h, t)).filter(l => l.ev.conf >= MIN_CONF && !l.nextDay);
    const L2 = inn[h].map(r => legOf(r, h, d, t)).filter(l => l.ev.conf >= MIN_CONF);
    const best = {};               // one itinerary per connecting flight: the tightest comfortable connection
    for (const a of L1) {
      const b = L2.filter(b => b.c === a.c && b.aDep >= a.aArr + 40 && b.aDep <= a.aArr + 300).sort((x, y) => x.aDep - y.aDep)[0];
      if (!b) continue;
      const lay = b.aDep - a.aArr, key = b.c + b.fn;
      const cand = {c: a.c, legs: [a, b], stops: 1, hub: h, lay, dur: b.aArr - a.aDep,
        conf: Math.max(MIN_CONF, Math.round(Math.min(a.ev.conf, b.ev.conf) * .95) - (lay < 50 ? 3 : 0)),
        ot: a.ot != null && b.ot != null ? Math.round(a.ot * b.ot / 100) : null};
      const cur = best[key];
      let better = !cur;
      if (cur) { if (cand.conf > cur.conf + 10) better = true; else if (cur.conf > cand.conf + 10) better = false;
        else if ((cand.lay >= 50) !== (cur.lay >= 50)) better = cand.lay >= 50; else better = cand.lay < cur.lay; }
      if (better) best[key] = cand;
    }
    conns.push(...Object.values(best));
  }
  const bestNon = its.length ? Math.min(...its.map(x => x.dur)) : Infinity;
  conns.sort((a, b) => a.dur - b.dur);
  const fastestConn = conns.length ? conns[0].dur : 0;
  const keep = conns.filter(x => x.dur <= Math.min(fastestConn + 240, bestNon * 2.3)).slice(0, its.length >= 4 ? 12 : 40);
  return its.concat(keep);
}

/* ---------- state ---------- */
const S = {o:"BWI", d:"DAB", d1:null, d2:null, leg:0, res:[[],[]], filt:new Set(), nonstopOnly:false, sort:"dep", open:null, showAll:false};

function resolve(v) {
  v = (v || "").trim(); const c = v.slice(0, 3).toUpperCase(); if (AP[c]) return c;
  const q = v.toLowerCase(); if (!q) return null;
  const hits = Object.entries(AP).filter(([k, a]) => (a.c || "").toLowerCase().startsWith(q) || (a.n || "").toLowerCase().startsWith(q));
  hits.sort((a, b) => (b[1].d || 0) - (a[1].d || 0)); return hits.length ? hits[0][0] : null;
}
const city = c => AP[c] ? AP[c].c : c;
function nameHints() { for (const [id, n] of [["from","fromName"],["to","toName"]]) { const c = resolve($("#" + id).value);
  $("#" + n).textContent = c ? `${AP[c].c} · ${c}` : ($("#" + id).value ? "No flight records for this airport" : " "); } }

async function run() {
  const o = resolve($("#from").value), d = resolve($("#to").value), d1 = parseDate($("#d1").value), d2 = parseDate($("#d2").value), err = $("#err");
  let msg = "";
  if (!o || !d) msg = "We don't have flight records for that airport. Try a U.S. airport code like BWI, MCO or LAX.";
  else if (o === d) msg = "Pick two different airports.";
  else if (!d1) msg = "Choose a departure date.";
  else if (cmpDate(d1, todayLocal()) < 0) msg = "That departure date has passed. Pick a date from today on.";
  else if (d2 && cmpDate(d2, d1) < 0) msg = "The return date is before the departure date.";
  err.hidden = !msg; err.textContent = msg; if (msg) return false;
  Object.assign(S, {o, d, d1, d2, leg:0, open:null, showAll:false, nonstopOnly:false}); S.filt.clear();
  $("#list").innerHTML = `<div class="loading"><span class="spin"></span>Reading flight records…</div>`;
  S.res = await Promise.all([forecast(o, d, d1), d2 ? forecast(d, o, d2) : Promise.resolve([])]);
  renderAll();
  S.hash = `#${o}-${d}-${iso(d1).replace(/-/g, "")}${d2 ? "-" + iso(d2).replace(/-/g, "") : ""}`;
  try { history.replaceState(null, "", `#${o}-${d}-${iso(d1).replace(/-/g, "")}${d2 ? "-" + iso(d2).replace(/-/g, "") : ""}`); } catch (e) {}
  return true;
}
function fromHash() {
  const m = /^#([A-Z0-9]{3})-([A-Z0-9]{3})-(\d{8})(?:-(\d{8}))?$/.exec(location.hash || "");
  if (!m) return false;
  const f = x => x ? `${x.slice(0,4)}-${x.slice(4,6)}-${x.slice(6)}` : "";
  $("#from").value = m[1]; $("#to").value = m[2]; $("#d1").value = f(m[3]); $("#d2").value = f(m[4]);
  return true;
}

/* ---------- rendering ---------- */
const idOf = it => it.legs.map(l => l.c + l.fn + l.from).join("-");
const confWord = c => c >= 85 ? "Very likely" : c >= 65 ? "Likely" : c >= 45 ? "Possible" : "Long shot";
const meter = c => { const n = c >= 85 ? 4 : c >= 65 ? 3 : c >= 45 ? 2 : 1; return `<span class="meter" aria-hidden="true">${[0,1,2,3].map(i => `<i class="${i < n ? "on" : ""}"></i>`).join("")}</span>`; };
const riskOf = m => m < 55 ? ["Tight connection", "var(--warn)"] : m > 180 ? ["Long wait", "var(--soft)"] : ["Comfortable connection", "var(--good)"];
const MARKER = "799756", PROJECT = "594943";
const ddmm = t => String(t.d).padStart(2, "0") + String(t.m).padStart(2, "0");
// Aviasales search link carrying the Contrail partner ID, so bookings earn a commission.
const gf = (o, d, t, _extra, back) => `https://www.aviasales.com/search/${o}${ddmm(t)}${d}${back ? ddmm(back) : ""}1?marker=${MARKER}`;
function renderPrices() {
  const box = $("#priceBox"); box.innerHTML = "";
  const q = new URLSearchParams({currency: "usd", trs: PROJECT, shmarker: MARKER, powered_by: "true", locale: "en",
    from_name: S.o, to_name: S.d, departure: iso(S.d1), show_header: "true", limit: "10",
    primary_color: "0A0A0A", results_background_color: "FFFFFF", form_background_color: "F4F5F6", campaign_id: "111", promo_id: "4478"});
  if (S.d2) q.set("return", iso(S.d2));
  const sc = document.createElement("script"); sc.async = true; sc.charset = "utf-8";
  sc.src = "https://tpscr.com/content?" + q.toString();
  sc.onerror = () => { box.innerHTML = `<div class="empty">Live prices didn't load. <a href="${gf(S.o, S.d, S.d1, "", S.d2)}" target="_blank" rel="noopener">See prices on Aviasales ↗</a></div>`; };
  box.appendChild(sc);
  $("#priceSub").textContent = `Real fares for ${S.o} to ${S.d}, ${nice(S.d1)}${S.d2 ? " – " + nice(S.d2) : ""}. Pick one to finish booking with Kiwi.com, which issues your ticket and handles any changes.`;
}

function renderAll() {
  const o = S.o, d = S.d, r = S.res[0];
  $("#capBig").textContent = `${city(o)} to ${city(d)}`;
  const mi = dist(o, d);
  $("#capSub").textContent = `${nice(S.d1)}${S.d2 ? " – " + nice(S.d2) : ""}${mi ? ` · ${Math.round(mi).toLocaleString()} miles` : ""}`;
  $("#rtTitle").textContent = `${o} to ${city(d)}`;
  const ns = r.filter(x => !x.stops).length, hubs = [...new Set(r.filter(x => x.stops).map(x => city(x.hub)))];
  $("#rtSub").textContent = ns ? `${ns} nonstop flight${ns > 1 ? "s" : ""} likely on ${nice(S.d1)}${hubs.length ? ", plus connections" : ""}.`
    : r.length ? `No nonstop has flown this route recently. The likely trips connect in ${hubs.slice(0, 2).join(" or ")}.`
    : "No airline in the records flies this trip, even with one stop.";
  $("#results").hidden = false;
  renderFacts(); renderTabs(); renderChips(); renderList(); renderCal(); renderBest(); renderCompare(); renderPrices(); setRoute();
  $("#copied").textContent = "";
}

function renderFacts() {
  const r = S.res[0], mi = dist(S.o, S.d), fastest = r.length ? Math.min(...r.map(x => x.dur)) : null;
  const best = r.length ? Math.max(...r.map(x => x.conf)) : null, als = new Set(r.map(x => x.c)).size;
  const ots = r.filter(x => x.ot != null).map(x => x.ot), ot = ots.length ? Math.round(ots.reduce((a, b) => a + b, 0) / ots.length) : null;
  $("#facts").innerHTML = [
    [mi ? `${Math.round(mi).toLocaleString()} mi` : "—", "Straight-line distance"],
    [fastest ? hm(fastest) : "—", "Fastest likely trip"],
    [`${r.length}`, `Likely options on ${DOW[wd(S.d1)]}`],
    [als ? `${als}` : "—", "Airlines that fly it"],
    [ot != null ? `${ot}%` : "—", "Average on-time arrival"],
    [best ? `${best}%` : "—", "Highest confidence"]
  ].map(([b, s]) => `<li><b>${b}</b><span>${s}</span></li>`).join("");
}

function renderTabs() {
  const t = [[`Outbound · ${nice(S.d1)}`, 0]]; if (S.d2) t.push([`Return · ${nice(S.d2)}`, 1]);
  $("#tabs").innerHTML = t.map(([l, i]) => `<button class="tab" role="tab" aria-selected="${S.leg === i}" data-i="${i}">${l}</button>`).join("");
  $("#tabs").querySelectorAll("button").forEach(b => b.onclick = () => { S.leg = +b.dataset.i; S.open = null; S.showAll = false; S.filt.clear(); S.nonstopOnly = false; renderTabs(); renderChips(); renderList(); setRoute(); });
}

function renderChips() {
  const r = S.res[S.leg], als = [...new Set(r.map(x => x.c))], hasNs = r.some(x => !x.stops), hasCn = r.some(x => x.stops);
  $("#chips").innerHTML = (hasNs && hasCn ? `<button class="chip" aria-pressed="${S.nonstopOnly}" data-ns="1">Nonstop only</button>` : "") +
    als.map(a => `<button class="chip" aria-pressed="${S.filt.has(a)}" data-al="${a}">${al(a)}</button>`).join("");
  $("#chips").querySelectorAll("button").forEach(b => b.onclick = () => { if (b.dataset.ns) S.nonstopOnly = !S.nonstopOnly; else { const a = b.dataset.al; S.filt.has(a) ? S.filt.delete(a) : S.filt.add(a); }
    S.open = null; renderChips(); renderList(); setRoute(); });
}

function visible() {
  let r = S.res[S.leg].slice(); if (S.nonstopOnly) r = r.filter(x => !x.stops); if (S.filt.size) r = r.filter(x => S.filt.has(x.c));
  const k = {dep: x => x.legs[0].dep, dur: x => x.dur, conf: x => -x.conf, ot: x => -(x.ot ?? -1)}[S.sort];
  return r.sort((a, b) => k(a) - k(b) || a.stops - b.stops || a.dur - b.dur);
}

function renderList() {
  const r = visible(), o = S.leg ? S.d : S.o, d = S.leg ? S.o : S.d, t = S.leg ? S.d2 : S.d1, anyNs = S.res[S.leg].some(x => !x.stops);
  $("#note").textContent = (S.res[S.leg].length && !anyNs ? `No nonstop has flown ${o} to ${d} recently. ` : "") +
    `${r.length} likely option${r.length === 1 ? "" : "s"}. Times are local to each airport. Based on records through ${monthName(META.months[META.months.length-1])}.`;
  if (!r.length) { $("#list").innerHTML = `<div class="empty">${S.res[S.leg].length ? "No flights match these filters. Try clearing them." : "No airline in the records flies this trip, even with one stop. The records cover U.S. domestic flights by major airlines."}</div>`; return; }
  const show = S.showAll ? r : r.slice(0, 10);
  $("#list").innerHTML = show.map(it => {
    const f = it.legs[0], l = it.legs[it.legs.length - 1], id = idOf(it), open = S.open === id, op = it.legs.find(x => x.op);
    const lday = d => Math.floor((l.aArr + (tzOff(d, t) ?? 0)) / 1440), arrPlus = lday(d) > 0;
    return `<div class="row"><button aria-expanded="${open}" data-id="${id}">
      <div><div class="tm">${clock(f.dep)} – ${clock(l.arr)}${arrPlus ? `<sup>+1 day</sup>` : ""}</div><div class="who">${al(it.c)} · ${it.legs.map(x => x.c + " " + x.fn).join(", ")}</div></div>
      <div class="path"><div class="ends"><span>${o}</span><span>${d}</span></div><div class="bar">${it.stops ? `<i style="left:${Math.round(f.el / it.dur * 100)}%"></i>` : ""}</div>
        <div class="mid">${it.stops ? `${it.lay} min in ${city(it.hub)}` : "Nonstop"}${op ? ` · ${OPERATOR[op.op] || op.op}` : ""}</div></div>
      <div class="dur"><b>${hm(it.dur)}</b><span>${it.stops ? "1 stop" : "Nonstop"}${it.ot != null ? ` · ${it.ot}% on time` : ""}</span></div>
      <div class="lk"><b>${confWord(it.conf)}</b>${meter(it.conf)}<span>${it.conf}% confidence</span></div>
      <svg class="chev" width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg></button>
      ${open ? detail(it, o, d, t) : ""}</div>`;
  }).join("") + (r.length > 10 && !S.showAll ? `<div class="more"><button class="btn btn-line" id="more">Show all ${r.length} options</button></div>` : "");
  $("#list").querySelectorAll(".row > button").forEach(b => b.onclick = () => { S.open = S.open === b.dataset.id ? null : b.dataset.id; renderList(); setRoute(); });
  const m = $("#more"); if (m) m.onclick = () => { S.showAll = true; renderList(); };
  $("#list").querySelectorAll("[data-ics]").forEach(b => b.onclick = () => { const it = r.find(x => idOf(x) === b.dataset.ics); if (it) downloadIcs(it, o, d, t); });
}

function reasons(leg, t) {
  const e = leg.ev, day = DOW[wd(t)] + "s", r = [];
  if (e.same) r.push(`Flew ${e.same.ran} of ${e.same.of} ${day} in ${monthName(e.same.k)}.`);
  if (!e.same || e.same.k !== e.last.k) r.push(`Flew ${e.last.ran} of ${e.last.of} ${day} in ${monthName(e.last.k)}, the latest month in the records.`);
  if (e.kind === "seasonal") r.push("It ran in this season last year but not in recent months, so it may be a seasonal flight.");
  if (e.kind === "new") r.push("It didn't run this time last year but runs now, so it may be a newer flight.");
  return r;
}

const WINDOW = 331;   // most U.S. airlines open bookings about 331 days ahead
function saleBox(it, o, d, t) {
  const open = addDays(t, -WINDOW), live = cmpDate(open, todayLocal()) <= 0, wn = it.c === "WN";
  if (live) return `<div class="sale"><div><span class="live">On sale now</span><span>Book with ${al(it.c)} or a booking site.</span></div></div>`;
  return `<div class="sale"><div><b>Goes on sale around ${nice(open)}, ${open.y}</b><span>${wn ? "Southwest opens its schedule in batches, so this date is a rough estimate." : "Airlines usually open bookings about 11 months ahead."}</span></div>
    <div class="why-actions"><a class="btn btn-black btn-sm" href="${gcal(it, o, d, t)}" target="_blank" rel="noopener">Remind me in Google Calendar</a>
    <button class="btn btn-line btn-sm" type="button" data-ics="${idOf(it)}">Apple or Outlook calendar</button></div></div>`;
}
function gcal(it, o, d, t) {
  const open = addDays(t, -WINDOW), ymd = x => iso(x).replace(/-/g, ""), nums = it.legs.map(l => l.c + " " + l.fn).join(" + ");
  const q = new URLSearchParams({action: "TEMPLATE", text: `Book ${al(it.c)} ${nums}, ${o} to ${d} on ${nice(t)}`,
    dates: `${ymd(open)}/${ymd(addDays(open, 1))}`, details: `Bookings for ${nice(t)}, ${t.y} should open around today. Check prices: ${gf(o, d, t, al(it.c))}`});
  return "https://calendar.google.com/calendar/render?" + q.toString();
}
function downloadIcs(it, o, d, t) {
  const open = addDays(t, -WINDOW), stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ymd = x => iso(x).replace(/-/g, ""), next = addDays(open, 1), nums = it.legs.map(l => l.c + " " + l.fn).join(" + ");
  const esc = x => x.replace(/[,;\\]/g, m => "\\" + m);
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Contrail//Flight reminder//EN", "BEGIN:VEVENT",
    `UID:${idOf(it)}-${ymd(t)}@contrail`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${ymd(open)}`, `DTEND;VALUE=DATE:${ymd(next)}`,
    `SUMMARY:${esc(`Book ${al(it.c)} ${nums}, ${o} to ${d} on ${nice(t)}`)}`,
    `DESCRIPTION:${esc(`Bookings for ${nice(t)}, ${t.y} should open around today. Check prices: ${gf(o, d, t, al(it.c))}`)}`,
    "BEGIN:VALARM", "TRIGGER:PT9H", "ACTION:DISPLAY", "DESCRIPTION:Flight goes on sale", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], {type: "text/calendar"}));
  a.download = `contrail-${o}-${d}-${ymd(t)}.ics`; document.body.appendChild(a); a.click(); a.remove();
}

function detail(it, o, d, t) {
  const legs = it.legs.map((x, i) => {
    const opName = x.op ? `Operated by ${OPERATOR[x.op] || x.op}${BRAND[x.c] ? ` as ${BRAND[x.c]}` : ""} · ` : "";
    return `<div class="leg"><div class="top"><span class="fn">${al(x.c)} ${x.fn}</span><span class="t">${x.from} ${clock(x.dep)} → ${x.to} ${clock(x.arr)}${x.nextDay ? " (+1)" : ""}</span></div>
      <div class="s">${opName}${x.mi ? x.mi.toLocaleString() + " mi · " : ""}${hm(x.el)} scheduled</div></div>` +
      (i === 0 && it.stops ? (() => { const [tx, c] = riskOf(it.lay); return `<div class="lay"><span class="dot" style="background:${c}"></span>${it.lay} min in ${city(it.hub)} · ${tx}</div>`; })() : "");
  }).join("");
  const stats = it.legs.length === 1 ? it.legs[0] : null;
  const s3 = stats ? `<div class="stat3"><div><b>${stats.ot ?? "—"}%</b><span>Arrived on time</span></div><div><b>${stats.cx}%</b><span>Cancelled</span></div><div><b>${stats.dl ? stats.dl + " min" : "—"}</b><span>Average delay when late</span></div></div>`
    : `<div class="stat3"><div><b>${it.ot ?? "—"}%</b><span>Both legs on time</span></div><div><b>${Math.max(...it.legs.map(l => l.cx))}%</b><span>Worst leg cancelled</span></div><div><b>${it.lay} min</b><span>Time to connect</span></div></div>`;
  const sale = saleBox(it, o, d, t);
  const why = it.legs.map(l => `<li><b style="font-weight:500">${l.c} ${l.fn}:</b> ${reasons(l, t).join(" ")}</li>`).join("");
  return `<div class="detail"><div class="legs">${legs}</div><div class="why">
    ${sale}<h4>Track record over the past year</h4>${s3}
    <h4>Why we predict this</h4><ul>${why}</ul>
    <div class="why-actions"><a class="btn btn-black btn-sm" href="#prices">See live prices</a><a class="btn btn-line btn-sm" href="${gf(o, d, t)}" target="_blank" rel="noopener">Compare on Aviasales ↗</a></div></div></div>`;
}

async function renderCal() {
  const t = S.d1, first = {y: t.y, m: t.m, d: 1}, days = new Date(Date.UTC(t.y, t.m, 0)).getUTCDate(), today = todayLocal();
  $("#calTitle").textContent = `${MONL[t.m - 1]} ${t.y}`;
  // Predictions depend on the weekday and month, so one forecast per weekday covers the month.
  const counts = await Promise.all(DOWS.map((_, w) => { let x = first; while (wd(x) !== w) x = addDays(x, 1); return forecast(S.o, S.d, x).then(r => r.length); }));
  const mx = Math.max(1, ...counts), lvl = c => !c ? "" : c >= mx * .85 ? "l4" : c >= mx * .6 ? "l3" : c >= mx * .3 ? "l2" : "l1";
  let h = DOWS.map(x => `<div class="h">${x.slice(0, 2)}</div>`).join("") + "<div></div>".repeat(wd(first));
  for (let d = 1; d <= days; d++) { const x = {y: t.y, m: t.m, d}, c = counts[wd(x)], past = cmpDate(x, today) < 0;
    h += `<button type="button" class="${lvl(c)}${d === t.d ? " sel" : ""}" data-d="${iso(x)}" ${past ? "disabled" : ""} aria-label="${nice(x)}: ${c} likely options"><b>${d}</b><span>${c}</span></button>`; }
  $("#cal").innerHTML = h;
  $("#cal").querySelectorAll("button").forEach(b => b.onclick = async () => {
    const nd = parseDate(b.dataset.d), gap = S.d2 ? Math.round((Date.UTC(S.d2.y, S.d2.m - 1, S.d2.d) - Date.UTC(S.d1.y, S.d1.m - 1, S.d1.d)) / 864e5) : null;
    $("#d1").value = b.dataset.d; if (gap != null) $("#d2").value = iso(addDays(nd, gap));
    if (await run()) document.getElementById("flights").scrollIntoView({behavior: reduce ? "auto" : "smooth"});
  });
}

function renderBest() {
  const r = S.res[0], B = [["Morning", "Before noon", 0, 720], ["Afternoon", "Noon to 5 PM", 720, 1020], ["Evening", "After 5 PM", 1020, 1440]];
  const rows = B.map(([n, sub, lo, hi]) => { const xs = r.filter(x => x.ot != null && x.legs[0].dep >= lo && x.legs[0].dep < hi);
    return {n, sub, k: xs.length, ot: xs.length ? Math.round(xs.reduce((a, x) => a + x.ot, 0) / xs.length) : null}; });
  const have = rows.filter(x => x.ot != null), best = have.length ? have.reduce((a, b) => b.ot > a.ot ? b : a) : null;
  $("#tod").innerHTML = rows.map(x => `<div class="r${best && x === best && have.length > 1 ? " best" : ""}"><div>${x.n}<br><span>${x.sub}</span></div>
    <div class="track"><i style="width:${x.ot ?? 0}%"></i></div><b>${x.ot != null ? x.ot + "%" : "—"}</b></div>`).join("");
  const top = r.filter(x => x.ot != null).sort((a, b) => b.ot - a.ot || b.conf - a.conf)[0];
  $("#tip").innerHTML = !have.length ? "Not enough history on this route to compare times of day."
    : (have.length > 1 ? `<b style="font-weight:500">${best.n} flights</b> have the best record on this route. ` : "") +
      (top ? `The most reliable option is ${top.legs.map(l => l.c + " " + l.fn).join(" + ")} at ${clock(top.legs[0].dep)}, on time ${top.ot}% of the time.` : "");
}

function renderCompare() {
  const r = S.res[0], by = {};
  for (const x of r) (by[x.c] = by[x.c] || []).push(x);
  const rows = Object.entries(by).map(([c, xs]) => { const ns = xs.filter(x => !x.stops).length, hubs = [...new Set(xs.filter(x => x.stops).map(x => x.hub))];
    const ot = xs.filter(x => x.ot != null).map(x => x.ot);
    return {c, ns, hubs, n: xs.length, fast: Math.min(...xs.map(x => x.dur)), ot: ot.length ? Math.round(ot.reduce((a, b) => a + b, 0) / ot.length) : null}; })
    .sort((a, b) => b.ns - a.ns || a.fast - b.fast);
  $("#cmpSub").textContent = `${nice(S.d1)} · ${S.o} to ${S.d}`;
  $("#cmp").innerHTML = rows.length ? `<thead><tr><th>Airline</th><th>Routing</th><th>Options</th><th>Fastest</th><th>On time</th></tr></thead><tbody>` +
    rows.map(x => `<tr><td>${al(x.c)}</td><td>${x.ns ? "Nonstop" : "Via " + x.hubs.join(", ")}</td><td class="n">${x.n}</td><td class="n">${hm(x.fast)}</td><td class="n">${x.ot != null ? x.ot + "%" : "—"}</td></tr>`).join("") + "</tbody>"
    : `<tbody><tr><td>No airline in the records flies this trip.</td></tr></tbody>`;
}

/* ---------- canvases ---------- */
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const rad = d => d * Math.PI / 180;
function canvasOf(id) { const cv = $(id), ctx = cv.getContext("2d"), o = {cv, ctx, W: 0, H: 0};
  new ResizeObserver(() => { const r = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1); o.W = r.width; o.H = r.height; cv.width = r.width * dpr; cv.height = r.height * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); }).observe(cv); return o; }
const M = canvasOf("#map");
let path = [], codes = [], view = {lon0: -126, lon1: -64, lat0: 23, lat1: 51}, t0 = performance.now();
const pt = c => AP && AP[c] && AP[c].la != null ? {lat: AP[c].la, lon: AP[c].lo} : null;
function gc(A0, B0, n) { const v = p => [Math.cos(rad(p.lat)) * Math.cos(rad(p.lon)), Math.cos(rad(p.lat)) * Math.sin(rad(p.lon)), Math.sin(rad(p.lat))];
  const A = v(A0), B = v(B0), w = Math.acos(Math.min(1, A[0]*B[0] + A[1]*B[1] + A[2]*B[2])) || 1e-6, out = [];
  for (let i = 0; i <= n; i++) { const t = i / n, s1 = Math.sin((1 - t) * w) / Math.sin(w), s2 = Math.sin(t * w) / Math.sin(w), x = s1*A[0] + s2*B[0], y = s1*A[1] + s2*B[1], z = s1*A[2] + s2*B[2];
    out.push({lat: Math.atan2(z, Math.hypot(x, y)) * 180 / Math.PI, lon: Math.atan2(y, x) * 180 / Math.PI}); } return out; }
function setRoute() {
  const r = visible(), it = (S.open && r.find(x => idOf(x) === S.open)) || r[0], o = S.leg ? S.d : S.o, d = S.leg ? S.o : S.d;
  codes = (it ? [o, ...it.legs.map(l => l.to)] : [o, d]).filter(pt); if (codes.length < 2) { path = []; return; }
  const pts = codes.map(pt), lo = pts.map(p => p.lon), la = pts.map(p => p.lat);
  const cx = (Math.min(...lo) + Math.max(...lo)) / 2, cy = (Math.min(...la) + Math.max(...la)) / 2;
  const span = Math.max(14, (Math.max(...lo) - Math.min(...lo)) * 1.5, (Math.max(...la) - Math.min(...la)) * 2.2);
  view = {lon0: cx - span/2, lon1: cx + span/2, lat0: cy - span/3.2, lat1: cy + span/3.2};
  path = []; for (let i = 0; i < codes.length - 1; i++) { const seg = gc(pt(codes[i]), pt(codes[i+1]), 70); if (i) seg.shift(); path.push(...seg); } t0 = performance.now();
}
function proj(p) { const {W, H} = M, k = Math.cos(rad((view.lat0 + view.lat1) / 2)), sw = (view.lon1 - view.lon0) * k, sh = view.lat1 - view.lat0, s = Math.min(W / sw, H / sh) * .92;
  return [W/2 + (p.lon - (view.lon0 + view.lon1) / 2) * k * s, H/2 - (p.lat - (view.lat0 + view.lat1) / 2) * s]; }
function plane(ctx, x, y, ang, s, fill, edge) { ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.scale(s, s); ctx.beginPath();
  const P = [[30,0],[27,-2],[20,-2.8],[6,-2.8],[-7,-20],[-11.5,-20],[-4,-2.8],[-19,-2.4],[-26,-9],[-30,-9],[-28,-1.6],[-31,0]];
  P.forEach(([a, b], i) => i ? ctx.lineTo(a, b) : ctx.moveTo(a, b)); for (let i = P.length - 2; i > 0; i--) ctx.lineTo(P[i][0], -P[i][1]); ctx.closePath();
  ctx.fillStyle = fill; ctx.fill(); if (edge) { ctx.strokeStyle = edge; ctx.lineWidth = .9 / s; ctx.stroke(); }
  ctx.fillStyle = edge || fill; [-1, 1].forEach(sg => { ctx.beginPath(); ctx.ellipse(-17, sg * 4.6, 4.2, 1.6, 0, 0, 7); ctx.fill(); }); ctx.restore(); }
function drawMap(now) { const {ctx, W, H} = M; if (!W || !AP) return; ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#c5c9ce"; for (const a of Object.values(AP)) { if (a.la == null) continue; const [x, y] = proj({lat: a.la, lon: a.lo}); if (x < -5 || x > W + 5 || y < -5 || y > H + 5) continue; ctx.beginPath(); ctx.arc(x, y, (a.d || 0) > 800 ? 2.4 : 1.6, 0, 7); ctx.fill(); }
  if (path.length < 2) return; const P = path.map(proj);
  ctx.setLineDash([3, 6]); ctx.strokeStyle = "#9aa0a6"; ctx.lineWidth = 1.4; ctx.beginPath(); P.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.stroke(); ctx.setLineDash([]);
  const cyc = 7000, raw = reduce ? .6 : ((now - t0) % cyc) / cyc, t = raw < .85 ? (1 - Math.cos(Math.PI * raw / .85)) / 2 : 1, idx = t * (P.length - 1), i0 = Math.min(Math.floor(idx), P.length - 2);
  ctx.strokeStyle = "#0a0a0a"; ctx.lineWidth = 2; ctx.beginPath(); for (let i = 0; i <= i0; i++) i ? ctx.lineTo(P[i][0], P[i][1]) : ctx.moveTo(P[i][0], P[i][1]);
  const f = idx - i0, x = P[i0][0] + (P[i0+1][0] - P[i0][0]) * f, y = P[i0][1] + (P[i0+1][1] - P[i0][1]) * f; ctx.lineTo(x, y); ctx.stroke();
  plane(ctx, x, y, Math.atan2(P[i0+1][1] - P[i0][1], P[i0+1][0] - P[i0][0]), .42, "#0a0a0a");
  codes.forEach((c, i) => { const [px, py] = proj(pt(c)), end = i === 0 || i === codes.length - 1;
    ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(px, py, end ? 7 : 5.5, 0, 7); ctx.fill(); ctx.strokeStyle = "#0a0a0a"; ctx.lineWidth = 2; ctx.stroke();
    if (end) { ctx.fillStyle = "#0a0a0a"; ctx.beginPath(); ctx.arc(px, py, 2.6, 0, 7); ctx.fill(); }
    ctx.font = "500 13px " + getComputedStyle(document.body).fontFamily; const lbl = `${c} · ${city(c)}`, tw = ctx.measureText(lbl).width;
    let lx = px + 14, ly = py + 4; if (lx + tw + 16 > W) lx = px - 14 - tw - 12; ctx.fillStyle = "#fff"; ctx.beginPath(); (ctx.roundRect ? ctx.roundRect(lx - 6, ly - 14, tw + 12, 22, 11) : ctx.rect(lx - 6, ly - 14, tw + 12, 22)); ctx.fill();
    ctx.fillStyle = end ? "#0a0a0a" : "#6b6f75"; ctx.fillText(lbl, lx, ly + 1); }); }
function frame(now) { drawMap(now); requestAnimationFrame(frame); }

/* ---------- boot ---------- */
async function boot() {
  const t = todayLocal(); let dep = addDays(t, 7); while (wd(dep) !== 4) dep = addDays(dep, 1);
  const nextFri = dep;
  requestAnimationFrame(frame);
  { const im = new Image(); im.onload = () => $("#closeBand").classList.add("has-img"); im.src = "img/close.jpg"; }
  try { [META, AP] = await Promise.all([getJSON("meta.json"), getJSON("airports.json")]); }
  catch (e) { $("#dataNote span").textContent = "Flight records are not loaded yet."; $("#list").innerHTML = `<div class="empty">The flight records haven't been built yet. They appear after the monthly data update runs.</div>`; return; }
  $("#dataNote span").textContent = `Real flight records, ${monthName(META.months[0])} – ${monthName(META.months[META.months.length - 1])}`;
  $("#aps").innerHTML = Object.entries(AP).sort((a, b) => (b[1].d || 0) - (a[1].d || 0)).map(([k, a]) => `<option value="${k}">${a.c} · ${a.n}</option>`).join("");
  ["from", "to"].forEach(id => $("#" + id).addEventListener("input", nameHints));
  $("#swap").onclick = () => { const a = $("#from").value; $("#from").value = $("#to").value; $("#to").value = a; nameHints(); if ($("#from").value && $("#to").value && $("#d1").value) run(); };
  $("#f").addEventListener("submit", async e => { e.preventDefault(); if (await run()) document.getElementById("forecast").scrollIntoView({behavior: reduce ? "auto" : "smooth"}); });
  $("#sort").onchange = e => { S.sort = e.target.value; renderList(); };
  const POP = [["BWI","MCO"],["JFK","LAX"],["ATL","MIA"],["ORD","DEN"],["DCA","BOS"],["DFW","LAS"],["SEA","SFO"],["BWI","DAB"]]
    .filter(([a, b]) => AP[a] && AP[b]);
  $("#routes").innerHTML = POP.map(([a, b]) => `<button class="route" data-o="${a}" data-d="${b}" type="button"><b>${a} → ${b}</b><span>${AP[a].c} to ${AP[b].c}</span></button>`).join("");
  $("#routes").querySelectorAll("button").forEach(btn => btn.onclick = async () => {
    $("#from").value = btn.dataset.o; $("#to").value = btn.dataset.d;
    if (!$("#d1").value) $("#d1").value = iso(nextFri);
    nameHints();
    if (await run()) document.getElementById("forecast").scrollIntoView({behavior: reduce ? "auto" : "smooth"});
  });
  if (!POP.length) $("#popular").hidden = true;
  $("#share").onclick = async () => {
    const url = location.href.split("#")[0] + (S.hash || "");
    try { await navigator.clipboard.writeText(url); $("#copied").textContent = "Link copied. Anyone with it sees this same search."; }
    catch (e) { $("#copied").textContent = url; }
  };
  window.addEventListener("hashchange", () => { if (fromHash()) { nameHints(); run(); } });
  if (fromHash()) { nameHints(); if (await run()) document.getElementById("forecast").scrollIntoView(); }
}
boot();
})();
