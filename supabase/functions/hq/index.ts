// Emperor's Mind — server function: push reminders, live quotes, economic calendar.
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...CORS, "Content-Type": "application/json" } });
function serviceKey() {
  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"); if (legacy) return legacy;
  try { const k = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); return k.default || Object.values(k)[0]; } catch (_) { return ""; }
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey() as string, { auth: { persistSession: false } });
const APP = "https://bjifsdbgjr34.github.io/emperors-mind/";

async function secret(name: string) { const { data } = await admin.from("hq_secrets").select("value").eq("name", name).maybeSingle(); return data?.value ?? null; }
let VAPID_PUB: string | null = null;
async function vapid() {
  if (VAPID_PUB) return VAPID_PUB;
  let pub = await secret("vapid_public"), priv = await secret("vapid_private");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await admin.from("hq_secrets").upsert([{ name: "vapid_public", value: k.publicKey }, { name: "vapid_private", value: k.privateKey }], { onConflict: "name", ignoreDuplicates: true });
    pub = await secret("vapid_public"); priv = await secret("vapid_private");
  }
  webpush.setVapidDetails(APP, pub!, priv!);
  VAPID_PUB = pub; return pub;
}

/* ---------- time in Zurich ---------- */
function zurich(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short" }).formatToParts(d).map((x) => [x.type, x.value]));
  const hour = +p.hour % 24;
  return { day: `${p.year}-${p.month}-${p.day}`, mins: hour * 60 + +p.minute, wd: p.weekday as string, dom: +p.day };
}
const addDays = (s: string, n: number) => { const d = new Date(s + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const hm = (s: string) => { const [h, m] = (s || "").split(":").map(Number); return isFinite(h) ? h * 60 + (m || 0) : -1; };

/* ---------- quotes (Yahoo chart endpoint) ---------- */
async function quotes(symbols: string[]) {
  const out: Record<string, unknown> = {};
  await Promise.all([...new Set(symbols)].slice(0, 60).map(async (s) => {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=1d&interval=1d`, { headers: { "User-Agent": "Mozilla/5.0" } });
      const j = await r.json(); const m = j?.chart?.result?.[0]?.meta;
      if (m && m.regularMarketPrice != null) out[s] = { price: m.regularMarketPrice, prev: m.chartPreviousClose ?? m.previousClose ?? null, cur: m.currency, name: m.shortName || m.longName || null, t: m.regularMarketTime };
    } catch (_) { /* skip */ }
  }));
  return out;
}

/* ---------- economic calendar (ForexFactory weekly feed), cached 1h ---------- */
async function calendar() {
  const { data } = await admin.from("hq_secrets").select("value").eq("name", "ff_cache").maybeSingle();
  if (data?.value) { try { const c = JSON.parse(data.value); if (Date.now() - c.t < 3600e3) return c.events; } catch (_) { /* refetch */ } }
  const r = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) { if (data?.value) return JSON.parse(data.value).events; throw new Error("calendar " + r.status); }
  const ev = (await r.json()).map((e: Record<string, string>) => ({ title: e.title, country: e.country, date: e.date, impact: e.impact, forecast: e.forecast, previous: e.previous }));
  await admin.from("hq_secrets").upsert({ name: "ff_cache", value: JSON.stringify({ t: Date.now(), events: ev }) });
  return ev;
}

/* ---------- push ---------- */
async function sendTo(userId: string, payload: Record<string, unknown>) {
  await vapid();
  const { data: subs } = await admin.from("push_subs").select("endpoint,sub").eq("user_id", userId);
  let sent = 0;
  for (const s of subs || []) {
    try { await webpush.sendNotification(s.sub, JSON.stringify(payload), { TTL: 3600 }); sent++; }
    catch (e) { const code = (e as { statusCode?: number }).statusCode; if (code === 404 || code === 410) await admin.from("push_subs").delete().eq("endpoint", s.endpoint); else console.error("push", code, (e as Error).message); }
  }
  return sent;
}
async function streakOf(userId: string, today: string) {
  const { data } = await admin.from("docs").select("id,data").eq("user_id", userId).eq("col", "days").gte("id", addDays(today, -800));
  const active = new Set((data || []).filter((r) => Object.values((r.data as { done?: Record<string, boolean> })?.done || {}).some(Boolean)).map((r) => r.id));
  let d = active.has(today) ? today : addDays(today, -1), n = 0;
  while (active.has(d) && n < 5000) { n++; d = addDays(d, -1); }
  return { cur: n, todayActive: active.has(today) };
}
async function doc(userId: string, col: string, id: string) { const { data } = await admin.from("docs").select("data").eq("user_id", userId).eq("col", col).eq("id", id).maybeSingle(); return (data?.data || null) as Record<string, unknown> | null; }

async function notifyAll() {
  const z = zurich();
  const { data: subs } = await admin.from("push_subs").select("user_id");
  const users = [...new Set((subs || []).map((s) => s.user_id))];
  let total = 0;
  let redToday: number | null = null;
  for (const uid of users) {
    const st = { enabled: true, morning: "07:00", streak: "21:00", aar: "21:30", weekly: true, weeklyTime: "18:00", monthly: true, ...(await doc(uid, "misc", "notify") || {}) } as Record<string, unknown>;
    if (st.enabled === false) continue;
    const due: { key: string; time: number; build: () => Promise<Record<string, unknown> | null> }[] = [];
    if (st.morning) due.push({ key: "morning", time: hm(st.morning as string), build: async () => {
      const s = await streakOf(uid, z.day);
      if (redToday === null) { try { const ev = await calendar(); redToday = ev.filter((e: { impact: string; country: string; date: string }) => e.impact === "High" && e.country === "USD" && zurich(new Date(e.date)).day === z.day).length; } catch (_) { redToday = 0; } }
      return { title: "Good morning, Emperor Blanco", body: `Day ${s.cur} 🔥 — win the morning.${redToday ? ` ${redToday} red-folder event${redToday > 1 ? "s" : ""} today.` : ""}`, url: "#home" };
    } });
    if (st.streak) due.push({ key: "streak", time: hm(st.streak as string), build: async () => {
      const s = await streakOf(uid, z.day); if (s.todayActive) return null;
      return { title: s.cur ? `🔥 Your ${s.cur}-day streak is in danger` : "No task done today", body: "Complete one task before midnight to keep it alive.", url: "#home" };
    } });
    if (st.aar) due.push({ key: "aar", time: hm(st.aar as string), build: async () => {
      const a = await doc(uid, "aar", z.day); if (a && (a.happened || a.change)) return null;
      return { title: "After Action Report", body: "Debrief the day: plan, reality, why, and what changes tomorrow.", url: "#warroom" };
    } });
    if (st.weekly && z.wd === "Sun") due.push({ key: "weekly", time: hm((st.weeklyTime as string) || "18:00"), build: async () => ({ title: "Weekly review", body: "Sunday debrief — review the week and set next week's focus.", url: "#review" }) });
    if (st.monthly && z.dom === 1) due.push({ key: "monthly", time: 9 * 60, build: async () => ({ title: "Your monthly report is ready", body: "See how last month went — and plan the next one.", url: "#monthly" }) });
    for (const r of due) {
      if (r.time < 0 || z.mins < r.time || z.mins - r.time > 30) continue;
      const { error } = await admin.from("push_log").insert({ user_id: uid, key: r.key, day: z.day });
      if (error) continue; // already sent today
      const p = await r.build(); if (!p) continue;
      total += await sendTo(uid, p);
    }
  }
  return { users: users.length, sent: total, at: z };
}

async function userFrom(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data } = await admin.auth.getUser(jwt);
  return data?.user || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    if (req.method === "POST") { try { body = await req.json(); } catch (_) { /* empty */ } }
    const action = (body.action as string) || url.searchParams.get("action") || "";
    if (action === "vapid") return json({ key: await vapid() });
    if (action === "quotes") return json({ quotes: await quotes(((body.symbols as string[]) || (url.searchParams.get("symbols") || "").split(",")).map((s) => String(s).trim()).filter(Boolean)) });
    if (action === "calendar") return json({ events: await calendar() });
    if (action === "notify") return json(await notifyAll());
    if (action === "test") {
      const u = await userFrom(req); if (!u) return json({ error: "Not signed in" }, 401);
      const n = await sendTo(u.id, { title: "Emperor's Mind", body: "Notifications are working. 👑", url: "#home" });
      return json({ sent: n });
    }
    return json({ ok: true, actions: ["vapid", "quotes", "calendar", "notify", "test"] });
  } catch (e) {
    console.error(e); return json({ error: (e as Error).message }, 500);
  }
});
