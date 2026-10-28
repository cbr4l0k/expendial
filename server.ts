import { mkdir, rename } from "node:fs/promises";

type Row = Record<string, unknown> & { id: string };
type State = { rev: number; expenses: Row[]; subs: Row[]; settings: Record<string, unknown> };
type Rates = Record<string, number>;
type RateEntry = { on: string; rates: Rates | null; source: "auto" | "manual" };

const DATA_DIR = process.env.DATA_DIR ?? "./data";
const FILE = `${DATA_DIR}/state.json`;
const COLLS = ["expenses", "subs"] as const;
// Keep in sync with DEFAULT_RATES in public/index.html.
const CURRENCIES = ["USD", "EUR", "GBP", "RUB", "CLP", "COP", "MXN", "ARS", "PEN", "BRL", "CAD", "AUD", "JPY", "CHF", "CNY", "KZT"];
const RATES_URL = "https://open.er-api.com/v6/latest/USD";

await mkdir(DATA_DIR, { recursive: true });
const stored = Bun.file(FILE);
let state: State = (await stored.exists()) ? await stored.json() : { rev: 0, expenses: [], subs: [], settings: {} };

// Changes run one at a time; memory only moves forward once the new state is on disk.
let queue: Promise<unknown> = Promise.resolve();
function commit(change: (s: State) => State): Promise<State> {
  const run = queue.then(async () => {
    const next = { ...change(state), rev: (state.rev ?? 0) + 1 }; // rev lets pages drop out-of-order responses
    await Bun.write(`${FILE}.tmp`, JSON.stringify(next));
    await rename(`${FILE}.tmp`, FILE);
    return (state = next);
  });
  queue = run.catch(() => {}); // one failed write must not block the ones after it
  return run;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isColl = (c: string): c is (typeof COLLS)[number] => (COLLS as readonly string[]).includes(c);
const badRequest = (msg: string) => new Response(msg, { status: 400 });
const todayISO = () => new Date().toISOString().slice(0, 10);
const rateLog = (s: State) => (Array.isArray(s.settings.rateLog) ? (s.settings.rateLog as RateEntry[]) : []);

// Every day's rates are kept, so past entries keep converting at the rates of their own day.
// The first entry (on "") holds the rates in use before the log existed.
function logRates(s: State, rates: Rates, source: RateEntry["source"]): State {
  const prev = rateLog(s);
  const seed: RateEntry[] = prev.length ? prev : [{ on: "", rates: isObject(s.settings.rates) ? (s.settings.rates as Rates) : null, source: "manual" }];
  const on = todayISO();
  return { ...s, settings: { ...s.settings, rates, rateLog: [...seed.filter((e) => e.on !== on), { on, rates, source }] } };
}

async function refreshRates() {
  if (state.settings.autoRates === false) return;
  const last = rateLog(state).at(-1);
  if (last?.on === todayISO() && last.source === "auto") return;
  try {
    const res = await fetch(RATES_URL, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { result?: string; rates?: Rates };
    const all = body.rates;
    if (body.result !== "success" || !all) throw new Error(`unexpected answer from ${RATES_URL}`);
    const rates = Object.fromEntries(CURRENCIES.filter((c) => all[c] > 0).map((c) => [c, all[c]]));
    // Auto updates may have been turned off while the fetch was running.
    await commit((s) => (s.settings.autoRates === false ? s : logRates(s, rates, "auto")));
  } catch (err) {
    console.warn("rate refresh failed:", err);
  }
}

/* ---------- ntfy reminders ---------- */
type Sub = {
  id: string; name?: string; amount?: number; cur?: string; cycle?: string; start?: string; status?: string;
  endedOn?: string; pay?: string; trial?: boolean; payments?: Record<string, unknown>; history?: { from: string; amount: number }[];
};
// Like stopDate in public/index.html: a paused or cancelled subscription still bills up to its end date.
const billsUntil = (s: Sub, day: string) => (s.status ?? "active") === "active" || (!!s.endedOn && day <= s.endedOn);
const NOTIFY_HOUR = 9; // local time, on the day before a charge

// Dates in the ledger are the person's local dates, so "today" is worked out in their time zone (saved by the page).
function localNow(tz: unknown): { date: string; hour: number } {
  const parts = (timeZone?: string) => Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  let p: Record<string, string>;
  try { p = parts(typeof tz === "string" ? tz : undefined); } catch { p = parts("UTC"); }
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}
const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
const ymd = (iso: string) => iso.split("-").map(Number) as [number, number, number];

// Same rule as nthCharge in public/index.html: every 7 days, or the start's day of the month, clamped to short months.
function billsOn(sub: Sub, day: string): boolean {
  if (!sub.start || sub.start > day) return false;
  const [sy, sm, sd] = ymd(sub.start), [y, m, d] = ymd(day);
  if (sub.cycle === "weekly") return ((Date.UTC(y, m - 1, d) - Date.UTC(sy, sm - 1, sd)) / 864e5) % 7 === 0;
  const step = sub.cycle === "quarterly" ? 3 : sub.cycle === "yearly" ? 12 : 1;
  return ((y - sy) * 12 + (m - sm)) % step === 0 && d === Math.min(sd, new Date(Date.UTC(y, m, 0)).getUTCDate());
}
// Same as priceAt in public/index.html.
function priceOn(sub: Sub, day: string): number {
  const h = [...(sub.history ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1));
  let p = h.length ? h[0].amount : sub.amount;
  for (const e of h) if (e.from <= day) p = e.amount;
  return Number(p) || 0;
}
function fmtMoney(n: number, cur: string) {
  try { return new Intl.NumberFormat("en", { style: "currency", currency: cur, currencyDisplay: "narrowSymbol" }).format(n); }
  catch { return `${n} ${cur}`; }
}

async function ntfy(url: string, token: unknown, title: string, message: string) {
  const headers: Record<string, string> = { Title: title, Tags: "calendar" };
  if (typeof token === "string" && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { method: "POST", body: message, headers, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`ntfy answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

// Checks run one after another, so the timer and a Preferences save can't announce the same charge twice.
let reminderRun: Promise<void> = Promise.resolve();
const sendReminders = () => (reminderRun = reminderRun.then(checkReminders).catch((err) => console.warn("reminder check failed:", err)));

// Charges already announced are remembered per day, so a subscription added later in the day still gets its reminder.
async function checkReminders() {
  const { ntfyUrl, ntfyToken, ntfySent, tz, legacyCur } = state.settings;
  if (typeof ntfyUrl !== "string" || !ntfyUrl) return;
  const now = localNow(tz);
  if (now.hour < NOTIFY_HOUR) return;
  const day = nextDay(now.date);
  const sent = isObject(ntfySent) && ntfySent.day === day && Array.isArray(ntfySent.keys) ? (ntfySent.keys as string[]) : [];
  const due = (state.subs as Sub[]).filter(
    (s) => billsUntil(s, day) && billsOn(s, day) && !s.payments?.[day] && !sent.includes(`${s.id}@${day}`),
  );
  if (!due.length) return;
  const lines = due.map((s) => {
    const how = s.trial && s.start === day ? "free trial ends, first charge" : s.pay === "manual" ? "due, you pay this one yourself" : "charged automatically";
    return `${s.name}: ${fmtMoney(priceOn(s, day), s.cur ?? (typeof legacyCur === "string" ? legacyCur : "USD"))}, ${how}`;
  });
  try {
    await ntfy(ntfyUrl, ntfyToken, `${due.length} subscription ${due.length === 1 ? "charge" : "charges"} tomorrow`, lines.join("\n"));
    const keys = [...sent, ...due.map((s) => `${s.id}@${day}`)];
    await commit((s) => ({ ...s, settings: { ...s.settings, ntfySent: { day, keys } } }));
  } catch (err) {
    console.warn("ntfy reminder failed:", err);
  }
}

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  hostname: process.env.HOST,
  routes: {
    "/": () => new Response(Bun.file("public/index.html")),
    "/health": () => new Response("ok"),
    "/api/state": { GET: () => Response.json(state) },
    "/api/settings": {
      PUT: async (req) => {
        const body: unknown = await req.json().catch(() => null);
        if (!isObject(body)) return badRequest("expected an object");
        const { rates, rateLog: _ignored, ...rest } = body;
        await commit((s) => {
          const logged = isObject(rates) ? logRates(s, rates as Rates, "manual") : s;
          return { ...logged, settings: { ...logged.settings, ...rest } };
        });
        if (rest.autoRates === true) await refreshRates();
        if ("ntfyUrl" in rest) sendReminders();
        return Response.json(state);
      },
    },
    "/api/ntfy/test": {
      POST: async (req) => {
        // A JSON content type makes browsers preflight cross-site requests, which this server never allows,
        // so another website open in the browser can't use this route to make the server send requests.
        if (!req.headers.get("content-type")?.startsWith("application/json")) return badRequest("expected JSON");
        const body: unknown = await req.json().catch(() => null);
        if (!isObject(body) || typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) return badRequest("expected an http(s) topic URL");
        try {
          await ntfy(body.url, body.token, "Expendial test", "Reminders will arrive here the day before each subscription charge.");
          return new Response("ok");
        } catch (err) {
          return new Response(String(err), { status: 502 });
        }
      },
    },
    "/api/:coll/:id": {
      PUT: async (req) => {
        const { coll, id } = req.params;
        const body: unknown = await req.json().catch(() => null);
        if (!isColl(coll) || !isObject(body)) return badRequest("expected an object for expenses or subs");
        const row: Row = { ...body, id };
        return Response.json(
          await commit((s) => {
            const rows = s[coll].some((r) => r.id === id) ? s[coll].map((r) => (r.id === id ? row : r)) : [...s[coll], row];
            return { ...s, [coll]: rows };
          }),
        );
      },
      DELETE: async (req) => {
        const { coll, id } = req.params;
        if (!isColl(coll)) return badRequest("unknown collection");
        return Response.json(await commit((s) => ({ ...s, [coll]: s[coll].filter((r) => r.id !== id) })));
      },
    },
  },
  fetch: () => new Response("Not found", { status: 404 }),
});

refreshRates();
setInterval(refreshRates, 6 * 60 * 60 * 1000);
sendReminders();
setInterval(sendReminders, 15 * 60 * 1000);

console.log(`expendial listening on ${server.url}`);
