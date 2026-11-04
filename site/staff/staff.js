/* Contrail staff site: sign in, call requests, calendar, bookings, team. Data lives in Supabase. */
(() => {
"use strict";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const CFG = window.CONTRAIL_CONFIG || {};
const SITE = new URL("../", location.href).href;           // the public Contrail site
const STATUSES = ["New", "Scheduled", "Called", "Booked", "No answer", "Closed"];
const OPEN = new Set(["New", "Scheduled", "No answer"]);

const show = id => ["vNoConfig", "vAuth", "vNewPass", "vApp"].forEach(v => { $("#" + v).hidden = v !== id; });
if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) { show("vNoConfig"); return; }
const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});

/* ---------- helpers ---------- */
const S = {me: null, profiles: [], calls: [], bookings: [], events: [], filter: "Open", q: "", calOff: 0, editing: null, editingEvent: null};
const esc = v => String(v ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
const fmtDate = d => d ? new Date(d).toLocaleDateString("en-US", {month: "short", day: "numeric"}) : "—";
const fmtDateY = d => d ? new Date(d).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"}) : "—";
const fmtDay = s => s ? new Date(s + "T12:00:00").toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"}) : "—";
const fmtTime = d => new Date(d).toLocaleTimeString("en-US", {hour: "numeric", minute: "2-digit"});
const fmtWhen = d => d ? `${new Date(d).toLocaleDateString("en-US", {weekday: "short", month: "short", day: "numeric"})}, ${fmtTime(d)}` : "—";
const ago = d => { const m = Math.round((Date.now() - new Date(d)) / 60000); if (m < 1) return "just now"; if (m < 60) return `${m} min ago`; const h = Math.round(m / 60); if (h < 24) return `${h} hr ago`; const dd = Math.round(h / 24); return `${dd} day${dd > 1 ? "s" : ""} ago`; };
const usd = n => "$" + (Number(n) || 0).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2});
const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const toLocalInput = d => { if (!d) return ""; const x = new Date(d); return `${ymd(x)}T${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`; };
const pill = s => `<span class="pill st-${esc(String(s).replace(/\s/g, ""))}">${esc(s)}</span>`;
const nameOf = id => { const p = S.profiles.find(p => p.id === id); return p ? (p.full_name || p.email) : "—"; };
function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3200); }
const say = (el, t, cls) => { el.textContent = t; el.className = "msg " + (cls || ""); };
function friendly(err) {
  const m = (err && (err.message || err.error_description)) || String(err);
  if (/invalid login/i.test(m)) return "That email and password don't match. Check them and try again.";
  if (/email not confirmed/i.test(m)) return "This account hasn't been confirmed yet. Open the invite email first.";
  if (/rate limit|too many/i.test(m)) return "Too many tries. Wait a minute and try again.";
  if (/failed to fetch|network/i.test(m)) return "Can't reach the server. Check your connection and try again.";
  if (/row-level security|permission/i.test(m)) return "Your account isn't allowed to do that. Ask the owner.";
  return m;
}

/* ---------- auth ---------- */
$("#fSignIn").addEventListener("submit", async e => {
  e.preventDefault(); const email = $("#siEmail").value.trim(), password = $("#siPass").value, btn = $("#siBtn");
  if (!email || !password) return say($("#siMsg"), "Enter your email and password.", "bad");
  btn.disabled = true; say($("#siMsg"), "Signing in…");
  const {error} = await db.auth.signInWithPassword({email, password});
  btn.disabled = false; if (error) say($("#siMsg"), friendly(error), "bad");
});
$("#siForgot").addEventListener("click", async () => {
  const email = $("#siEmail").value.trim();
  if (!email) return say($("#siMsg"), "Type your email above first, then click Forgot password.", "bad");
  const {error} = await db.auth.resetPasswordForEmail(email, {redirectTo: location.href.split("#")[0]});
  say($("#siMsg"), error ? friendly(error) : "If that email has an account, a reset link is on its way.", error ? "bad" : "ok");
});
$("#fNewPass").addEventListener("submit", async e => {
  e.preventDefault(); const a = $("#npPass").value, b = $("#npPass2").value;
  if (a.length < 10) return say($("#npMsg"), "Use at least 10 characters.", "bad");
  if (a !== b) return say($("#npMsg"), "The two passwords don't match.", "bad");
  const {error} = await db.auth.updateUser({password: a});
  if (error) return say($("#npMsg"), friendly(error), "bad");
  S.needPass = false; history.replaceState(null, "", location.pathname); start();
});
$("#signOut").addEventListener("click", () => db.auth.signOut());

// Invite and reset links arrive with a recovery or invite token in the address.
if (/type=(recovery|invite|signup)/.test(location.hash + location.search)) S.needPass = true;
db.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") S.needPass = true;
  if (!session) { S.me = null; stopLive(); show("vAuth"); return; }
  if (S.needPass) { show("vNewPass"); return; }
  if (!S.me || S.me.id !== session.user.id) { S.me = session.user; start(); }
});

/* ---------- data ---------- */
async function load() {
  const [p, c, b, ev] = await Promise.all([
    db.from("profiles").select("id,email,full_name,role").order("full_name"),
    db.from("call_requests").select("*").order("created_at", {ascending: false}).limit(1000),
    db.from("bookings").select("*").order("booked_on", {ascending: false}).limit(1000),
    db.from("events").select("*").order("starts_at").limit(1000)
  ]);
  for (const r of [p, c, b, ev]) if (r.error) throw r.error;
  S.profiles = p.data; S.calls = c.data; S.bookings = b.data; S.events = ev.data;
}
let channel = null;
function startLive() {
  stopLive();
  channel = db.channel("staff")
    .on("postgres_changes", {event: "*", schema: "public", table: "call_requests"}, async payload => {
      if (payload.eventType === "INSERT") toast(`New call request from ${payload.new.name}`);
      await refresh();
    })
    .on("postgres_changes", {event: "*", schema: "public", table: "events"}, refresh)
    .subscribe();
}
function stopLive() { if (channel) { db.removeChannel(channel); channel = null; } }
async function refresh() { try { await load(); render(); } catch (e) { toast(friendly(e)); } }

async function start() {
  show("vApp");
  try { await load(); } catch (e) { toast(friendly(e)); }
  const mine = S.profiles.find(p => p.id === S.me.id);
  if (!mine) { show("vAuth"); say($("#siMsg"), "This login doesn't have staff access. Ask the owner.", "bad"); await db.auth.signOut(); return; }
  $("#meName").textContent = mine.full_name || ""; $("#meEmail").textContent = S.me.email;
  $("#myName").value = mine.full_name || "";
  render(); startLive();
  if (!S.timer) S.timer = setInterval(refresh, 120000); // also catch changes if live updates drop
}

/* ---------- tabs ---------- */
function openTab(name) {
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$("[data-view]").forEach(v => { v.hidden = v.dataset.view !== name; });
  try { history.replaceState(null, "", "#" + name); } catch (e) {}
}
$$(".tab").forEach(t => t.addEventListener("click", () => openTab(t.dataset.tab)));
const startTab = (location.hash || "").slice(1); if (["overview", "calls", "calendar", "bookings", "team"].includes(startTab)) openTab(startTab);

/* ---------- render ---------- */
function render() { renderOverview(); renderCalls(); renderCal(); renderBookings(); renderTeam(); }

function renderOverview() {
  const h = new Date().getHours(), me = S.profiles.find(p => p.id === S.me.id);
  $("#hello").textContent = `${h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"}${me && me.full_name ? ", " + me.full_name.split(" ")[0] : ""}`;
  const news = S.calls.filter(c => c.status === "New"), today = ymd(new Date());
  const todays = S.calls.filter(c => c.call_at && ymd(new Date(c.call_at)) === today && OPEN.has(c.status));
  const mStart = new Date(); mStart.setDate(1); const mKey = ymd(mStart).slice(0, 7);
  const monthB = S.bookings.filter(b => (b.booked_on || "").slice(0, 7) === mKey && b.status !== "Cancelled");
  $("#kNew").textContent = news.length; $("#kToday").textContent = todays.length;
  $("#kBookings").textContent = monthB.length; $("#kComm").textContent = usd(monthB.reduce((a, b) => a + Number(b.commission_usd || 0), 0));
  $("#helloSub").textContent = news.length ? `${news.length} ${news.length === 1 ? "person is" : "people are"} waiting for a call back.` : "Nobody is waiting for a call back right now.";
  const badge = $("#newBadge"); badge.hidden = !news.length; badge.textContent = news.length;
  const need = news.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at)).slice(0, 8);
  $("#needList").innerHTML = need.length ? need.map(c => `<li><button type="button" data-call="${c.id}"><span class="t">${esc(c.name)}</span><span class="s">${esc(c.trip || c.message || c.phone)}</span><span class="r">${esc(ago(c.created_at))}<br>${esc(c.source)}</span></button></li>`).join("")
    : `<li><p class="empty">All caught up.</p></li>`;
  const now = Date.now(), wk = now + 7 * 864e5;
  const up = [...S.calls.filter(c => c.call_at && OPEN.has(c.status)).map(c => ({at: c.call_at, t: `Call ${c.name}`, s: `${c.phone} · ${nameOf(c.assigned_to)}`, call: c.id})),
              ...S.events.map(e => ({at: e.starts_at, t: e.title, s: e.detail || "Team event", ev: e.id}))]
    .filter(x => { const t = new Date(x.at).getTime(); return t >= now - 3600e3 && t <= wk; }).sort((a, b) => new Date(a.at) - new Date(b.at)).slice(0, 8);
  $("#upList").innerHTML = up.length ? up.map(x => `<li><button type="button" ${x.call ? `data-call="${x.call}"` : `data-event="${x.ev}"`}><span class="t">${esc(x.t)}</span><span class="s">${esc(x.s)}</span><span class="r">${esc(fmtWhen(x.at))}</span></button></li>`).join("")
    : `<li><p class="empty">Nothing scheduled in the next 7 days.</p></li>`;
}

function renderCalls() {
  const chips = ["Open", "All", ...STATUSES];
  $("#stChips").innerHTML = chips.map(c => `<button class="chip" type="button" data-st="${esc(c)}" aria-pressed="${S.filter === c}">${esc(c)}${c === "Open" ? "" : ""}</button>`).join("");
  const q = S.q.toLowerCase();
  const rows = S.calls.filter(c => S.filter === "All" || (S.filter === "Open" ? OPEN.has(c.status) : c.status === S.filter))
    .filter(c => !q || [c.name, c.phone, c.trip, c.email, c.notes, c.message].some(v => (v || "").toLowerCase().includes(q)));
  $("#callRows").innerHTML = rows.map(c => `<tr data-call="${c.id}"><td class="n">${esc(fmtDate(c.created_at))}<br><span class="dim">${esc(c.source)}</span></td>
    <td>${esc(c.name)}</td><td class="n">${esc(c.phone)}</td><td class="hide-sm">${esc(c.trip || c.message || "—")}</td><td>${pill(c.status)}</td>
    <td class="hide-sm">${esc(nameOf(c.assigned_to))}</td><td class="n">${c.call_at ? esc(fmtWhen(c.call_at)) : "—"}</td></tr>`).join("");
  $("#callEmpty").hidden = rows.length > 0;
}
$("#stChips").addEventListener("click", e => { const b = e.target.closest("[data-st]"); if (!b) return; S.filter = b.dataset.st; renderCalls(); });
$("#callSearch").addEventListener("input", e => { S.q = e.target.value; renderCalls(); });

function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + S.calOff, 1); }
function renderCal() {
  const first = monthStart(), start = new Date(first); start.setDate(1 - ((first.getDay() + 6) % 7));
  $("#calMonth").textContent = first.toLocaleDateString("en-US", {month: "long", year: "numeric"});
  const items = [...S.calls.filter(c => c.call_at && c.status !== "Closed").map(c => ({day: ymd(new Date(c.call_at)), at: c.call_at, kind: "call", t: `${fmtTime(c.call_at)} ${c.name}`, call: c.id})),
                 ...S.events.map(e => ({day: ymd(new Date(e.starts_at)), at: e.starts_at, kind: "event", t: `${fmtTime(e.starts_at)} ${e.title}`, ev: e.id})),
                 ...S.bookings.filter(b => b.travel_date && b.status !== "Cancelled").map(b => ({day: b.travel_date, at: b.travel_date, kind: "trip", t: `Trip ${b.route || ""}`}))]
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const by = {}; items.forEach(i => (by[i.day] = by[i.day] || []).push(i));
  const today = ymd(new Date());
  let h = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(d => `<div class="dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start); d.setDate(start.getDate() + i); const k = ymd(d);
    h += `<div class="day${d.getMonth() !== first.getMonth() ? " out" : ""}${k === today ? " today" : ""}"><span class="num">${d.getDate()}</span>` +
      (by[k] || []).map(x => `<button type="button" class="ev ${x.kind}" ${x.call ? `data-call="${x.call}"` : x.ev ? `data-event="${x.ev}"` : "disabled"} title="${esc(x.t)}">${esc(x.t)}</button>`).join("") + `</div>`;
  }
  $("#cal").innerHTML = h;
}
$$("[data-cal]").forEach(b => b.addEventListener("click", () => { const v = Number(b.dataset.cal); S.calOff = v === 0 ? 0 : S.calOff + v; renderCal(); }));

function renderBookings() {
  const live = S.bookings.filter(b => b.status !== "Cancelled");
  $("#bCount").textContent = live.length; $("#bFare").textContent = usd(live.reduce((a, b) => a + Number(b.fare_usd || 0), 0));
  $("#bComm").textContent = usd(live.reduce((a, b) => a + Number(b.commission_usd || 0), 0));
  $("#bookRows").innerHTML = S.bookings.map(b => `<tr><td class="n">${esc(fmtDay(b.booked_on))}</td><td>${esc(b.route || "—")}</td><td class="n">${esc(fmtDay(b.travel_date))}</td>
    <td>${esc(b.partner || "—")}</td><td class="n">${b.fare_usd == null ? "—" : usd(b.fare_usd)}</td><td class="n">${b.commission_usd == null ? "—" : usd(b.commission_usd)}</td><td>${pill(b.status || "Pending")}</td></tr>`).join("");
  $("#bookEmpty").hidden = S.bookings.length > 0;
}

function renderTeam() {
  $("#teamRows").innerHTML = S.profiles.map(p => `<tr style="cursor:default"><td>${esc(p.full_name || "—")}${p.id === S.me.id ? ' <span class="dim">(you)</span>' : ""}</td><td>${esc(p.email)}</td>
    <td>${p.role === "admin" ? "Owner" : "Staff"}</td><td class="n">${S.calls.filter(c => c.assigned_to === p.id && OPEN.has(c.status)).length}</td></tr>`).join("");
}
$("#fName").addEventListener("submit", async e => {
  e.preventDefault(); const v = $("#myName").value.trim();
  const {error} = await db.from("profiles").update({full_name: v || null}).eq("id", S.me.id);
  say($("#nameMsg"), error ? friendly(error) : "Saved.", error ? "bad" : "ok"); if (!error) { $("#meName").textContent = v; refresh(); }
});

/* ---------- call drawer ---------- */
// Builds a Contrail link for the trip, e.g. #BWI-MCO-20270506, from however the trip was written
// ("BWI to MCO Dec 4", "One way from BWI (Baltimore) to MCO (Orlando) on May 6, 2027", "BWI-MCO 2026-12-04").
let AIRPORTS = null;
fetch("../data/airports.json").then(r => r.ok ? r.json() : null).then(j => { AIRPORTS = j; }).catch(() => {});
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function tripDate(s) {
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(s);
  if (m) return [+m[1], +m[2], +m[3]];
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(s);
  let y, mo, d;
  if (m) { mo = +m[1]; d = +m[2]; y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null; }
  else {
    m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?/i.exec(s);
    if (!m) return null;
    mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; d = +m[2]; y = m[3] ? +m[3] : null;
  }
  if (!y) { const now = new Date(); y = now.getFullYear(); if (new Date(y, mo - 1, d) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) y++; }
  return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 ? [y, mo, d] : null;
}
function bookingLink(c) {
  const s = [c.trip, c.message].filter(Boolean).join(" ");
  const codes = [...new Set((s.match(/\b[A-Z]{3}\b/g) || []).filter(x => !["AND", "THE", "ONE", "WAY", "FOR", "AIR"].includes(x)))];
  if (codes.length < 2 && AIRPORTS) {        // fall back to city names, e.g. "Baltimore to Orlando"
    const low = s.toLowerCase(), best = {};
    for (const [k, a] of Object.entries(AIRPORTS)) {
      const city = (a.c || "").toLowerCase(); if (city.length < 4) continue;
      const at = low.indexOf(city); if (at < 0) continue;
      if (!best[city] || (a.d || 0) > (AIRPORTS[best[city].k].d || 0)) best[city] = {k, at};
    }
    Object.values(best).sort((x, y) => x.at - y.at).forEach(b => { if (!codes.includes(b.k)) codes.push(b.k); });
  }
  if (codes.length < 2) return SITE;
  const t = tripDate(c.trip || "") || tripDate(s);
  const date = t ? `-${t[0]}${String(t[1]).padStart(2, "0")}${String(t[2]).padStart(2, "0")}` : "";
  return `${SITE}#${codes[0]}-${codes[1]}${date}`;
}
function openCall(id) {
  const c = id ? S.calls.find(x => String(x.id) === String(id)) : null;
  S.editing = c ? c.id : "new";
  $("#dTitle").textContent = c ? c.name : "Add a call request";
  $("#dSub").textContent = c ? `${c.source} · received ${fmtDateY(c.created_at)}, ${fmtTime(c.created_at)}` : "For someone who called or messaged you directly.";
  $("#dNewFields").hidden = !!c;
  if (!c) { ["#cName", "#cPhone", "#cEmail", "#cTrip", "#cBest"].forEach(s => { $(s).value = ""; }); $("#cSource").value = "Phone"; }
  $("#dFacts").innerHTML = c ? [["Phone", c.phone], ["Email", c.email], ["Trip", c.trip], ["Best time", c.best_time], ["Message", c.message], ["Updated", c.updated_at ? `${fmtDateY(c.updated_at)}, ${fmtTime(c.updated_at)}` : null]]
    .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("") : "";
  $("#dQuick").innerHTML = c ? `<a class="btn btn-line" href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">Call ${esc(c.phone)}</a><button class="btn btn-line" type="button" id="copyLink">Copy booking link</button>` : "";
  $("#cStatus").value = c ? c.status : "New";
  $("#cAssign").innerHTML = `<option value="">Nobody yet</option>` + S.profiles.map(p => `<option value="${p.id}">${esc(p.full_name || p.email)}</option>`).join("");
  $("#cAssign").value = c ? (c.assigned_to || "") : S.me.id;
  $("#cCallAt").value = c ? toLocalInput(c.call_at) : "";
  $("#cNotes").value = c ? (c.notes || "") : "";
  say($("#cMsg"), "");
  $("#scrim").hidden = false; $("#drawer").hidden = false; (c ? $("#cStatus") : $("#cName")).focus();
  const cl = $("#copyLink"); if (cl) cl.onclick = async () => {
    const link = bookingLink(c), box = $("#linkBox");
    box.hidden = false;
    box.innerHTML = `<span>${link === SITE ? "Couldn't tell the airports from this request, so this is the Contrail home page:" : "Booking link for this trip:"}</span>
      <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link)}</a>`;
    try { await navigator.clipboard.writeText(link); toast("Booking link copied. Paste it in a text to the customer."); }
    catch (e) { toast("Couldn't copy automatically. Select the link below and copy it."); }
  };
  const lb = $("#linkBox"); if (lb) { lb.hidden = true; lb.innerHTML = ""; }
}
function closeDrawers() { $("#scrim").hidden = true; $("#drawer").hidden = true; $("#evDrawer").hidden = true; S.editing = null; S.editingEvent = null; }
document.addEventListener("click", e => {
  const c = e.target.closest("[data-call]"); if (c && !c.closest("#drawer")) return openCall(c.dataset.call);
  const ev = e.target.closest("[data-event]"); if (ev) return openEvent(ev.dataset.event);
  if (e.target.closest("[data-new-call]")) openCall(null);
});
$("#dClose").addEventListener("click", closeDrawers); $("#cCancel").addEventListener("click", closeDrawers); $("#scrim").addEventListener("click", closeDrawers);
$("#eClose").addEventListener("click", closeDrawers);
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawers(); });

$("#fCall").addEventListener("submit", async e => {
  e.preventDefault(); const btn = $("#cSave");
  const callAt = $("#cCallAt").value ? new Date($("#cCallAt").value).toISOString() : null;
  let status = $("#cStatus").value; if (callAt && status === "New") status = "Scheduled";
  const fields = {status, assigned_to: $("#cAssign").value || null, call_at: callAt, notes: $("#cNotes").value.trim() || null};
  btn.disabled = true; say($("#cMsg"), "Saving…");
  let res;
  if (S.editing === "new") {
    const name = $("#cName").value.trim(), phone = $("#cPhone").value.trim();
    if (!name || phone.replace(/\D/g, "").length < 7) { btn.disabled = false; return say($("#cMsg"), "Add their name and a phone number.", "bad"); }
    res = await db.from("call_requests").insert({...fields, name, phone, email: $("#cEmail").value.trim() || null, trip: $("#cTrip").value.trim() || null,
      best_time: $("#cBest").value.trim() || null, source: $("#cSource").value});
  } else {
    res = await db.from("call_requests").update(fields).eq("id", S.editing);
  }
  btn.disabled = false;
  if (res.error) return say($("#cMsg"), friendly(res.error), "bad");
  closeDrawers(); toast("Saved."); refresh();
});

/* ---------- event drawer ---------- */
function openEvent(id) {
  const ev = id ? S.events.find(x => String(x.id) === String(id)) : null; S.editingEvent = ev ? ev.id : "new";
  $("#eTitle").textContent = ev ? "Edit event" : "Add an event";
  $("#eName").value = ev ? ev.title : ""; $("#eAt").value = ev ? toLocalInput(ev.starts_at) : ""; $("#eDetail").value = ev ? (ev.detail || "") : "";
  $("#eDelete").hidden = !ev; say($("#eMsg"), "");
  $("#scrim").hidden = false; $("#evDrawer").hidden = false; $("#eName").focus();
}
$("#addEvent").addEventListener("click", () => openEvent(null));
$("#fEvent").addEventListener("submit", async e => {
  e.preventDefault(); const title = $("#eName").value.trim(), at = $("#eAt").value;
  if (!title || !at) return say($("#eMsg"), "Add a title and a date and time.", "bad");
  const row = {title, starts_at: new Date(at).toISOString(), detail: $("#eDetail").value.trim() || null};
  const res = S.editingEvent === "new" ? await db.from("events").insert(row) : await db.from("events").update(row).eq("id", S.editingEvent);
  if (res.error) return say($("#eMsg"), friendly(res.error), "bad");
  closeDrawers(); toast("Event saved."); refresh();
});
$("#eDelete").addEventListener("click", async () => {
  if ($("#eDelete").dataset.sure !== "1") { $("#eDelete").dataset.sure = "1"; $("#eDelete").textContent = "Click again to delete"; return; }
  const {error} = await db.from("events").delete().eq("id", S.editingEvent);
  $("#eDelete").dataset.sure = ""; $("#eDelete").textContent = "Delete event";
  if (error) return say($("#eMsg"), friendly(error), "bad");
  closeDrawers(); toast("Event deleted."); refresh();
});
})();
