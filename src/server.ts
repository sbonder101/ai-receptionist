/**
 * server.ts — AI Receptionist (Twilio Voice) + KB + Booking + Google Sheets + Google Calendar
 *
 * Key upgrades:
 * - Robust gatherInput(): speech + dtmf, enhanced model, confidence gating
 * - Reprompt limits + DTMF menu fallback (prevents endless loops)
 * - Booking flow: service -> (speak price) -> datetime -> name -> confirm
 * - Calendar: checks freebusy to prevent double booking, creates event on confirm
 * - Pricing: speaks "twenty rand" instead of "R20"
 *
 * ENV (minimum):
 * - PUBLIC_BASE_URL=https://<your-render-app>.onrender.com
 * - TWILIO_VALIDATE_SIGNATURE=true|false
 * - TWILIO_AUTH_TOKEN=...
 * - GSHEETS_SPREADSHEET_ID=...
 * - GOOGLE_CLIENT_EMAIL=...
 * - GOOGLE_PRIVATE_KEY=... (with \n escaped)
 *
 * Calendar ENV:
 * - GOOGLE_CALENDAR_ID=primary OR a calendar id (recommended: dedicated calendar per tenant)
 * - (Optional) GOOGLE_CALENDAR_TIMEZONE=Africa/Johannesburg
 *
 * Notes:
 * - For service account calendars: share the calendar with the service-account email with "Make changes to events".
 */

import express from "express";
import type { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import pino from "pino";
import { v4 as uuidv4 } from "uuid";
import { twiml } from "twilio";
import { validateRequest } from "twilio/lib/webhooks/webhooks";
import fs from "fs";
import path from "path";
import { DateTime } from "luxon";

import { appendCallLog, appendBookingLog } from "./googleSheetsLogger";
import { isSlotAvailable, createBookingEvent, findNextAvailableSlot } from "./googleCalendar";

dotenv.config();

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** -------------------------
 *  ENV + CONSTANTS
 * ------------------------- */
const PORT = Number(process.env.PORT || 3000);

const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VALIDATE_SIGNATURE =
  (process.env.TWILIO_VALIDATE_SIGNATURE || "false") === "true";

const ALLOW_TEST_BYPASS = (process.env.ALLOW_TEST_BYPASS || "false") === "true";
const TEST_BYPASS_KEY = process.env.TEST_BYPASS_KEY || "";

const PUBLIC_BASE_URL = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL || process.env.BASE_URL || ""
);

type TtsVoice = "alice" | "Polly.Amy-Neural";
type TtsLang = "en-US" | "en-GB";
const TTS_VOICE: TtsVoice = pickVoice(process.env.TTS_VOICE);
const TTS_LANG: TtsLang = pickLang(process.env.TTS_LANG);

const DATA_DIR = path.join(process.cwd(), "data");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
const CALLS_LOG_FILE = path.join(DATA_DIR, "calls.csv");

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 0.45);
const MAX_TURNS = Number(process.env.MAX_TURNS ?? 8);
const MAX_REPROMPTS = Number(process.env.MAX_REPROMPTS ?? 2);

// Keep follow-up prompt minimal to avoid “random” feel.
const FOLLOWUP_PROMPT = process.env.FOLLOWUP_PROMPT || "Go ahead.";

/** -------------------------
 *  TYPES
 * ------------------------- */
type HoursSpec = { [day: string]: { open: string; close: string } | undefined };

type Tenant = {
  id: string;
  businessName: string;
  twilioNumber: string;
  timezone?: string; // e.g. Africa/Johannesburg
  hours?: HoursSpec;
  handoffNumber?: string;
  knowledgeBaseId: string;
  calendarId?: string; // per-tenant calendar override (recommended)
};

type KBService = {
  id: string;
  name: string;
  priceZar?: number;
  durationMin: number;
  keywords?: string[];
};

type KBBooking = {
  enabled?: boolean;
  slotSizeMin: number;
  bufferMin?: number;
  sameDayCutoffTime?: string; // "16:00"
  leadTimeMin?: number; // e.g. 30
  maxDaysAhead?: number; // e.g. 30
};

type KnowledgeBase = {
  businessName?: string;
  timezone?: string;
  address?: string;
  handoffNumber?: string;
  services?: KBService[];
  booking?: KBBooking;
  faqs?: Array<{ q: string; a: string; keywords?: string[] }>;
  policies?: Record<string, string>;
};

type TwilioVoiceBody = {
  CallSid?: string;
  From?: string;
  To?: string;
  Called?: string;
  SpeechResult?: string;
  Confidence?: string;
  Digits?: string;
};

type Intent = "HANDOFF" | "PRICING" | "HOURS" | "ADDRESS" | "BOOKING" | "POLICY" | "OTHER";

type BookingStage =
  | "idle"
  | "need_service"
  | "need_datetime"
  | "need_name"
  | "confirm"
  | "done";

type BookingState = {
  stage: BookingStage;
  reprompts: number;
  serviceId?: string;
  serviceName?: string;
  priceZar?: number;
  durationMin?: number;
  startIso?: string;  // ISO in UTC
  name?: string;
};

type CallSession = {
  callSid: string;
  tenantId: string;
  from: string;
  to: string;
  createdAt: number;
  turns: number;
  reprompts: number;
  booking: BookingState;
};

/** -------------------------
 *  MIDDLEWARE
 * ------------------------- */
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.urlencoded({ extended: false })); // Twilio form urlencoded

app.use((req: Request, res: Response, next: NextFunction) => {
  const existing = req.header("x-request-id");
  (req as any).requestId = existing || uuidv4();
  res.setHeader("x-request-id", (req as any).requestId);
  next();
});

app.use(
  pinoHttp({
    logger,
    customProps: (req) => ({ requestId: (req as any).requestId }),
  })
);

app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

/** -------------------------
 *  URL / SIGNATURE
 * ------------------------- */
function normalizeBaseUrl(u: string): string {
  const trimmed = (u || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("http://")) return "https://" + trimmed.slice("http://".length);
  if (!trimmed.startsWith("http")) return "https://" + trimmed;
  return trimmed;
}

function getPublicUrl(req: Request): string {
  const proto = (req.header("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (req.header("x-forwarded-host") || req.header("host") || "").split(",")[0].trim();
  return `${proto}://${host}${req.originalUrl}`;
}

function buildAbsoluteUrl(pathname: string, query?: Record<string, string | undefined>) {
  if (!PUBLIC_BASE_URL) return pathname;
  const url = new URL(PUBLIC_BASE_URL + (pathname.startsWith("/") ? pathname : `/${pathname}`));
  if (query) for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
  return url.toString();
}

function twilioSignatureOk(req: Request): boolean {
  if (ALLOW_TEST_BYPASS && TEST_BYPASS_KEY && req.header("x-test-bypass") === TEST_BYPASS_KEY) return true;
  if (!TWILIO_VALIDATE_SIGNATURE) return true;

  if (!TWILIO_AUTH_TOKEN) {
    req.log.error("TWILIO_VALIDATE_SIGNATURE=true but TWILIO_AUTH_TOKEN missing");
    return false;
  }

  const signature = req.header("x-twilio-signature") || "";
  const url = getPublicUrl(req);
  return validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
}

/** -------------------------
 *  VOICE SETTINGS
 * ------------------------- */
function pickLang(v?: string): TtsLang {
  return v === "en-US" ? "en-US" : "en-GB";
}
function pickVoice(v?: string): TtsVoice {
  return v === "Polly.Amy-Neural" ? "Polly.Amy-Neural" : "alice";
}

/** -------------------------
 *  TENANTS + KB
 * ------------------------- */
let tenantsCache: Tenant[] | null = null;
let tenantsMtimeMs = 0;

function loadTenants(): Tenant[] {
  const st = fs.statSync(TENANTS_FILE);
  if (!tenantsCache || st.mtimeMs !== tenantsMtimeMs) {
    const raw = fs.readFileSync(TENANTS_FILE, "utf-8");
    tenantsCache = JSON.parse(raw) as Tenant[];
    tenantsMtimeMs = st.mtimeMs;
    logger.info({ count: tenantsCache.length }, "Tenants loaded");
  }
  return tenantsCache!;
}

function normalizeE164(num?: string) {
  return (num || "").replace(/\s+/g, "");
}

function resolveTenantByTwilioNumber(to?: string): Tenant {
  const num = normalizeE164(to);
  const tenants = loadTenants();
  const tenant = tenants.find((t) => normalizeE164(t.twilioNumber) === num);
  if (tenant) return tenant;

  const fallback = tenants.find((t) => t.id === "demo-sbo-tech");
  if (!fallback) throw new Error("No fallback tenant demo-sbo-tech found in tenants.json");
  return fallback;
}

type KBCacheEntry = { kb: KnowledgeBase; mtimeMs: number };
const kbCache = new Map<string, KBCacheEntry>();

function kbPath(knowledgeBaseId: string) {
  return path.join(DATA_DIR, `${knowledgeBaseId}.json`);
}
function loadKnowledgeBase(knowledgeBaseId: string): KnowledgeBase {
  const file = kbPath(knowledgeBaseId);
  const st = fs.statSync(file);
  const cached = kbCache.get(knowledgeBaseId);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.kb;

  const raw = fs.readFileSync(file, "utf-8");
  const kb = JSON.parse(raw) as KnowledgeBase;
  kbCache.set(knowledgeBaseId, { kb, mtimeMs: st.mtimeMs });
  return kb;
}

/** -------------------------
 *  SESSIONS (in-memory)
 * ------------------------- */
const sessions = new Map<string, CallSession>();

function getSession(callSid: string, tenant: Tenant, from: string, to: string): CallSession {
  const existing = sessions.get(callSid);
  if (existing) return existing;

  const s: CallSession = {
    callSid,
    tenantId: tenant.id,
    from,
    to,
    createdAt: Date.now(),
    turns: 0,
    reprompts: 0,
    booking: { stage: "idle", reprompts: 0 },
  };
  sessions.set(callSid, s);
  return s;
}

/** -------------------------
 *  CSV LOG (optional)
 * ------------------------- */
function ensureCallsCsvHeader() {
  if (!fs.existsSync(CALLS_LOG_FILE)) {
    fs.mkdirSync(path.dirname(CALLS_LOG_FILE), { recursive: true });
    fs.writeFileSync(
      CALLS_LOG_FILE,
      "time,tenantId,callSid,from,to,intent,confidence,handoff,transcript\n",
      "utf-8"
    );
  }
}
function csvEscape(v: string) {
  const s = (v ?? "").toString();
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}
function logCallTurn(params: {
  tenantId: string;
  callSid: string;
  from: string;
  to: string;
  intent: string;
  confidence?: number;
  handoff: boolean;
  transcript: string;
}) {
  ensureCallsCsvHeader();
  const line =
    [
      new Date().toISOString(),
      params.tenantId,
      params.callSid,
      params.from,
      params.to,
      params.intent,
      params.confidence?.toString() ?? "",
      params.handoff ? "YES" : "NO",
      csvEscape(params.transcript),
    ].join(",") + "\n";
  fs.appendFileSync(CALLS_LOG_FILE, line, "utf-8");
}

/** -------------------------
 *  INTENTS + FAQ
 * ------------------------- */
function detectIntent(text: string): Intent {
  const t = (text || "").toLowerCase();

  if (/\b(owner|manager|human|agent|representative|operator)\b/.test(t)) return "HANDOFF";
  if (/speak to (the )?(owner|manager|someone)/.test(t)) return "HANDOFF";
  if (/\bcomplaint|angry|refund|escalate\b/.test(t)) return "HANDOFF";

  if (/\b(price|cost|how much|charge|rates|fee)\b/.test(t)) return "PRICING";
  if (/\b(open|close|hours|time|when|today|tomorrow|weekend)\b/.test(t)) return "HOURS";
  if (/\b(where|location|address|directions|near)\b/.test(t)) return "ADDRESS";
  if (/\b(book|booking|appointment|schedule|slot|available)\b/.test(t)) return "BOOKING";
  if (/\bpolicy|policies|cancellation|late|deposit|refund\b/.test(t)) return "POLICY";

  return "OTHER";
}

function tokenize(s: string) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function bestFaqAnswer(kb: KnowledgeBase, utterance: string): string | null {
  const faqs = kb.faqs || [];
  if (!faqs.length) return null;

  const uTokens = new Set(tokenize(utterance));
  if (!uTokens.size) return null;

  let bestScore = 0;
  let best: { a: string } | null = null;

  for (const f of faqs) {
    const qTokens = tokenize(f.q);
    if (!qTokens.length) continue;

    let hit = 0;
    for (const t of qTokens) if (uTokens.has(t)) hit++;

    const score = hit / qTokens.length;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }

  return best && bestScore >= 0.35 ? best.a : null;
}

/** -------------------------
 *  MONEY SPEECH: “twenty rand”
 * ------------------------- */
function numberToWords(n: number): string {
  // good enough for pricing up to 9999
  const ones = [
    "zero","one","two","three","four","five","six","seven","eight","nine",
    "ten","eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen",
  ];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];

  if (n < 20) return ones[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return o ? `${tens[t]} ${ones[o]}` : tens[t];
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return r ? `${ones[h]} hundred ${numberToWords(r)}` : `${ones[h]} hundred`;
  }
  if (n < 10000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    return r ? `${ones[th]} thousand ${numberToWords(r)}` : `${ones[th]} thousand`;
  }
  return String(n);
}

function moneyZarToSpeech(amount: number): string {
  const rounded = Math.round(amount * 100) / 100;
  const rands = Math.floor(rounded);
  const cents = Math.round((rounded - rands) * 100);

  const randPart = `${numberToWords(rands)} ${rands === 1 ? "rand" : "rand"}`;
  if (!cents) return randPart;
  return `${randPart} and ${numberToWords(cents)} cents`;
}

/** -------------------------
 *  PRICING RESPONSE (SSML)
 * ------------------------- */
function formatPricesSsml(services?: KBService[]) {
  const list = services || [];
  if (!list.length) {
    return `<speak>I don’t have the latest pricing yet. Would you like me to connect you to the owner?</speak>`;
  }

  const parts = list.map((s) => {
    const name = escapeForSsml(s.name || "Service");
    const dur = typeof s.durationMin === "number" ? `${s.durationMin} minutes` : "";
    const price =
      typeof s.priceZar === "number"
        ? moneyZarToSpeech(s.priceZar)
        : "price on request";
    return `${name}: ${escapeForSsml(price)}${dur ? `, ${dur}` : ""}`;
  });

  // SSML with pauses so it sounds natural
  return `<speak>${parts.join(". <break time='200ms'/> ")}.</speak>`;
}

/** -------------------------
 *  HOURS (simple tenant hours)
 * ------------------------- */
function isOpenNow(tenant: Tenant, now = new Date()): boolean | null {
  if (!tenant.hours) return null;

  const day = now.getDay().toString();
  const spec = tenant.hours[day];
  if (!spec) return false;

  const [oh, om] = spec.open.split(":").map(Number);
  const [ch, cm] = spec.close.split(":").map(Number);
  if ([oh, om, ch, cm].some((n) => Number.isNaN(n))) return null;

  const mins = now.getHours() * 60 + now.getMinutes();
  const openMins = oh * 60 + om;
  const closeMins = ch * 60 + cm;
  return mins >= openMins && mins <= closeMins;
}

/** -------------------------
 *  TWIML HELPERS
 * ------------------------- */
function toPlainString(x: unknown): string {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  try { return JSON.stringify(x); } catch { return String(x); }
}

function sayText(vr: twiml.VoiceResponse, text: unknown) {
  const clean = toPlainString(text).trim();
  if (!clean) return;
  vr.say({ voice: TTS_VOICE, language: TTS_LANG } as any, clean);
}

function saySsml(vr: twiml.VoiceResponse, ssml: string) {
  const clean = (ssml || "").trim();
  if (!clean) return;
  vr.say({ voice: TTS_VOICE, language: TTS_LANG } as any, clean);
}

function menuPromptSsml() {
  return `<speak>
    You can also use the keypad.
    <break time="150ms"/>
    Press 1 for bookings.
    <break time="100ms"/>
    Press 2 for prices.
    <break time="100ms"/>
    Press 3 for business hours.
    <break time="100ms"/>
    Press 4 for the address.
    <break time="100ms"/>
    Press 0 to speak to the owner.
  </speak>`;
}

function digitsToIntent(digits?: string): Intent | null {
  const d = (digits || "").trim();
  if (d === "1") return "BOOKING";
  if (d === "2") return "PRICING";
  if (d === "3") return "HOURS";
  if (d === "4") return "ADDRESS";
  if (d === "0") return "HANDOFF";
  return null;
}

/**
 * gatherInput: speech + dtmf, enhanced speech settings.
 * - If caller struggles, they can press a key.
 */
function gatherInput(
  vr: twiml.VoiceResponse,
  actionUrl: string,
  prompt: string,
  opts?: { bargeIn?: boolean; numDigits?: number }
) {
  const gather = vr.gather({
    input: ["speech", "dtmf"],
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
    language: TTS_LANG,
    bargeIn: opts?.bargeIn ?? true,
    numDigits: opts?.numDigits,
    enhanced: true,
    speechModel: "phone_call",
  } as any);

  // prompt can be SSML or plain text; keep it simple
  if (prompt.trim().startsWith("<speak>")) gather.say({ voice: TTS_VOICE, language: TTS_LANG } as any, prompt.trim());
  else gather.say({ voice: TTS_VOICE, language: TTS_LANG } as any, prompt.trim());
}

/**
 * End-of-turn helper:
 * - keeps the follow-up prompt minimal (not “Anything else…”)
 * - adds DTMF menu if repeated reprompts
 */
function endWithNextPrompt(res: Response, vr: twiml.VoiceResponse, tenantId: string, includeMenu = false) {
  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId });

  if (includeMenu) {
    gatherInput(vr, action, menuPromptSsml(), { numDigits: 1 });
  } else {
    gatherInput(vr, action, FOLLOWUP_PROMPT, { bargeIn: true });
  }

  saySsml(vr, `<speak>Sorry, I didn’t catch that. Goodbye.</speak>`);
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
}

/** -------------------------
 *  BOOKING PARSING
 * ------------------------- */
function normalizeText(s: string) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function findService(kb: KnowledgeBase, speech: string): KBService | null {
  const t = normalizeText(speech);
  const services = kb.services || [];
  for (const s of services) {
    const nameHit = s.name && t.includes(s.name.toLowerCase());
    const kwHit = Array.isArray(s.keywords) && s.keywords.some((k) => t.includes(k.toLowerCase()));
    if (nameHit || kwHit) return s;
  }
  return null;
}

function parseTimeTo24h(t: string): { hh: number; mm: number } | null {
  const m = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  if (!m) return null;

  let hh = Number(m[1]);
  let mm = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase().replace(/\./g, "");

  if (Number.isNaN(hh) || Number.isNaN(mm)) return null;
  if (mm < 0 || mm > 59) return null;

  if (ap === "am") { if (hh === 12) hh = 0; }
  else if (ap === "pm") { if (hh < 12) hh += 12; }

  if (hh < 0 || hh > 23) return null;
  return { hh, mm };
}

function nextWeekday(base: Date, targetDow: number) {
  const d = new Date(base);
  const diff = (targetDow + 7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

/**
 * Parse day+time into UTC ISO, using tenant/kb timezone (Luxon).
 */
function parseBookingDateTimeUtcIso(speech: string, tz: string): string | null {
  const t = normalizeText(speech);

  const now = DateTime.now().setZone(tz);

  const dowMap: Record<string, number> = {
    sunday: 7, sun: 7,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };

  let date = now;
  let hasDate = false;

  if (/\btoday\b/.test(t)) { date = now; hasDate = true; }
  else if (/\btomorrow\b/.test(t)) { date = now.plus({ days: 1 }); hasDate = true; }
  else {
    for (const [k, v] of Object.entries(dowMap)) {
      if (new RegExp(`\\b${k}\\b`).test(t)) {
        // next occurrence
        const curIsoWeekday = now.weekday; // 1..7
        let diff = (v - curIsoWeekday + 7) % 7;
        if (diff === 0) diff = 7;
        date = now.plus({ days: diff });
        hasDate = true;
        break;
      }
    }
  }

  const time = parseTimeTo24h(t);
  if (!hasDate || !time) return null;

  const dt = date.set({ hour: time.hh, minute: time.mm, second: 0, millisecond: 0 });
  return dt.toUTC().toISO() ?? null;
}

function humanizeIsoInTz(isoUtc: string, tz: string) {
  const d = DateTime.fromISO(isoUtc, { zone: "utc" }).setZone(tz);
  return d.toLocaleString(DateTime.DATETIME_FULL); // “Friday, 21 February 2026 at 09:00”
}

function isBookingEnabled(kb: KnowledgeBase): boolean {
  if (!kb.booking) return false;
  if (kb.booking.enabled === false) return false;
  return true;
}

function cleanNameFromSpeech(s: string): string {
  // Keep it simple and safe
  const t = (s || "").trim();
  if (!t) return "";
  // strip common filler
  return t.replace(/\b(my name is|this is|it is)\b/ig, "").trim();
}

/** -------------------------
 *  BOOKING FLOW
 * ------------------------- */
async function handleBookingTurn(args: {
  req: Request;
  res: Response;
  vr: twiml.VoiceResponse;
  tenant: Tenant;
  kb: KnowledgeBase;
  session: CallSession;
  speech: string;
  confidence?: number;
}) {
  const { req, res, vr, tenant, kb, session, speech } = args;

  if (!isBookingEnabled(kb)) {
    saySsml(vr, `<speak>Bookings are not available right now. Would you like prices, hours, or the address?</speak>`);
    return endWithNextPrompt(res, vr, tenant.id);
  }

  const tz = kb.timezone || tenant.timezone || process.env.GOOGLE_CALENDAR_TIMEZONE || "Africa/Johannesburg";
  const b = session.booking;

  // Start booking if idle/done
  if (b.stage === "idle" || b.stage === "done") {
    session.booking = { stage: "need_service", reprompts: 0 };
  }

  // Stage: need service
  if (session.booking.stage === "need_service") {
    const svc = findService(kb, speech);
    if (!svc) {
      b.reprompts++;
      const includeMenu = b.reprompts > MAX_REPROMPTS;
      saySsml(vr, `<speak>Sure. What would you like to book? For example: haircut, fade, or beard trim.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id, includeMenu);
    }

    b.serviceId = svc.id;
    b.serviceName = svc.name;
    b.priceZar = svc.priceZar;
    b.durationMin = svc.durationMin;
    b.stage = "need_datetime";
    b.reprompts = 0;

    // Speak price naturally
    const priceLine =
      typeof svc.priceZar === "number"
        ? `That will cost ${moneyZarToSpeech(svc.priceZar)}.`
        : `Price is on request.`;

    saySsml(
      vr,
      `<speak>
        Great. For a ${escapeForSsml(svc.name)}.
        <break time="150ms"/>
        ${escapeForSsml(priceLine)}
        <break time="200ms"/>
        What day and time would you like?
        <break time="150ms"/>
        For example, Friday at 9 a.m.
      </speak>`
    );
    return endWithNextPrompt(res, vr, tenant.id);
  }

  // Stage: need datetime
  if (session.booking.stage === "need_datetime") {
    const startIsoUtc = parseBookingDateTimeUtcIso(speech, tz);
    if (!startIsoUtc) {
      b.reprompts++;
      const includeMenu = b.reprompts > MAX_REPROMPTS;
      saySsml(vr, `<speak>Please say a day and time, like Friday at 9 a.m. or tomorrow at 2 p.m.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id, includeMenu);
    }

    b.startIso = startIsoUtc;
    b.stage = "need_name";
    b.reprompts = 0;

    saySsml(vr, `<speak>Perfect. What name should I put on the booking?</speak>`);
    return endWithNextPrompt(res, vr, tenant.id);
  }

  // Stage: need name
  if (session.booking.stage === "need_name") {
    const nm = cleanNameFromSpeech(speech);
    if (!nm || nm.length < 2) {
      b.reprompts++;
      const includeMenu = b.reprompts > MAX_REPROMPTS;
      saySsml(vr, `<speak>Sorry, I didn’t catch the name. Please say the name again.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id, includeMenu);
    }

    b.name = nm;
    b.stage = "confirm";
    b.reprompts = 0;

    const whenHuman = b.startIso ? humanizeIsoInTz(b.startIso, tz) : "";
    const priceHuman =
      typeof b.priceZar === "number" ? moneyZarToSpeech(b.priceZar) : "price on request";

    saySsml(
      vr,
      `<speak>
        Just to confirm:
        <break time="150ms"/>
        ${escapeForSsml(b.serviceName ?? "your service")},
        for ${escapeForSsml(b.name)},
        on ${escapeForSsml(whenHuman)}.
        <break time="150ms"/>
        Cost: ${escapeForSsml(priceHuman)}.
        <break time="200ms"/>
        Say <emphasis>yes</emphasis> to confirm, or <emphasis>no</emphasis> to change the time.
      </speak>`
    );
    return endWithNextPrompt(res, vr, tenant.id);
  }

  // Stage: confirm
  if (session.booking.stage === "confirm") {
    const t = normalizeText(speech);
    const yes = /\b(yes|yeah|yep|confirm|correct|okay|ok)\b/.test(t);
    const no = /\b(no|nope|cancel|not|change)\b/.test(t);

    if (no) {
      b.stage = "need_datetime";
      b.reprompts = 0;
      saySsml(vr, `<speak>No problem. What day and time would you prefer instead?</speak>`);
      return endWithNextPrompt(res, vr, tenant.id);
    }

    if (!yes) {
      b.reprompts++;
      const includeMenu = b.reprompts > MAX_REPROMPTS;
      saySsml(vr, `<speak>Please say yes to confirm, or no to change the time.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id, includeMenu);
    }

    // Confirmed → calendar availability + event creation
    const calendarId = tenant.calendarId || process.env.GOOGLE_CALENDAR_ID || "";
    if (!calendarId) {
      req.log.warn("GOOGLE_CALENDAR_ID missing; continuing without calendar");
    }

    const startIso = b.startIso!;
    const durationMin = b.durationMin ?? 30;
    const endIso = DateTime.fromISO(startIso, { zone: "utc" }).plus({ minutes: durationMin }).toISO()!;

    // 1) Check availability (prevents double booking)
    let available = true;
    try {
      if (calendarId) {
        available = await isSlotAvailable({
          calendarId,
          startIsoUtc: startIso,
          endIsoUtc: endIso,
          timeZone: tz,
        });
      }
    } catch (e) {
      req.log.error({ e }, "Calendar availability check failed (treating as available)");
      available = true; // fail-open; you can change to fail-closed if you prefer
    }

    if (!available) {
      // Suggest next available slot
      let suggestion: string | null = null;
      try {
        if (calendarId) {
          const next = await findNextAvailableSlot({
            calendarId,
            startIsoUtc: startIso,
            durationMin,
            timeZone: tz,
            lookAheadDays: 14,
            stepMin: kb.booking?.slotSizeMin ?? 30,
          });
          if (next) suggestion = humanizeIsoInTz(next, tz);
        }
      } catch (e) {
        req.log.error({ e }, "findNextAvailableSlot failed");
      }

      b.stage = "need_datetime";
      b.reprompts = 0;

      if (suggestion) {
        saySsml(
          vr,
          `<speak>
            Sorry, that time is no longer available.
            <break time="150ms"/>
            The next available time is ${escapeForSsml(suggestion)}.
            <break time="200ms"/>
            What day and time would you prefer?
          </speak>`
        );
      } else {
        saySsml(
          vr,
          `<speak>
            Sorry, that time is no longer available.
            <break time="150ms"/>
            What day and time would you prefer instead?
          </speak>`
        );
      }
      return endWithNextPrompt(res, vr, tenant.id);
    }

    // 2) Create calendar event
    try {
      if (calendarId) {
        await createBookingEvent({
          calendarId,
          tenantId: tenant.id,
          callSid: session.callSid,
          customerName: b.name || "",
          customerPhone: session.from,
          serviceName: b.serviceName || "",
          startIsoUtc: startIso,
          endIsoUtc: endIso,
          timeZone: tz,
          priceZar: b.priceZar,
        });
      }
    } catch (e) {
      req.log.error({ e }, "Calendar create event failed (continuing)");
    }

    // 3) Write booking row (Sheets)
    try {
      await appendBookingLog({
        timestamp: new Date().toISOString(),
        tenantId: tenant.id,
        callSid: session.callSid,
        name: b.name || "",
        phone: session.from,
        service: b.serviceName || "",
        startTime: startIso,
        durationMin,
        status: "confirmed",
        notes: `confirmed via voice${calendarId ? " + calendar" : ""}`,
      });
    } catch (e) {
      req.log.error({ e }, "appendBookingLog failed");
    }

    // 4) Call log row (Sheets)
    appendCallLog({
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      callSid: session.callSid,
      from: session.from,
      to: session.to,
      speech: `BOOKING_CONFIRMED name=${b.name} service=${b.serviceId} start=${startIso}`,
      confidence: undefined,
      outcome: "booking_confirmed",
    }).catch((e) => req.log.error({ e }, "appendCallLog failed"));

    b.stage = "done";

    const whenHuman = humanizeIsoInTz(startIso, tz);
    saySsml(
      vr,
      `<speak>
        Perfect, ${escapeForSsml(b.name || "you're")} booked.
        <break time="150ms"/>
        ${escapeForSsml(b.serviceName || "Your service")} on ${escapeForSsml(whenHuman)}.
        <break time="200ms"/>
        Goodbye.
      </speak>`
    );
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Safety fallback
  session.booking = { stage: "need_service", reprompts: 0 };
  saySsml(vr, `<speak>Sure. What would you like to book?</speak>`);
  return endWithNextPrompt(res, vr, tenant.id);
}

/** -------------------------
 *  HEALTH + ADMIN
 * ------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/admin/calls.csv", (_req, res) => {
  ensureCallsCsvHeader();
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="calls.csv"');
  fs.createReadStream(CALLS_LOG_FILE).pipe(res);
});

/** -------------------------
 *  ROUTES
 * ------------------------- */
app.post("/webhooks/twilio/inbound-call", (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  const to = req.body.To || req.body.Called || "unknown";

  const tenant = resolveTenantByTwilioNumber(to);
  getSession(callSid, tenant, from, to);

  const vr = new twiml.VoiceResponse();

  const open = isOpenNow(tenant);
  if (open === false) {
    saySsml(
      vr,
      `<speak>
        Hi! You’ve reached ${escapeForSsml(tenant.businessName)}.
        <break time="200ms"/>
        We’re currently closed.
        <break time="200ms"/>
        You can still tell me what you need.
      </speak>`
    );
  } else {
    saySsml(
      vr,
      `<speak>
        Hi there. You’ve reached ${escapeForSsml(tenant.businessName)}.
        <break time="150ms"/>
        How can I help you today?
      </speak>`
    );
  }

  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
  gatherInput(vr, action, FOLLOWUP_PROMPT, { bargeIn: true });

  saySsml(vr, `<speak>Sorry, I didn’t catch that. Goodbye.</speak>`);
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
});

app.post("/webhooks/twilio/handle-speech", async (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  const to = req.body.To || req.body.Called || "unknown";

  const tenant = resolveTenantByTwilioNumber(to);
  const session = getSession(callSid, tenant, from, to);

  session.turns++;

  const vr = new twiml.VoiceResponse();

  if (session.turns > MAX_TURNS) {
    saySsml(vr, `<speak>Thanks for calling. Goodbye.</speak>`);
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Load KB
  let kb: KnowledgeBase;
  try {
    kb = loadKnowledgeBase(tenant.knowledgeBaseId);
  } catch (e: any) {
    req.log.error({ err: e, tenantId: tenant.id }, "KB load failed");
    saySsml(vr, `<speak>Sorry, I’m having trouble accessing the business info right now.</speak>`);
    const dialTo = tenant.handoffNumber;
    if (dialTo?.startsWith("+")) {
      saySsml(vr, `<speak>Let me connect you to someone who can help.</speak>`);
      vr.dial(dialTo);
      return res.type("text/xml").send(vr.toString());
    }
    saySsml(vr, `<speak>Please try again later. Goodbye.</speak>`);
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  const digits = (req.body.Digits || "").trim();
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;

  const digitIntent = digitsToIntent(digits);

  // If mid-booking: continue booking (DTMF doesn't carry booking info)
  if (session.booking.stage !== "idle" && session.booking.stage !== "done") {
    if (!speech) {
      session.booking.reprompts++;
      const includeMenu = session.booking.reprompts > MAX_REPROMPTS;
      saySsml(vr, `<speak>Sorry, I didn’t catch that. Please say it again.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id, includeMenu);
    }
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  // No input
  if (!speech && !digitIntent) {
    session.reprompts++;
    const includeMenu = session.reprompts > MAX_REPROMPTS;
    saySsml(vr, `<speak>Sorry, I didn’t catch that. Please say it again, or use the keypad.</speak>`);
    return endWithNextPrompt(res, vr, tenant.id, includeMenu);
  }

  // Low confidence speech → reprompt + menu
  if (speech && typeof confidence === "number" && confidence < MIN_CONFIDENCE) {
    session.reprompts++;
    const includeMenu = session.reprompts > MAX_REPROMPTS;
    req.log.info({ confidence, speech }, "Low confidence speech");
    saySsml(vr, `<speak>Sorry, I’m not sure I heard you correctly. Please say that again, or use the keypad.</speak>`);
    return endWithNextPrompt(res, vr, tenant.id, includeMenu);
  }

  const intent: Intent = digitIntent ?? detectIntent(speech);

  // Start booking
  if (intent === "BOOKING") {
    session.booking = { stage: "need_service", reprompts: 0 };
    // If they said “book haircut tomorrow 2pm”, we can try to extract service quickly
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  // Handoff
  if (intent === "HANDOFF") {
    const dialTo = tenant.handoffNumber || kb.handoffNumber;
    if (dialTo?.startsWith("+")) {
      saySsml(vr, `<speak>Okay. Connecting you now.</speak>`);
      vr.dial(dialTo);
      return res.type("text/xml").send(vr.toString());
    }
    saySsml(vr, `<speak>I can’t transfer right now. Please leave your number and we’ll call you back. Goodbye.</speak>`);
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Non-booking answers
  let answered = false;

  if (intent === "PRICING") {
    saySsml(vr, formatPricesSsml(kb.services));
    answered = true;
  } else if (intent === "HOURS") {
    // Improve later: format from KB hours if you store it
    saySsml(vr, `<speak>We are open Monday to Friday, nine to six. Saturday, nine to three. Closed Sundays.</speak>`);
    answered = true;
  } else if (intent === "ADDRESS") {
    const addr = kb.address ? escapeForSsml(kb.address) : "I can share the address once it’s provided.";
    saySsml(vr, `<speak>${addr}</speak>`);
    answered = true;
  } else if (intent === "POLICY") {
    const policy = kb.policies ? Object.values(kb.policies)[0] : null;
    const ans = policy || bestFaqAnswer(kb, speech);
    if (ans) {
      saySsml(vr, `<speak>${escapeForSsml(ans)}</speak>`);
      answered = true;
    }
  } else {
    const ans = bestFaqAnswer(kb, speech);
    if (ans) {
      saySsml(vr, `<speak>${escapeForSsml(ans)}</speak>`);
      answered = true;
    }
  }

  if (!answered) {
    saySsml(vr, `<speak>I can help with bookings, prices, hours, and location. What would you like?</speak>`);
  }

  // Logs
  const handoffRegexHit = /\b(owner|manager|human|agent|representative|operator)\b/i.test(speech);
  logCallTurn({
    tenantId: tenant.id,
    callSid,
    from,
    to,
    intent,
    confidence,
    handoff: handoffRegexHit,
    transcript: speech || `DTMF:${digits}`,
  });

  appendCallLog({
    timestamp: new Date().toISOString(),
    tenantId: tenant.id,
    callSid,
    from: session.from,
    to: session.to,
    speech: speech || `DTMF:${digits}`,
    confidence,
    outcome: answered ? "answered" : "fallback",
  }).catch((e) => req.log.error({ e }, "Failed to append call log to Google Sheets"));

  return endWithNextPrompt(res, vr, tenant.id, session.reprompts > MAX_REPROMPTS);
});

/** -------------------------
 *  ERROR HANDLER
 * ------------------------- */
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "Unhandled error");
  res.status(500).json({
    error: "Internal server error",
    requestId: (req as any).requestId,
  });
});

app.listen(PORT, () => {
  logger.info(`AI receptionist webhook running on http://localhost:${PORT}`);
});

/** -------------------------
 *  SSML escaping
 * ------------------------- */
function escapeForSsml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
