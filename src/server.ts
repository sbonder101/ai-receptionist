/**
 * server.ts — AI Receptionist (Twilio Voice) + KB + Booking + Google Sheets + Google Calendar
 *
 * Fixes included:
 * - gatherInput (speech + dtmf) with enhanced phone_call model + hints
 * - Confidence-aware reprompts (don't progress state on low confidence)
 * - Price spoken as words ("twenty rand") instead of "R20"
 * - Booking flow stages: need_service -> need_name -> need_datetime -> confirm
 * - Calendar availability check + next available suggestion if busy
 * - End call after confirmed booking (no random "anything else")
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
 *  ENV
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

const DEFAULT_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || ""; // can also be per-tenant

type TtsVoice = "alice" | "Polly.Amy-Neural";
type TtsLang = "en-US" | "en-GB";
const TTS_VOICE: TtsVoice = pickVoice(process.env.TTS_VOICE);
const TTS_LANG: TtsLang = pickLang(process.env.TTS_LANG);

// Speech tuning
const MIN_CONFIDENCE = Number(process.env.MIN_SPEECH_CONFIDENCE || 0.55);
const MAX_TURNS = Number(process.env.MAX_CALL_TURNS || 8);

/** -------------------------
 *  DATA PATHS
 * ------------------------- */
const DATA_DIR = path.join(process.cwd(), "data");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
const CALLS_LOG_FILE = path.join(DATA_DIR, "calls.csv");

/** -------------------------
 *  TYPES
 * ------------------------- */
type HoursSpec = {
  // 0=Sun..6=Sat
  [day: string]: { open: string; close: string } | undefined;
};

type Tenant = {
  id: string;
  businessName: string;
  twilioNumber: string; // +27...
  timezone?: string; // "Africa/Johannesburg"
  hours?: HoursSpec;
  handoffNumber?: string;
  knowledgeBaseId: string;

  // Calendar: prefer per-tenant, fallback to env GOOGLE_CALENDAR_ID
  calendarId?: string;
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
  leadTimeMin?: number;
  maxDaysAhead?: number;
  slotStepMin?: number; // step size to find next availability (e.g. 15)
  lookAheadDays?: number; // e.g. 14
};

type KnowledgeBase = {
  businessName?: string;
  timezone?: string; // "Africa/Johannesburg"
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
  CallStatus?: string;
};

type Intent = "HANDOFF" | "PRICING" | "HOURS" | "ADDRESS" | "BOOKING" | "POLICY" | "OTHER";

type BookingStage =
  | "idle"
  | "need_service"
  | "need_name"
  | "need_datetime"
  | "confirm"
  | "suggest_alt"
  | "done";

type BookingState = {
  stage: BookingStage;
  serviceId?: string;
  serviceName?: string;
  priceZar?: number;
  durationMin?: number;

  customerName?: string;
  startIsoUtc?: string; // UTC ISO
  endIsoUtc?: string;   // UTC ISO

  // if chosen time is busy
  suggestedStartIsoUtc?: string;
  suggestedEndIsoUtc?: string;

  // reprompt guard
  lastPromptKey?: string;
  lowConfidenceCount?: number;
};

type CallSession = {
  callSid: string;
  tenantId: string;
  from: string;
  to: string;
  createdAt: number;
  turns: number;
  booking: BookingState;
};

function pickLang(v?: string): TtsLang {
  return v === "en-US" ? "en-US" : "en-GB";
}
function pickVoice(v?: string): TtsVoice {
  return v === "Polly.Amy-Neural" ? "Polly.Amy-Neural" : "alice";
}

/** -------------------------
 *  MIDDLEWARE
 * ------------------------- */
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.urlencoded({ extended: false }));

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
  if (ALLOW_TEST_BYPASS && TEST_BYPASS_KEY && req.header("x-test-bypass") === TEST_BYPASS_KEY) {
    return true;
  }
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
    booking: { stage: "idle", lowConfidenceCount: 0 },
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

function sayWithPauses(
  vr: any,
  opts: { voice?: string; language?: string },
  parts: Array<string | { breakMs: number } | { emphasis: string }>
) {
  const say = vr.say(opts);
  for (const p of parts) {
    if (typeof p === "string") {
      if (p.trim()) say.addText(p);
    } else if ("breakMs" in p) {
      say.break({ time: `${p.breakMs}ms` });
    } else if ("emphasis" in p) {
      say.emphasis({ level: "moderate" }, p.emphasis);
    }
  }
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
 *  HOURS (tenant simple)
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
  try {
    return JSON.stringify(x);
  } catch {
    return String(x);
  }
}

function sayText(vr: twiml.VoiceResponse, text: unknown) {
  const clean = toPlainString(text).trim();
  if (!clean) return;
  vr.say({ voice: TTS_VOICE, language: TTS_LANG } as any, clean);
}

function saySsml(vr: twiml.VoiceResponse, ssml: string) {
  const clean = (ssml || "").trim();
  if (!clean) return;
  // Provide <speak>...</speak> as body (NO ssml attr)
  vr.say({ voice: TTS_VOICE, language: TTS_LANG } as any, clean);
}

function gatherInput(
  vr: twiml.VoiceResponse,
  actionUrl: string,
  promptText: string,
  opts?: { bargeIn?: boolean; hints?: string[] }
) {
  const gather = vr.gather({
    input: ["speech", "dtmf"],
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
    language: TTS_LANG,
    bargeIn: opts?.bargeIn ?? true,

    // Speech quality improvements:
    enhanced: true,
    speechModel: "phone_call",

    // Helps recognizer lock onto domain terms (Twilio supports "hints")
    hints: opts?.hints?.slice(0, 20),
  } as any);

  gather.say({ voice: TTS_VOICE, language: TTS_LANG } as any, promptText.trim());
}

function hangup(res: Response, vr: twiml.VoiceResponse) {
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
}

/** -------------------------
 *  PRICE TO WORDS (ZAR)
 * ------------------------- */
const ONES = [
  "zero","one","two","three","four","five","six","seven","eight","nine","ten",
  "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

function intToWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = Math.floor(n / 10);
    const r = n % 10;
    return r ? `${TENS[t]} ${ONES[r]}` : TENS[t];
  }
  if (n < 1000) {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return r ? `${ONES[h]} hundred ${intToWords(r)}` : `${ONES[h]} hundred`;
  }
  if (n < 1_000_000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    return r ? `${intToWords(th)} thousand ${intToWords(r)}` : `${intToWords(th)} thousand`;
  }
  return String(n);
}

function zarToWords(amount: number): string {
  const rands = Math.floor(amount);
  const cents = Math.round((amount - rands) * 100);
  const randWords = `${intToWords(rands)} rand${rands === 1 ? "" : ""}`; // SA usage often "rand" for plural too
  if (!cents) return randWords;
  return `${randWords} and ${intToWords(cents)} cent${cents === 1 ? "" : "s"}`;
}

/** -------------------------
 *  SERVICES / BOOKING PARSING
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

  if (ap === "am") {
    if (hh === 12) hh = 0;
  } else if (ap === "pm") {
    if (hh < 12) hh += 12;
  }
  if (hh < 0 || hh > 23) return null;

  return { hh, mm };
}

function nextWeekday(base: DateTime, targetDow: number) {
  // Luxon weekday: Monday=1..Sunday=7; JS dow in your earlier code was 0..6.
  // We'll use Luxon weekday for correctness.
  const baseDow = base.weekday; // 1..7
  const diff = (targetDow - baseDow + 7) % 7 || 7;
  return base.plus({ days: diff });
}

function parseBookingDateTimeToUtcIso(speech: string, timeZone: string): { startIsoUtc: string } | null {
  const t = normalizeText(speech);

  const nowLocal = DateTime.now().setZone(timeZone);
  let dateLocal: DateTime | null = null;

  // Luxon weekday mapping: mon=1..sun=7
  const dowMap: Record<string, number> = {
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
    sunday: 7, sun: 7,
  };

  if (/\btoday\b/.test(t)) {
    dateLocal = nowLocal;
  } else if (/\btomorrow\b/.test(t)) {
    dateLocal = nowLocal.plus({ days: 1 });
  } else {
    for (const [k, v] of Object.entries(dowMap)) {
      if (new RegExp(`\\b${k}\\b`).test(t)) {
        dateLocal = nextWeekday(nowLocal, v);
        break;
      }
    }
  }

  const time = parseTimeTo24h(t);
  if (!dateLocal || !time) return null;

  const dtLocal = dateLocal.set({ hour: time.hh, minute: time.mm, second: 0, millisecond: 0 });
  const dtUtc = dtLocal.toUTC();

  return { startIsoUtc: dtUtc.toISO()! };
}

function humanizeUtcIsoToLocal(isoUtc: string, timeZone: string) {
  return DateTime.fromISO(isoUtc, { zone: "utc" })
    .setZone(timeZone)
    .toLocaleString(DateTime.DATETIME_FULL);
}

function isBookingEnabled(kb: KnowledgeBase): boolean {
  if (!kb.booking) return false;
  if (kb.booking.enabled === false) return false;
  return true;
}

function shouldRepromptForConfidence(confidence?: number, speech?: string) {
  const txt = (speech || "").trim();
  if (!txt) return true;
  if (confidence === undefined) return false; // some Twilio configs omit it
  return confidence < MIN_CONFIDENCE;
}

/** -------------------------
 *  FORMAT PRICES (speech-friendly)
 * ------------------------- */
function formatPricesSpeechFriendly(services?: KnowledgeBase["services"]) {
  const list = services || [];
  if (!list.length) return "I don’t have the latest pricing yet. Would you like me to connect you to the owner?";

  return list
    .map((s) => {
      const name = s.name || "Service";
      const dur = typeof s.durationMin === "number" ? `, about ${s.durationMin} minutes` : "";
      if (typeof s.priceZar === "number") {
        return `${name}: ${zarToWords(s.priceZar)}${dur}`;
      }
      return `${name}: price on request${dur}`;
    })
    .join(". ");
}

/** -------------------------
 *  BOOKING TURN HANDLER
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
  const { req, res, vr, tenant, kb, session, speech, confidence } = args;
  const b = session.booking;

  const timeZone = kb.timezone || tenant.timezone || "Africa/Johannesburg";
  const calendarId = tenant.calendarId || DEFAULT_CALENDAR_ID;

  const serviceHints = (kb.services || []).flatMap((s) => [s.name, ...(s.keywords || [])]).filter(Boolean);

  // Confidence guard: do not progress state, reprompt nicely.
  if (shouldRepromptForConfidence(confidence, speech)) {
    b.lowConfidenceCount = (b.lowConfidenceCount || 0) + 1;

    if (b.lowConfidenceCount >= 2) {
      saySsml(
        vr,
        `<speak>
          Sorry, the line is not very clear.
          <break time="150ms"/>
          Please say it slowly, or you can press keys.
        </speak>`
      );
    } else {
      sayText(vr, "Sorry, I didn’t catch that. Please repeat.");
    }

    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: serviceHints });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  // reset low confidence count on good input
  b.lowConfidenceCount = 0;

  if (!isBookingEnabled(kb)) {
    sayText(vr, "Bookings are not available right now. Would you like the address or business hours?");
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Go ahead.", { bargeIn: true });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  // Stage machine
  if (b.stage === "need_service") {
    const svc = findService(kb, speech);
    if (!svc) {
      saySsml(
        vr,
        `<speak>
          Sure. What would you like to book?
          <break time="150ms"/>
          For example: haircut, fade, or beard trim.
        </speak>`
      );

      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: serviceHints });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    b.serviceId = svc.id;
    b.serviceName = svc.name;
    b.priceZar = svc.priceZar;
    b.durationMin = svc.durationMin;

    // Immediately speak price properly (key ask from you)
    const priceLine =
      typeof svc.priceZar === "number" ? `That will cost ${zarToWords(svc.priceZar)}.` : "Price is on request.";

    b.stage = "need_name";

    saySsml(
      vr,
      `<speak>
        Great. ${escapeForSsml(priceLine)}
        <break time="150ms"/>
        Who is the booking for? Please say your name.
      </speak>`
    );

    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Say your name.", { bargeIn: true });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  if (b.stage === "need_name") {
    const name = speech.trim().replace(/[^\p{L}\p{N}\s'\-]/gu, "").slice(0, 60);
    if (!name || name.length < 2) {
      sayText(vr, "Sorry, please say the name again.");
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    b.customerName = name;
    b.stage = "need_datetime";

    saySsml(
      vr,
      `<speak>
        Thanks, ${escapeForSsml(name)}.
        <break time="150ms"/>
        What day and time would you like?
        <break time="150ms"/>
        For example: Friday at 9 a.m.
      </speak>`
    );

    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Go ahead.", { bargeIn: true });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  if (b.stage === "need_datetime") {
    const parsed = parseBookingDateTimeToUtcIso(speech, timeZone);
    if (!parsed) {
      saySsml(
        vr,
        `<speak>
          Please say a day and time,
          like Friday at 9 a.m. or tomorrow at 2 p.m.
        </speak>`
      );
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    const durationMin = b.durationMin ?? 30;
    const startUtc = DateTime.fromISO(parsed.startIsoUtc, { zone: "utc" });
    const endUtc = startUtc.plus({ minutes: durationMin });

    b.startIsoUtc = startUtc.toISO()!;
    b.endIsoUtc = endUtc.toISO()!;

    // Calendar check (if configured)
    if (calendarId) {
      try {
        const ok = await isSlotAvailable({
          calendarId,
          startIsoUtc: b.startIsoUtc,
          endIsoUtc: b.endIsoUtc,
          timeZone,
        });

        if (!ok) {
          // find next available
          const stepMin = kb.booking?.slotStepMin ?? 15;
          const lookAheadDays = kb.booking?.lookAheadDays ?? 14;

          const nextIso = await findNextAvailableSlot({
            calendarId,
            startIsoUtc: b.startIsoUtc,
            durationMin,
            timeZone,
            lookAheadDays,
            stepMin,
          });

          if (nextIso) {
            const nextStart = DateTime.fromISO(nextIso, { zone: "utc" });
            const nextEnd = nextStart.plus({ minutes: durationMin });

            b.suggestedStartIsoUtc = nextStart.toISO()!;
            b.suggestedEndIsoUtc = nextEnd.toISO()!;
            b.stage = "suggest_alt";

            saySsml(
              vr,
              `<speak>
                That time is not available.
                <break time="150ms"/>
                The next available slot is
                ${escapeForSsml(humanizeUtcIsoToLocal(b.suggestedStartIsoUtc, timeZone))}.
                <break time="200ms"/>
                Would you like to take that? Say yes or no.
              </speak>`
            );

            const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
            gatherInput(vr, action, "Go ahead.", { bargeIn: true });
            sayText(vr, "Goodbye.");
            return hangup(res, vr);
          }

          sayText(vr, "That time is not available, and I could not find another slot soon.");
          sayText(vr, "Please suggest another day and time.");
          const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
          gatherInput(vr, action, "Go ahead.", { bargeIn: true });
          sayText(vr, "Goodbye.");
          return hangup(res, vr);
        }
      } catch (e) {
        req.log.error({ e }, "Calendar availability check failed (continuing without blocking)");
        // continue; don't block bookings if calendar has issues
      }
    }

    b.stage = "confirm";

    const whenLocal = humanizeUtcIsoToLocal(b.startIsoUtc, timeZone);
    const priceLine =
      typeof b.priceZar === "number" ? `Cost: ${zarToWords(b.priceZar)}.` : "";

    // IMPORTANT: Only escape interpolated values, not SSML tags.
    // saySsml(
    //   vr,
    //   `<speak>
    //     Just to confirm:
    //     <break time="150ms"/>
    //     ${escapeForSsml(b.serviceName || "the service")},
    //     for ${escapeForSsml(b.customerName || "")},
    //     on ${escapeForSsml(whenLocal)}.
    //     <break time="150ms"/>
    //     ${escapeForSsml(priceLine)}
    //     <break time="200ms"/>
    //     Say <emphasis>yes</emphasis> to confirm, or <emphasis>no</emphasis> to change the time.
    //   </speak>`
    // );

    sayWithPauses(vr, {}, [
      "Just to confirm.",
      { breakMs: 150 },
      `${b.serviceName},`,
      { breakMs: 150 },
      `for ${b.customerName},`,
      { breakMs: 150 },
      `on ${whenLocal} .`,
      { breakMs: 150 },
      `will cost: ${priceLine}.`,
      { breakMs: 200 },
      "Say ",
      { emphasis: "yes" },
      " to confirm, or ",
      { emphasis: "no" },
      " to change the time."
    ]); 

    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: ["yes", "no", "confirm", "change"] });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  if (b.stage === "suggest_alt") {
    const t = normalizeText(speech);
    const yes = /\b(yes|yeah|yep|confirm|correct|okay|ok)\b/.test(t);
    const no = /\b(no|nope|cancel|not|change)\b/.test(t);

    if (no) {
      b.stage = "need_datetime";
      sayText(vr, "No problem. Please tell me another day and time.");
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    if (!yes || !b.suggestedStartIsoUtc || !b.suggestedEndIsoUtc) {
      sayText(vr, "Please say yes to accept the next available slot, or no to choose a different time.");
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    // Accept suggestion -> move into confirm using suggested
    b.startIsoUtc = b.suggestedStartIsoUtc;
    b.endIsoUtc = b.suggestedEndIsoUtc;
    b.suggestedStartIsoUtc = undefined;
    b.suggestedEndIsoUtc = undefined;
    b.stage = "confirm";

    const whenLocal = humanizeUtcIsoToLocal(b.startIsoUtc, timeZone);
    saySsml(
      vr,
      `<speak>
        Great.
        <break time="150ms"/>
        Confirm ${escapeForSsml(b.serviceName || "the service")} on ${escapeForSsml(whenLocal)}?
        Say yes to confirm or no to change.
      </speak>`
    );

    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: ["yes", "no"] });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  if (b.stage === "confirm") {
    const t = normalizeText(speech);
    const yes = /\b(yes|yeah|yep|confirm|correct|okay|ok)\b/.test(t);
    const no = /\b(no|nope|cancel|not|change)\b/.test(t);

    if (no) {
      b.stage = "need_datetime";
      sayText(vr, "No problem. What day and time would you prefer instead?");
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    if (!yes) {
      sayText(vr, "Please say yes to confirm, or no to change the time.");
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: ["yes", "no"] });
      sayText(vr, "Goodbye.");
      return hangup(res, vr);
    }

    // Confirmed: write Sheets + Calendar
    b.stage = "done";

    const durationMin = b.durationMin ?? 30;

    // 1) Booking sheet
    try {
      await appendBookingLog({
        timestamp: new Date().toISOString(),
        tenantId: tenant.id,
        callSid: session.callSid,
        name: b.customerName || "",
        phone: session.from,
        service: b.serviceName || "",
        startTime: b.startIsoUtc || "",
        durationMin,
        status: "confirmed",
        notes: "confirmed via voice",
      });
    } catch (e) {
      req.log.error({ e }, "appendBookingLog failed");
    }

    // 2) Calendar event (only if configured)
    if (calendarId && b.startIsoUtc && b.endIsoUtc) {
      try {
        await createBookingEvent({
          calendarId,
          tenantId: tenant.id,
          callSid: session.callSid,
          customerName: b.customerName || "",
          customerPhone: session.from,
          serviceName: b.serviceName || "Booking",
          startIsoUtc: b.startIsoUtc,
          endIsoUtc: b.endIsoUtc,
          timeZone,
          priceZar: b.priceZar,
        });
      } catch (e) {
        req.log.error({ e }, "createBookingEvent failed");
        // don’t fail the caller experience if calendar fails
      }
    }

    // 3) Call log outcome
    appendCallLog({
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      callSid: session.callSid,
      from: session.from,
      to: session.to,
      speech: `BOOKING_CONFIRMED service=${b.serviceId} start=${b.startIsoUtc}`,
      confidence,
      outcome: "booking_confirmed",
    }).catch((e) => req.log.error({ e }, "appendCallLog failed"));

    // 4) Speak confirmation and END
    const whenLocal = b.startIsoUtc ? humanizeUtcIsoToLocal(b.startIsoUtc, timeZone) : "that time";
    saySsml(
      vr,
      `<speak>
        Perfect. You’re booked.
        <break time="150ms"/>
        ${escapeForSsml(b.serviceName || "Your booking")} for ${escapeForSsml(b.customerName || "")}
        on ${escapeForSsml(whenLocal)}.
        <break time="200ms"/>
        Goodbye.
      </speak>`
    );

    return hangup(res, vr);
  }

  // Fallback: reset
  session.booking = { stage: "need_service", lowConfidenceCount: 0 };
  sayText(vr, "Sure. What would you like to book?");
  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
  gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: serviceHints });
  sayText(vr, "Goodbye.");
  return hangup(res, vr);
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
  req.log.info(
    {
      computedUrl: getPublicUrl(req),
      host: req.header("host"),
      xfHost: req.header("x-forwarded-host"),
      xfProto: req.header("x-forwarded-proto"),
      hasSig: !!req.header("x-twilio-signature"),
    },
    "twilio inbound"
  );

  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  const to = req.body.To || req.body.Called || "unknown";

  const tenant = resolveTenantByTwilioNumber(to);
  const session = getSession(callSid, tenant, from, to);

  const vr = new twiml.VoiceResponse();

  const open = isOpenNow(tenant);
  if (open === false) {
    saySsml(
      vr,
      `<speak>
        Hi! You’ve reached ${escapeForSsml(tenant.businessName)}.
        <break time="250ms"/>
        We’re currently closed.
        <break time="250ms"/>
        Please tell me what you need, and I’ll take a message for the team.
      </speak>`
    );
  } else {
    saySsml(
      vr,
      `<speak>
        Hi there.
        <break time="250ms"/>
        You’ve reached ${escapeForSsml(tenant.businessName)}.
        <break time="250ms"/>
        I’m your virtual receptionist.
        <break time="200ms"/>
        How can I help you today?
      </speak>`
    );
  }

  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
  gatherInput(vr, action, "Go ahead.", { bargeIn: true });

  sayText(vr, "Sorry, I didn’t catch that. Goodbye.");
  return hangup(res, vr);
});

app.post("/webhooks/twilio/handle-speech", async (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  const to = req.body.To || req.body.Called || "unknown";

  const tenant = resolveTenantByTwilioNumber(to);
  const session = getSession(callSid, tenant, from, to);

  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;

  session.turns++;

  const vr = new twiml.VoiceResponse();

  if (session.turns > MAX_TURNS) {
    sayText(vr, "Thanks for calling. Goodbye.");
    return hangup(res, vr);
  }

  if (!speech) {
    sayText(vr, "I didn’t hear anything. Please repeat.");
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Go ahead.", { bargeIn: true });
    sayText(vr, "Goodbye.");
    return hangup(res, vr);
  }

  let kb: KnowledgeBase;
  try {
    kb = loadKnowledgeBase(tenant.knowledgeBaseId);
  } catch (e: any) {
    req.log.error({ err: e, tenantId: tenant.id }, "KB load failed");
    sayText(vr, "Sorry, I’m having trouble accessing the business info right now.");

    const dialTo = tenant.handoffNumber;
    if (dialTo?.startsWith("+")) {
      sayText(vr, "Let me connect you to someone who can help.");
      vr.dial(dialTo);
      return res.type("text/xml").send(vr.toString());
    }

    sayText(vr, "Please try again later. Goodbye.");
    return hangup(res, vr);
  }

  // Sticky booking: if mid-booking keep it regardless of intent
  if (session.booking.stage !== "idle" && session.booking.stage !== "done") {
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  const intent = detectIntent(speech);

  // Start booking
  if (intent === "BOOKING") {
    session.booking = { stage: "need_service", lowConfidenceCount: 0 };
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  const handoffRegex =
    /\b(owner|manager|human|agent|representative|operator)\b|speak to (the )?(owner|manager|someone)/i;
  const handoffRegexHit = handoffRegex.test(speech);

  logCallTurn({
    tenantId: tenant.id,
    callSid,
    from,
    to,
    intent,
    confidence,
    handoff: handoffRegexHit,
    transcript: speech,
  });

  // Handoff
  if (intent === "HANDOFF") {
    saySsml(
      vr,
      `<speak>
        Okay.
        <break time="150ms"/>
        Let me connect you to the owner.
      </speak>`
    );

    const dialTo = tenant.handoffNumber || kb.handoffNumber;
    if (!dialTo || !dialTo.startsWith("+")) {
      sayText(vr, "I can’t transfer right now. Please leave your number and we’ll call you back. Goodbye.");
      return hangup(res, vr);
    }

    vr.dial(dialTo);
    return res.type("text/xml").send(vr.toString());
  }

  // Answer
  let answer: string | null = null;
  if (intent === "PRICING") answer = formatPricesSpeechFriendly(kb.services);
  else if (intent === "HOURS") answer = "Please ask the business to provide hours in the knowledge base."; // keep honest
  else if (intent === "ADDRESS") answer = kb.address || "I can share the address once it’s provided.";
  else if (intent === "POLICY") {
    const policy = kb.policies ? Object.values(kb.policies)[0] : null;
    answer = policy || bestFaqAnswer(kb, speech);
  } else {
    answer = bestFaqAnswer(kb, speech);
  }

  if (answer) {
    sayText(vr, answer);
  } else {
    saySsml(
      vr,
      `<speak>
        I can help with prices, business hours, location, and bookings.
        <break time="200ms"/>
        What would you like to know?
      </speak>`
    );
  }

  // Google Sheet call log
  const outcome = handoffRegexHit ? "handoff" : answer ? "answered" : "fallback";
  appendCallLog({
    timestamp: new Date().toISOString(),
    tenantId: tenant.id,
    callSid,
    from: req.body.From || "",
    to: (req.body.To || req.body.Called || "").toString(),
    speech,
    confidence,
    outcome,
  }).catch((e) => req.log.error({ e }, "Failed to append call log to Google Sheets"));

  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
  gatherInput(vr, action, "Go ahead.", { bargeIn: true });

  sayText(vr, "Goodbye.");
  return hangup(res, vr);
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
 *  SSML ESCAPE
 * ------------------------- */
function escapeForSsml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
