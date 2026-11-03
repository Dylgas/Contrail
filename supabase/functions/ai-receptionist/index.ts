// Contrail: AI receptionist -> staff site "Call requests".
// My AI Front Desk sends a post-call webhook here; each call becomes a call request (source "AI receptionist").
// The address must carry ?key=<secret>. The secret lives in the webhook_keys table (only the server can read it).
// Deploy with JWT verification OFF, because the receptionist cannot send a Supabase login.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!, {
  auth: { persistSession: false },
});

const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
const NAME = ["callername", "customername", "contactname", "leadname", "fullname", "name"];
const FIRST = ["firstname", "callerfirstname"], LAST = ["lastname", "callerlastname"];
const PHONE = ["callernumber", "callerphone", "callerphonenumber", "customerphone", "customernumber", "phonenumber",
  "phone", "fromnumber", "from", "callerid", "caller", "number"];
const EMAIL = ["email", "calleremail", "customeremail", "emailaddress"];
const SUMMARY = ["summary", "callsummary", "aisummary", "conversationsummary", "notes", "description"];
const ID = ["callid", "conversationid", "callsid"];
const TRIP_HINT = /destination|trip|travel|depart|return|route|flight|airport|dates?$/;
const BEST_HINT = /besttime|callback|preferredtime|availability/;
const SKIP = /transcript|recording|url|audio|timestamp|createdat|updatedat|duration|cost|status|direction|key|token/;

type Leaf = { path: string; key: string; value: string };

function leaves(v: unknown, path = "", out: Leaf[] = []): Leaf[] {
  if (v === null || v === undefined) return out;
  if (typeof v === "object") {
    if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${path}[${i}]`, out));
    else for (const [k, x] of Object.entries(v as Record<string, unknown>)) leaves(x, path ? `${path}.${k}` : k, out);
    return out;
  }
  const s = String(v).trim();
  if (s) out.push({ path, key: norm(path.split(".").pop()!.replace(/\[\d+\]$/, "")), value: s });
  return out;
}

const pick = (ls: Leaf[], keys: string[], ok: (s: string) => boolean = () => true) => {
  for (const k of keys) { const hit = ls.find((l) => l.key === k && ok(l.value)); if (hit) return hit; }
  return null;
};
const isPhone = (s: string) => (s.match(/\d/g) || []).length >= 7 && s.length <= 30;
const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 200;
const label = (p: string) => p.split(".").pop()!.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase());
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function toRequest(payload: unknown) {
  const ls = leaves(payload);
  const used = new Set<Leaf>();
  const take = (l: Leaf | null) => (l ? (used.add(l), l.value) : null);

  let name = take(pick(ls, NAME, (s) => !isPhone(s) && s.length <= 120));
  if (!name) {
    const f = take(pick(ls, FIRST)), l = take(pick(ls, LAST));
    name = [f, l].filter(Boolean).join(" ") || null;
  }
  const phone = take(pick(ls, PHONE, isPhone));
  const email = take(pick(ls, EMAIL, isEmail));
  const summary = take(pick(ls, SUMMARY, (s) => s.length > 3));
  const idOk = (s: string) => s.length >= 4 && s.length <= 200;
  const extId = take(pick(ls, ID, idOk) || ls.find((l) => (l.path === "id" || l.path === "uuid") && idOk(l.value)) || null);

  const trip: string[] = [], best: string[] = [], extra: string[] = [];
  for (const l of ls) {
    if (used.has(l) || SKIP.test(l.key) || l.value.length > 300) continue;
    if (TRIP_HINT.test(l.key)) trip.push(`${label(l.path)}: ${l.value}`);
    else if (BEST_HINT.test(l.key)) best.push(l.value);
    else if (l.value.length <= 200 && !/^\d{9,}$/.test(l.value)) extra.push(`${label(l.path)}: ${l.value}`);
  }

  const digits = (phone || "").replace(/\D/g, "");
  const message = [summary, extra.length ? extra.join("\n") : null].filter(Boolean).join("\n\n");
  return {
    name: clip(name || (digits ? `Caller …${digits.slice(-4)}` : "Caller"), 120),
    phone: phone || "Unknown",
    email,
    trip: trip.length ? clip(trip.join(" · "), 300) : null,
    best_time: best.length ? clip(best.join(", "), 120) : null,
    message: message ? clip(message, 2000) : null,
    source: "AI receptionist",
    status: "New",
    external_id: extId,
    raw: payload,
  };
}

let cachedKey: string | null = null;
async function keyOk(k: string) {
  if (!k) return false;
  if (!cachedKey) {
    const { data, error } = await db.from("webhook_keys").select("key").eq("name", "ai-receptionist").maybeSingle();
    if (error || !data) console.error("Key lookup failed:", error?.message ?? "no row", "| service key set:", !!(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY")));
    cachedKey = data?.key ?? null;
  }
  if (cachedKey && k.length !== cachedKey.length) console.error(`Key length mismatch: got ${k.length}, expected ${cachedKey.length}`);
  {
  }
  if (!cachedKey || k.length !== cachedKey.length) return false;
  let d = 0;
  for (let i = 0; i < k.length; i++) d |= k.charCodeAt(i) ^ cachedKey.charCodeAt(i);
  return d === 0;
}

const reply = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status, headers: { "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json" },
  });

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text); } catch { /* not JSON */ }
  const form = new URLSearchParams(text);
  if ([...form.keys()].length > 0 && text.includes("=")) return Object.fromEntries(form);
  return { summary: text };
}

Deno.serve(async (req) => {
  const ok = await keyOk(new URL(req.url).searchParams.get("key") || "");
  if (!ok) return reply({ error: "Wrong or missing key." }, 401);
  if (req.method === "GET") return reply("Connected. Contrail is ready to receive calls from your AI receptionist.");
  if (req.method !== "POST") return reply({ error: "Send a POST." }, 405);

  let payload: unknown;
  try { payload = await readBody(req); } catch { return reply({ error: "Couldn't read the call details." }, 400); }
  // Retell AI sends call_started, call_ended and call_analyzed. Only the last one has the summary, so file that one.
  const p = payload as Record<string, any>;
  let row;
  if (p && typeof p.event === "string" && p.call && typeof p.call === "object") {
    if (p.event !== "call_analyzed") return reply({ ok: true, ignored: p.event });
    const c = p.call, a = c.call_analysis || {};
    row = toRequest({ call_id: c.call_id, from_number: c.from_number, summary: a.call_summary, ...(a.custom_analysis_data || {}) });
    const { transcript_object, transcript_with_tool_calls, ...keep } = c;
    row.raw = { event: p.event, call: keep };
  } else {
    row = toRequest(payload);
  }
  const q = row.external_id
    ? db.from("call_requests").upsert(row, { onConflict: "external_id", ignoreDuplicates: true })
    : db.from("call_requests").insert(row);
  const { error } = await q;
  if (error) { console.error(error); return reply({ error: "Couldn't save the call." }, 500); }
  return reply({ ok: true });
});
