/* Contrail staff site: sign in, call requests, calendar, bookings, team. Data lives in Supabase. */
(() => {
"use strict";
const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
const CFG = window.CONTRAIL_CONFIG || {};
const SITE = new URL("../", location.href).href;           // the public Contrail site
const STATUSES = ["New", "Scheduled", "Called", "Booked", "No answer", "Closed"];
const OPEN = new Set(["New", "Scheduled", "No answer"]);
const PHONE_LINE = "(989) 690-4469";
const FN = (CFG.supabaseUrl || "") + "/functions/v1/";
const GROK_CALLS = "https://console.x.ai/team/34e110fb-aa96-4ea6-895a-0a680b7de109/voice/agents/agent_cMaIBHcVY7fLBp0U?tab=conversations";

const show = id => ["vNoConfig", "vAuth", "vNewPass", "vApp"].forEach(v => { $("#" + v).hidden = v !== id; });
if (!CFG.supabaseUrl || !CFG.supabaseAnonKey || !window.supabase) { show("vNoConfig"); return; }
const db = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, {auth: {persistSession: true, autoRefreshToken: true, detectSessionInUrl: true}});

/* ---------- helpers ---------- */
const S = {me: null, profiles: [], calls: [], bookings: [], events: [], quotes: [], filter: "Open", q: "", cq: "", calOff: 0, editing: null, editingEvent: null};
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
  const qs = await db.from("quotes").select("id,token,call_id,origin,destination,date_label,created_at,views,viewed_at,expires_at").order("created_at", {ascending: false}).limit(500);
  S.quotes = qs.error ? [] : qs.data;   // quote sheets are optional until quotes.sql has been run
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
  const prev = S.tab; S.tab = name;
  $$(".tab").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  $$(".bnav [data-tab]").forEach(t => t.setAttribute("aria-selected", String(t.dataset.tab === name)));
  const more = $(".bnav [data-more]"); if (more) more.setAttribute("aria-selected", String(name === "bookings" || name === "team"));
  $$("[data-view]").forEach(v => { v.hidden = v.dataset.view !== name; });
  $("#fab").hidden = !["overview", "calls", "customers", "calendar"].includes(name);
  $("#fab").setAttribute("aria-label", name === "calendar" ? "Add an event" : "Add a call request");
  try { history.replaceState(null, "", "#" + name); localStorage.setItem("contrail-tab", name); } catch (e) {}
  if (prev && prev !== name) window.scrollTo({top: 0});
}
$$(".tab, .bnav [data-tab]").forEach(t => t.addEventListener("click", () => { if (S.tab === t.dataset.tab) window.scrollTo({top: 0, behavior: "smooth"}); openTab(t.dataset.tab); }));
const TABS = ["overview", "calls", "customers", "calendar", "bookings", "team"];
let startTab = (location.hash || "").slice(1);
if (!TABS.includes(startTab)) { try { startTab = localStorage.getItem("contrail-tab") || ""; } catch (e) {} }
openTab(TABS.includes(startTab) ? startTab : "overview");
// Links from phone alerts look like #call=123: open that request once the data is loaded.
let pendingCall = (/^#call=(\d+)/.exec(location.hash) || [])[1] || null;
function openPending() { if (!pendingCall || !S.calls.length) return; const id = pendingCall; pendingCall = null; openTab("calls"); openCall(id); }
window.addEventListener("hashchange", () => { const m = /^#call=(\d+)/.exec(location.hash); if (m) { pendingCall = m[1]; openPending(); } });

/* ---------- render ---------- */
function render() { renderOverview(); renderCalls(); renderCustomers(); renderCal(); renderBookings(); renderTeam(); renderAlerts(); openPending(); }

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
  const dot = $("#navDot"); dot.hidden = !news.length; dot.textContent = news.length > 99 ? "99+" : news.length;
  try { if (navigator.setAppBadge) news.length ? navigator.setAppBadge(news.length) : navigator.clearAppBadge(); } catch (e) {}
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
  const chips = ["Mine", "Due today", "Open", "All", ...STATUSES];
  $("#stChips").innerHTML = chips.map(c => `<button class="chip" type="button" data-st="${esc(c)}" aria-pressed="${S.filter === c}">${esc(c)}${c === "Open" ? "" : ""}</button>`).join("");
  const q = S.q.toLowerCase();
  const endToday = new Date(); endToday.setHours(23, 59, 59, 999);
  const pass = c => S.filter === "All" ? true : S.filter === "Open" ? OPEN.has(c.status)
    : S.filter === "Mine" ? c.assigned_to === S.me.id && OPEN.has(c.status)
    : S.filter === "Due today" ? !!c.call_at && new Date(c.call_at) <= endToday && OPEN.has(c.status)
    : c.status === S.filter;
  let rows = S.calls.filter(pass).filter(c => !q || [c.name, c.phone, c.trip, c.email, c.notes, c.message].some(v => (v || "").toLowerCase().includes(q)));
  if (S.filter === "Due today") rows = rows.slice().sort((a, b) => new Date(a.call_at) - new Date(b.call_at));
  $("#callRows").innerHTML = rows.map(c => `<tr data-call="${c.id}"><td class="n">${esc(fmtDate(c.created_at))}<br><span class="dim">${esc(c.source)}</span></td>
    <td>${esc(c.name)}</td><td class="n">${esc(c.phone)}</td><td class="hide-sm">${esc(c.trip || c.message || "—")}</td><td>${pill(c.status)}</td>
    <td class="hide-sm">${c.assigned_to ? esc(nameOf(c.assigned_to)) : `<button class="mini" type="button" data-claim="${c.id}">Claim</button>`}</td><td class="n">${c.call_at ? esc(fmtWhen(c.call_at)) : "—"}</td></tr>`).join("");
  $("#callEmpty").hidden = rows.length > 0;
  $("#callEmpty").textContent = S.filter === "Mine" ? "Nothing assigned to you right now. Claim a request to add it here."
    : S.filter === "Due today" ? "No call-backs due today." : "No call requests match.";
}

/* ---------- claiming ---------- */
async function claim(id, force) {
  let q = db.from("call_requests").update({assigned_to: S.me.id}).eq("id", id);
  if (!force) q = q.is("assigned_to", null);            // only if nobody got there first
  const {data, error} = await q.select("id");
  if (error) return toast(friendly(error));
  await refresh();
  if (!data || !data.length) { const c = S.calls.find(x => String(x.id) === String(id)); toast(`${nameOf(c && c.assigned_to)} already claimed this one.`); }
  else { haptic(); toast("It's yours. It's in your queue under Mine."); }
  if (S.editing && String(S.editing) === String(id)) openCall(id);
}

/* ---------- customers (grouped by phone number) ---------- */
const custKey = c => { const d = (c.phone || "").replace(/\D/g, ""); return d.length >= 7 ? "p" + d.slice(-10) : "n" + (c.name || "").trim().toLowerCase(); };
function customers() {
  const m = new Map();
  for (const c of S.calls) { const k = custKey(c); if (!m.has(k)) m.set(k, []); m.get(k).push(c); }
  return [...m.entries()].map(([key, calls]) => {
    calls.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const last = calls[0];
    return {key, calls, last, name: last.name, phone: last.phone, email: (calls.find(c => c.email) || {}).email || null,
      trip: (calls.find(c => c.trip) || {}).trip || null, open: calls.some(c => OPEN.has(c.status)), booked: calls.some(c => c.status === "Booked")};
  }).sort((a, b) => new Date(b.last.created_at) - new Date(a.last.created_at));
}
function renderCustomers() {
  const q = S.cq.toLowerCase(), all = customers();
  const list = all.filter(k => !q || [k.name, k.phone, k.trip, k.email, ...k.calls.map(c => c.notes)].some(v => (v || "").toLowerCase().includes(q)));
  $("#custCount").textContent = `${all.length} ${all.length === 1 ? "customer" : "customers"}`;
  $("#custRows").innerHTML = list.map(k => `<tr data-cust="${esc(k.key)}"><td>${esc(k.name)}</td><td class="n">${esc(k.phone)}</td><td class="hide-sm">${esc(k.trip || "—")}</td>
    <td class="n">${k.calls.length}</td><td class="n">${esc(ago(k.last.created_at))}</td><td>${k.booked ? pill("Booked") : pill(k.last.status)}</td></tr>`).join("");
  $("#custEmpty").hidden = list.length > 0;
}
$("#custSearch").addEventListener("input", e => { S.cq = e.target.value; renderCustomers(); });
function openCustomer(key) {
  const k = customers().find(x => x.key === key); if (!k) return;
  closeDrawers();
  $("#kTitle").textContent = k.name;
  $("#kSub").textContent = `${k.calls.length} ${k.calls.length === 1 ? "request" : "requests"} · first contact ${fmtDateY(k.calls[k.calls.length - 1].created_at)}`;
  const names = [...new Set(k.calls.map(c => c.name))];
  $("#kFacts").innerHTML = [["Phone", k.phone], ["Email", k.email], ["Also went by", names.length > 1 ? names.slice(1).join(", ") : null], ["Latest trip", k.trip]]
    .filter(([, v]) => v).map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join("");
  const tel = (k.phone || "").replace(/[^\d+]/g, "");
  $("#kQuick").innerHTML = tel ? `<a class="btn btn-line" href="tel:${esc(tel)}">Call ${esc(k.phone)}</a><a class="btn btn-line" href="sms:${esc(tel)}">Text</a>` : "";
  $("#kReqs").innerHTML = k.calls.map(c => `<li><button type="button" data-call="${c.id}"><span>${esc(c.trip || c.message || "No trip details")}</span><span>${pill(c.status)}</span>
    <span class="d">${esc(fmtDateY(c.created_at))} · ${esc(c.source)}${c.assigned_to ? " · " + esc(nameOf(c.assigned_to)) : ""}</span></button></li>`).join("");
  const notes = k.calls.filter(c => c.notes).map(c => `${fmtDateY(c.created_at)} (${c.source})\n${c.notes}`);
  $("#kNotes").textContent = notes.length ? notes.join("\n\n") : "No notes yet. Add notes from any of their requests.";
  $("#scrim").hidden = false; $("#custDrawer").hidden = false; $("#kClose").focus();
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
function parseTrip(c) {
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
  const t = tripDate(c.trip || "") || tripDate(s);
  return {o: codes[0] || null, d: codes[1] || null, t};
}
function bookingLink(c) {
  const {o, d, t} = parseTrip(c);
  if (!o || !d) return SITE;
  const date = t ? `-${t[0]}${String(t[1]).padStart(2, "0")}${String(t[2]).padStart(2, "0")}` : "";
  return `${SITE}#${o}-${d}${date}`;
}
const smsHref = (phone, body) => `sms:${(phone || "").replace(/[^\d+]/g, "")}?&body=${encodeURIComponent(body)}`;
function addNote(line) {   // logs what was sent to the customer; saved with the request when staff click Save
  const stamp = new Date().toLocaleString("en-US", {month: "short", day: "numeric", hour: "numeric", minute: "2-digit"});
  const box = $("#cNotes"); box.value = (box.value.trim() ? box.value.trim() + "\n" : "") + `${stamp} · ${line}`;
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
  $("#dQuick").innerHTML = c ? `<a class="btn btn-line" href="tel:${esc(c.phone.replace(/[^\d+]/g, ""))}">Call ${esc(c.phone)}</a><a class="btn btn-line" id="textLink" href="#">Text</a><button class="btn btn-line" type="button" id="copyLink">Copy booking link</button>` : "";
  const tl = $("#textLink");
  if (tl) tl.onclick = () => {   // opens the staff member's own Messages app with the booking link filled in
    const first = (c.name || "").trim().split(/\s+/)[0] || "there", link = bookingLink(c);
    const {o, d} = parseTrip(c);
    // Only say "your trip" when the link really opens their route; this button never claims we found specific flights.
    const body = link === SITE
      ? `Hi ${first}, it's Contrail, following up on your call. You can search flights and live prices here: ${link}\nReply here or call ${PHONE_LINE} and we'll help you find the right one.`
      : `Hi ${first}, it's Contrail, following up on your trip (${o} to ${d}). You can see flight options and live prices here: ${link}\nReply here or call ${PHONE_LINE} if you have any questions.`;
    tl.href = smsHref(c.phone, body);
    addNote("Texted the booking link");
    toast("Opening Messages. A note was added; click Save to keep it.");
  };
  if (c && c.source === "AI receptionist") {
    $("#dQuick").insertAdjacentHTML("beforeend", `<a class="btn btn-line" href="${GROK_CALLS}" target="_blank" rel="noopener" title="Opens Alex's call log. Look for the call from ${esc(c.phone)} at ${esc(fmtTime(c.created_at))}.">Listen in Grok ↗</a>`);
  }
  const own = $("#dOwner");
  if (!c) own.innerHTML = "";
  else if (!c.assigned_to) own.innerHTML = `Nobody has this yet. <button class="mini" type="button" data-claim="${c.id}">Claim it</button>`;
  else if (c.assigned_to === S.me.id) own.innerHTML = "This one is yours.";
  else own.innerHTML = `${esc(nameOf(c.assigned_to))} has this. <button class="mini" type="button" data-claim="${c.id}" data-force="1">Take it over</button>`;
  const dc = $("#dCust");
  if (c) {
    const k = customers().find(x => x.key === custKey(c));
    dc.hidden = !k || k.calls.length < 2;
    if (k && k.calls.length > 1) dc.innerHTML = `${esc(c.name)} has reached us ${k.calls.length} times. <button class="link" type="button" data-cust="${esc(k.key)}">See all</button>`;
  } else dc.hidden = true;
  setupQuote(c);
  $("#cStatus").value = c ? c.status : "New";
  $("#cAssign").innerHTML = `<option value="">Nobody yet</option>` + S.profiles.map(p => `<option value="${p.id}">${esc(p.full_name || p.email)}</option>`).join("");
  $("#cAssign").value = c ? (c.assigned_to || "") : S.me.id;
  $("#cCallAt").value = c ? toLocalInput(c.call_at) : "";
  $("#cNotes").value = c ? (c.notes || "") : "";
  say($("#cMsg"), "");
  SHEETS.forEach(id => { if (id !== "#drawer") $(id).hidden = true; });
  $("#scrim").hidden = false; $("#drawer").hidden = false; $("#drawer").scrollTop = 0; if (innerWidth > 760 || !c) (c ? $("#cStatus") : $("#cName")).focus({preventScroll: true});
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
const SHEETS = ["#drawer", "#evDrawer", "#custDrawer", "#moreSheet", "#iosSheet"];
function closeDrawers() { $("#scrim").hidden = true; SHEETS.forEach(id => { const d = $(id); d.hidden = true; d.style.transform = ""; }); S.editing = null; S.editingEvent = null; }
function openSheet(id) { closeDrawers(); $("#scrim").hidden = false; const d = $(id); d.hidden = false; d.scrollTop = 0; }
document.addEventListener("click", e => {
  const cl = e.target.closest("[data-claim]"); if (cl) { e.stopPropagation(); return claim(cl.dataset.claim, cl.dataset.force === "1"); }
  if (e.target.closest("[data-alerts-on]")) return alertsOn();
  const k = e.target.closest("[data-cust]"); if (k) return openCustomer(k.dataset.cust);
  const c = e.target.closest("[data-call]"); if (c && !c.closest("#drawer")) { if (c.closest("#custDrawer")) closeDrawers(); return openCall(c.dataset.call); }
  const ev = e.target.closest("[data-event]"); if (ev) return openEvent(ev.dataset.event);
  if (e.target.closest("[data-new-call]")) openCall(null);
});
$("#dClose").addEventListener("click", closeDrawers); $("#cCancel").addEventListener("click", closeDrawers); $("#scrim").addEventListener("click", closeDrawers);
$("#eClose").addEventListener("click", closeDrawers); $("#kClose").addEventListener("click", closeDrawers);
$("#mClose").addEventListener("click", closeDrawers); $("#iClose").addEventListener("click", closeDrawers);
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
  closeDrawers(); haptic(); toast("Saved."); refresh();
});

/* ---------- quote builder ---------- */
const Q = {res: null, call: null};
function setupQuote(c) {
  Q.res = null; Q.call = c; $("#dQuotes").hidden = true;
  $("#qBox").hidden = !c; $("#qBox").open = false;
  $("#qOpts").innerHTML = ""; $("#qActs").hidden = true; $("#qPreview").hidden = true; say($("#qMsg"), "");
  if (!c) return;
  const {o, d, t} = parseTrip(c);
  $("#qFrom").value = o || ""; $("#qTo").value = d || "";
  $("#qDate").value = t ? `${t[0]}-${String(t[1]).padStart(2, "0")}-${String(t[2]).padStart(2, "0")}` : "";
  const tv = /(\d{1,2})\s*(?:travel(?:l)?ers?|people|passengers|adults|ppl)/i.exec([c.trip, c.message].join(" "));
  $("#qTrav").value = tv ? tv[1] : ""; $("#qNote").value = ""; $("#qSheetOut").hidden = true; $("#qSheet").hidden = true;
  renderQuotes(c);
}
function quoteText() {
  const c = Q.call, r = Q.res; if (!c || !r) return "";
  const picked = [...$$("#qOpts input:checked")].map(i => r.options[+i.value]);
  const first = (c.name || "").trim().split(/\s+/)[0] || "there";
  const lines = picked.map(o => `• ${o.airline} ${o.flights}: ${o.dep} → ${o.arr}, ${o.stops ? "1 stop in " + o.via : "nonstop"}`);
  return `Hi ${first}, it's Contrail. Flights we found for ${r.from_city} → ${r.to_city} on ${r.date}:\n${lines.join("\n")}\n` +
    `See live prices and book: ${r.contrail_link}\nThese are based on airline schedules, so we'll confirm before you book. Questions? Call ${PHONE_LINE}.`;
}
function refreshQuote() {
  const picked = $$("#qOpts input:checked").length;
  $("#qActs").hidden = !picked; $("#qSheet").hidden = !picked;
  const t = quoteText(); $("#qText").href = Q.call ? smsHref(Q.call.phone, t) : "#";
  $("#qPreview").hidden = !picked; $("#qPreview").textContent = t;
}
$("#qFind").addEventListener("click", async () => {
  const from = $("#qFrom").value.trim(), to = $("#qTo").value.trim(), date = $("#qDate").value;
  if (!from || !to || !date) return say($("#qMsg"), "Add where they're flying from, to, and the date.", "bad");
  say($("#qMsg"), "Looking up flights…"); $("#qOpts").innerHTML = ""; $("#qActs").hidden = true; $("#qPreview").hidden = true;
  try {
    const r = await fetch(`${FN}flight-lookup?${new URLSearchParams({from, to, date})}`).then(x => x.json());
    if (!r.ok) return say($("#qMsg"), r.say || "Couldn't look that up.", "bad");
    Q.res = r;
    if (!r.options.length) return say($("#qMsg"), `No regular flights predicted ${r.from_city} → ${r.to_city} on ${r.date}. Try a nearby airport or another day.`, "bad");
    say($("#qMsg"), `${r.from_city} → ${r.to_city}, ${r.date}. Predictions from past schedules.`, "ok");
    $("#qOpts").innerHTML = r.options.map((o, i) => `<li><label><input type="checkbox" value="${i}" ${i < 3 ? "checked" : ""}>
      <span><b style="font-weight:500">${esc(o.airline)} ${esc(o.flights)}</b> · ${esc(o.dep)} → ${esc(o.arr)}</span>
      <span class="o-conf">${esc(o.word)}<br>${o.conf}%</span><span class="o-sub">${o.stops ? "1 stop in " + esc(o.via) : "Nonstop"}</span></label>
      <div class="qp">Price per person <input class="qprice" data-i="${i}" inputmode="decimal" placeholder="$ optional" aria-label="Price per person for ${esc(o.airline)} ${esc(o.flights)}"></div></li>`).join("");
    $("#qSheetOut").hidden = true;
    refreshQuote();
  } catch (e) { say($("#qMsg"), friendly(e), "bad"); }
});
$("#qOpts").addEventListener("change", e => { if (e.target.type === "checkbox") refreshQuote(); });

/* ---------- quote sheets (a branded page the customer opens) ---------- */
const quoteUrl = t => `${SITE}quote.html#q=${t}`;
const price = v => { const n = parseFloat(String(v || "").replace(/[^\d.]/g, "")); return isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : null; };
$("#qSheetBtn").addEventListener("click", async () => {
  const c = Q.call, r = Q.res, btn = $("#qSheetBtn");
  const picked = [...$$("#qOpts input:checked")].map(i => +i.value);
  if (!c || !r || !picked.length) return;
  const trav = parseInt($("#qTrav").value, 10);
  const me = S.profiles.find(p => p.id === S.me.id) || {};
  const row = {call_id: c.id, customer_name: c.name, origin: r.from, destination: r.to, from_city: r.from_city, to_city: r.to_city,
    travel_date: $("#qDate").value || null, date_label: r.date, travelers: trav >= 1 && trav <= 99 ? trav : null,
    options: picked.map(i => ({...r.options[i], price: price($(`.qprice[data-i="${i}"]`).value)})),
    note: $("#qNote").value.trim() || null, book_url: r.contrail_link, prepared_name: me.full_name || null,
    // a quote never stays valid past the night before the flight
    expires_at: new Date(Math.min(Date.now() + (+$("#qValidFor").value || 7) * 864e5,
      $("#qDate").value ? Math.max(Date.now() + 36e5, new Date($("#qDate").value + "T00:00:00").getTime() - 1000) : Infinity)).toISOString()};
  btn.disabled = true; say($("#qMsg"), "Creating the quote sheet…");
  const {data, error} = await db.from("quotes").insert(row).select("token").single();
  btn.disabled = false;
  if (error) return say($("#qMsg"), /relation .*quotes|does not exist/i.test(error.message) ? "Quote sheets aren't switched on yet. Run quotes.sql in Supabase first." : friendly(error), "bad");
  const url = quoteUrl(data.token), first = (c.name || "").trim().split(/\s+/)[0] || "there";
  const msg = `Hi ${first}, it's Contrail. Here's your flight quote for ${r.from_city} → ${r.to_city} on ${r.date}: ${url}\nTap a flight to see live prices and book, or call ${PHONE_LINE} and we'll help.`;
  const out = $("#qSheetOut"); out.hidden = false;
  out.innerHTML = `<span>Quote sheet ready. Send this link to ${esc(first)}:</span><a href="${esc(url)}&preview" target="_blank" rel="noopener">${esc(url)}</a>
    <div class="qlinks"><a class="btn btn-black" href="${esc(smsHref(c.phone, msg))}" id="qSheetText">Text it</a><button class="btn btn-line" type="button" id="qSheetCopy">Copy link</button><a class="btn btn-line" href="${esc(url)}&preview" target="_blank" rel="noopener">Preview</a></div>`;
  $("#qSheetText").addEventListener("click", () => toast("Opening Messages. Click Save to keep the note."));
  $("#qSheetCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(url); toast("Link copied."); } catch (e) { toast("Select the link above and copy it."); } });
  addNote(`Made a quote sheet: ${r.from}→${r.to} ${r.date}, ${picked.length} option${picked.length > 1 ? "s" : ""}`);
  haptic(); say($("#qMsg"), "Quote sheet created. Send the link, then click Save.", "ok");
  const fresh = await db.from("quotes").select("id,token,call_id,origin,destination,date_label,created_at,views,viewed_at,expires_at").order("created_at", {ascending: false}).limit(500);
  if (!fresh.error) { S.quotes = fresh.data; renderQuotes(c); }
});
function renderQuotes(c) {
  const list = c ? S.quotes.filter(q => q.call_id === c.id) : [];
  $("#dQuotes").hidden = !list.length;
  $("#dQuoteList").innerHTML = list.map(q => `<li><a href="${esc(quoteUrl(q.token))}&preview" target="_blank" rel="noopener" style="all:unset;box-sizing:border-box;cursor:pointer;width:100%;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 12px;padding:12px 4px;font-size:14px">
    <span>${esc(q.origin)} → ${esc(q.destination)} · ${esc(q.date_label || "")}</span><span class="d">${q.views ? `Opened ${q.views}×` : "Not opened yet"}</span>
    <span class="d">Sent ${esc(fmtDateY(q.created_at))}${new Date(q.expires_at) < new Date() ? " · expired" : ""}</span><span class="d">${q.viewed_at ? esc(ago(q.viewed_at)) : ""}</span></a></li>`).join("");
}
$("#qText").addEventListener("click", e => {
  if (!$$("#qOpts input:checked").length) { e.preventDefault(); return; }
  refreshQuote(); addNote(`Texted a quote: ${Q.res.from}→${Q.res.to} ${Q.res.date} (${$$("#qOpts input:checked").length} options)`);
  toast("Opening Messages. A note was added; click Save to keep it.");
});
$("#qCopy").addEventListener("click", async () => {
  const t = quoteText();
  try { await navigator.clipboard.writeText(t); toast("Message copied."); } catch (e) { toast("Select the message below and copy it."); }
  addNote(`Copied a quote: ${Q.res.from}→${Q.res.to} ${Q.res.date}`);
});

/* ---------- phone alerts ---------- */
const pushOK = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let swReg = null;
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").then(r => { swReg = r; renderAlerts(); }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", e => { const u = e.data && e.data.open; if (u) { const m = /#call=(\d+)/.exec(u); if (m) { pendingCall = m[1]; openPending(); } } });
}
const b64ToU8 = b => { const s = atob((b + "=".repeat((4 - b.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, ch => ch.charCodeAt(0)); };
async function currentSub() { try { return swReg ? await swReg.pushManager.getSubscription() : null; } catch (e) { return null; } }
async function renderAlerts() {
  if (!S.me) return;
  const sub = await currentSub(), on = !!sub && Notification.permission === "granted";
  const blocked = pushOK() && Notification.permission === "denied";
  const needInstall = isIOS && !standalone();
  $("#alertsBtn").hidden = on; $("#alertsTest").hidden = !on; $("#alertsOff").hidden = !on;
  $("#alertState").textContent = !pushOK() && !needInstall ? "This browser can't show alerts. Try Chrome, Edge or Safari." :
    needInstall ? "On iPhone, add Contrail to your Home Screen first (steps below), then turn on alerts from there." :
    blocked ? "Alerts are blocked for this site. Allow notifications in your browser settings, then try again." :
    on ? "Alerts are on for this device." : "Get a notification on this device for every new call request.";
  let dismissed = false; try { dismissed = localStorage.getItem("contrail-alerts-banner") === "hide"; } catch (e) {}
  $("#alertBanner").hidden = on || blocked || dismissed || (!pushOK() && !needInstall);
  $("#alertBannerText").textContent = needInstall ? "Want phone alerts? On iPhone, add Contrail to your Home Screen first (Share → Add to Home Screen)." : "Get a phone alert the moment someone asks for a call back.";
}
async function alertsOn() {
  const m = $("#alertMsg");
  if (isIOS && !standalone()) { openSheet("#iosSheet"); return; }
  if (!pushOK()) return say(m, "This browser can't show alerts.", "bad");
  try {
    say(m, "Turning on alerts…");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") { renderAlerts(); return say(m, "Notifications weren't allowed. You can allow them in your browser settings.", "bad"); }
    if (!swReg) swReg = await navigator.serviceWorker.register("sw.js");
    await navigator.serviceWorker.ready;
    const {publicKey} = await fetch(FN + "push-notify?action=key").then(r => r.json());
    const sub = (await swReg.pushManager.getSubscription()) || await swReg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64ToU8(publicKey)});
    const j = sub.toJSON();
    const {error} = await db.from("push_subscriptions").upsert({user_id: S.me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth, user_agent: navigator.userAgent.slice(0, 300)}, {onConflict: "endpoint"});
    if (error) throw error;
    say(m, "Alerts are on. Sending a test…", "ok"); await sendTest(); renderAlerts();
  } catch (e) { say(m, friendly(e), "bad"); }
}
async function sendTest() {
  const {data} = await db.auth.getSession();
  const r = await fetch(FN + "push-notify?action=test", {method: "POST", headers: {Authorization: "Bearer " + (data.session && data.session.access_token)}}).then(x => x.json()).catch(() => ({}));
  say($("#alertMsg"), r.sent ? "Test sent. You should see it in a few seconds." : "Couldn't send a test. Try turning alerts off and on.", r.sent ? "ok" : "bad");
}
$("#alertsTest").addEventListener("click", sendTest);
$("#alertsOff").addEventListener("click", async () => {
  const sub = await currentSub();
  if (sub) { await db.from("push_subscriptions").delete().eq("endpoint", sub.endpoint); await sub.unsubscribe().catch(() => {}); }
  say($("#alertMsg"), "Alerts are off on this device.", "ok"); renderAlerts();
});
$("#alertBanner").addEventListener("dblclick", () => { try { localStorage.setItem("contrail-alerts-banner", "hide"); } catch (e) {} renderAlerts(); });

/* ---------- event drawer ---------- */
function openEvent(id) {
  const ev = id ? S.events.find(x => String(x.id) === String(id)) : null; S.editingEvent = ev ? ev.id : "new";
  $("#eTitle").textContent = ev ? "Edit event" : "Add an event";
  $("#eName").value = ev ? ev.title : ""; $("#eAt").value = ev ? toLocalInput(ev.starts_at) : ""; $("#eDetail").value = ev ? (ev.detail || "") : "";
  $("#eDelete").hidden = !ev; say($("#eMsg"), "");
  SHEETS.forEach(id => { if (id !== "#evDrawer") $(id).hidden = true; });
  $("#scrim").hidden = false; $("#evDrawer").hidden = false; $("#eName").focus({preventScroll: true});
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

/* ---------- app feel: More sheet, + button, gestures, install, offline ---------- */
const haptic = () => { try { navigator.vibrate && navigator.vibrate(8); } catch (e) {} };
document.addEventListener("click", e => {
  if (e.target.closest("[data-more]")) { $("#mName").textContent = $("#meName").textContent || "More"; $("#mEmail").textContent = S.me ? S.me.email : ""; openSheet("#moreSheet"); return; }
  const g = e.target.closest("[data-go]"); if (g) { closeDrawers(); openTab(g.dataset.go); return; }
  if (e.target.closest("[data-install]")) { install(); return; }
});
$("#mSignOut").addEventListener("click", () => { closeDrawers(); db.auth.signOut(); });
$("#fab").addEventListener("click", () => { haptic(); S.tab === "calendar" ? openEvent(null) : openCall(null); });

// Swipe a sheet down to close it (phones).
SHEETS.forEach(id => {
  const d = $(id); let y0 = null, dy = 0;
  d.addEventListener("touchstart", e => { if (innerWidth > 760 || d.scrollTop > 0 || e.target.closest("input,textarea,select")) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; }, {passive: true});
  d.addEventListener("touchmove", e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) { d.classList.add("dragging"); d.style.transform = `translateY(${dy}px)`; } }, {passive: true});
  d.addEventListener("touchend", () => {
    if (y0 == null) return; y0 = null; d.classList.remove("dragging");
    if (dy > 110) { closeDrawers(); haptic(); return; }
    d.classList.add("snap"); d.style.transform = ""; setTimeout(() => d.classList.remove("snap"), 260);
  });
});

// Pull down at the top of a screen to refresh.
(() => {
  const ind = $("#ptr"); let y0 = null, dy = 0, busy = false;
  const sheetOpen = () => SHEETS.some(id => !$(id).hidden);
  addEventListener("touchstart", e => { y0 = (innerWidth <= 760 && scrollY <= 0 && !sheetOpen() && !busy && $("#vApp").hidden === false) ? e.touches[0].clientY : null; dy = 0; }, {passive: true});
  addEventListener("touchmove", e => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); const p = Math.min(dy, 110);
    ind.style.opacity = String(Math.min(1, p / 70)); ind.style.transform = `translateY(${p - 60}px) rotate(${p * 3}deg)`; }, {passive: true});
  addEventListener("touchend", async () => {
    if (y0 == null) return; y0 = null;
    if (dy > 75) { busy = true; haptic(); ind.classList.add("go"); ind.style.transform = "translateY(20px)"; await refresh(); ind.classList.remove("go"); busy = false; toast("Up to date."); }
    ind.style.transition = "transform .2s, opacity .2s"; ind.style.opacity = "0"; ind.style.transform = "translateY(-70px)"; setTimeout(() => { ind.style.transition = ""; }, 220);
  });
})();

// Install as an app.
let installEvt = null;
const dismissedInstall = () => { try { return localStorage.getItem("contrail-install") === "later"; } catch (e) { return false; } };
function renderInstall() {
  const can = !!installEvt, ios = isIOS && !standalone();
  $("#mInstall").hidden = !(can || ios);
  $("#installBanner").hidden = standalone() || dismissedInstall() || !(can || ios);
  $("#installText").textContent = ios ? "Add Contrail to your Home Screen to use it like an app and get phone alerts." : "Install Contrail as an app for one-tap access and phone alerts.";
}
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; renderInstall(); });
addEventListener("appinstalled", () => { installEvt = null; renderInstall(); toast("Contrail is installed. Open it from your home screen or apps."); });
async function install() {
  closeDrawers();
  if (installEvt) { installEvt.prompt(); const r = await installEvt.userChoice.catch(() => ({})); installEvt = null; renderInstall(); if (r.outcome === "accepted") haptic(); return; }
  if (isIOS) { openSheet("#iosSheet"); return; }
  toast("Use your browser's menu to install or add this page to your home screen.");
}
$("#installLater").addEventListener("click", () => { try { localStorage.setItem("contrail-install", "later"); } catch (e) {} renderInstall(); });
renderInstall();

// Offline notice; refresh when the app comes back to the foreground.
const net = () => { $("#offline").hidden = navigator.onLine; };
addEventListener("online", () => { net(); if (S.me) refresh(); }); addEventListener("offline", net); net();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.me) refresh(); });
})();
