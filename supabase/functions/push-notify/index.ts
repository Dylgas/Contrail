// Contrail: phone alerts for staff.
//   GET  ?action=key   -> the public key browsers need to subscribe (created on first use, stored server-side)
//   POST ?action=test  -> sends a test alert to the signed-in staff member's devices (needs their login token)
//   POST (from the database triggers, with the webhook secret as Bearer) -> alerts every staff device about a new call request
//        ({record}) or quote activity ({alert: {title, body, url, tag}})
// Deploy with JWT verification OFF; every path checks its own credentials.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const db = createClient(Deno.env.get("SUPABASE_URL")!, (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_SECRET_KEY"))!, {
  auth: { persistSession: false },
});
const STAFF_URL = "https://dylgas.github.io/Contrail/staff/";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "authorization, content-type" };
const json = (v: unknown, status = 200) => Response.json(v, { status, headers: CORS });

let keys: { publicKey: string; privateKey: string } | null = null;
async function vapid() {
  if (keys) return keys;
  const read = async () => (await db.from("app_secrets").select("value").eq("name", "vapid").maybeSingle()).data?.value;
  let v = await read();
  if (!v) {
    const k = webpush.generateVAPIDKeys();
    await db.from("app_secrets").insert({ name: "vapid", value: JSON.stringify(k) });   // ignored if another request won the race
    v = await read();
  }
  keys = JSON.parse(v);
  webpush.setVapidDetails(STAFF_URL, keys!.publicKey, keys!.privateKey);
  return keys!;
}

let hookKey: string | null = null;
async function hookOk(req: Request) {
  const got = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!got) return false;
  if (!hookKey) hookKey = (await db.from("webhook_keys").select("key").eq("name", "ai-receptionist").maybeSingle()).data?.key ?? null;
  return !!hookKey && got.length === hookKey.length && got === hookKey;
}

async function sendTo(subs: any[], payload: Record<string, unknown>) {
  await vapid();
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: "high" });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) await db.from("push_subscriptions").delete().eq("endpoint", s.endpoint);  // device unsubscribed
      else console.error("push failed", e?.statusCode, e?.body || e?.message);
    }
  }));
  return sent;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const action = new URL(req.url).searchParams.get("action");
  try {
    if (req.method === "GET" && action === "key") return json({ publicKey: (await vapid()).publicKey });

    if (req.method === "POST" && action === "test") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: u } = await db.auth.getUser(token);
      if (!u?.user) return json({ error: "Sign in first." }, 401);
      const { data: subs } = await db.from("push_subscriptions").select("*").eq("user_id", u.user.id);
      const sent = await sendTo(subs || [], { title: "Contrail alerts are on", body: "You'll get a notification like this for every new call request.", url: STAFF_URL + "#calls" });
      return json({ ok: true, sent });
    }

    if (req.method === "POST") {
      if (!(await hookOk(req))) return json({ error: "Not allowed." }, 401);
      const { record: r, alert: a } = await req.json();
      const { data: subs } = await db.from("push_subscriptions").select("*");
      if (a?.title) {   // quote activity: customer opened a quote or picked an option
        const url = typeof a.url === "string" && a.url.startsWith(STAFF_URL) ? a.url : STAFF_URL + "#calls";
        const sent = await sendTo(subs || [], { title: String(a.title).slice(0, 120), body: String(a.body || "").slice(0, 200), url, tag: String(a.tag || "quote").slice(0, 60) });
        return json({ ok: true, sent });
      }
      if (!r?.id) return json({ error: "No record." }, 400);
      const what = r.trip || r.message || r.phone || "";
      const sent = await sendTo(subs || [], {
        title: `New call request: ${r.name}`,
        body: `${r.source === "AI receptionist" ? "Called Alex" : r.source === "Website form" ? "From the website" : r.source}${what ? " · " + String(what).slice(0, 120) : ""}`,
        url: `${STAFF_URL}#call=${r.id}`, tag: `call-${r.id}`,
      });
      return json({ ok: true, sent });
    }
    return json({ error: "Unknown request." }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "Alert service error." }, 500);
  }
});
