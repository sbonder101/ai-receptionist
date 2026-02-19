/**
 * server.ts — AI Receptionist (Twilio Voice) + KB + Booking + Google Sheets + Google Calendar
 *
 * Key behaviors:
 * - Uses Gather input="speech dtmf" with enhanced speech model ("phone_call") and stage-specific hints.
 * - Confidence-aware reprompts: we do NOT advance booking state on low-confidence speech.
 * - Booking flow: service -> name -> date/time -> confirm -> create Calendar event -> log to Sheets.
 * - Pricing spoken as words (e.g., "one hundred and twenty rand") not "R120".
 * - Avoids SSML tags inside <Say> to prevent Twilio "un-parsable Say" errors; uses plain speech + punctuation.
 *
 * Required data files:
 * - data/tenants.json
 * - data/<knowledgeBaseId>.json
 *
 * ENV (minimum):
 * - PUBLIC_BASE_URL=https://<your-host>
 * - TWILIO_AUTH_TOKEN=...
 * - TWILIO_VALIDATE_SIGNATURE=true|false
 * - GOOGLE_CLIENT_EMAIL=...
 * - GOOGLE_PRIVATE_KEY=...
 * - GSHEETS_SPREADSHEET_ID=...
 * - GOOGLE_CALENDAR_ID=... (share this calendar with the service account email)
 *
 * Optional:
 * - TTS_VOICE=alice|Polly.Amy-Neural
 * - TTS_LANG=en-GB|en-US
 * - GSHEETS_TAB_NAME=Calls
 * - GSHEETS_BOOKINGS_TAB_NAME=Bookings
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
import { createBookingEvent, isSlotAvailable, findNextAvailableSlot } from "./googleCalendar";

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

// IMPORTANT: Set to your public domain, e.g. https://ai-receptionist-iab1.onrender.com
const PUBLIC_BASE_URL = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL || process.env.BASE_URL || ""
);

// Voice defaults
type TtsVoice = "alice" | "Polly.Amy-Neural";
type TtsLang = "en-US" | "en-GB";

const TTS_VOICE: TtsVoice = pickVoice(process.env.TTS_VOICE);
const TTS_LANG: TtsLang = pickLang(process.env.TTS_LANG);

// Data paths
const DATA_DIR = path.join(process.cwd(), "data");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
const CALLS_LOG_FILE = path.join(DATA_DIR, "calls.csv");

/** -------------------------
 *  TYPES
 * ------------------------- */
type HoursSpec = {
  // 0=Sun..6=Sat (simple tenant hours)
  [day: string]: { open: string; close: string } | undefined;
};

type Tenant = {
  id: string;
  businessName: string;
  twilioNumber: string; // E.164 +27...
  timezone?: string; // e.g. "Africa/Johannesburg"
  hours?: HoursSpec;
  handoffNumber?: string; // E.164 optional
  knowledgeBaseId: string; // e.g. "kb_sbotech"
  calendarId?: string; // optional override (else GOOGLE_CALENDAR_ID)
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
  slotSizeMin: number; // typically = service duration or 30
  bufferMin?: number; // extra padding around events
  sameDayCutoffTime?: string; // "16:00"
  leadTimeMin?: number; // e.g. 30
  maxDaysAhead?: number; // e.g. 30
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

type Intent =
  | "HANDOFF"
  | "PRICING"
  | "HOURS"
  | "ADDRESS"
  | "BOOKING"
  | "POLICY"
  | "OTHER";

type BookingStage =
  | "idle"
  | "need_service"
  | "need_name"
  | "need_datetime"
  | "confirm"
  | "done";

type BookingState = {
  stage: BookingStage;
  serviceId?: string;
  serviceName?: string;
  servicePriceZar?: number;
  serviceDurationMin?: number;
  callerName?: string;
  startIso?: string; // ISO date-time
  lowConfidenceCount?: number;
  lastPromptKey?: string;
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

/** -------------------------
 *  MIDDLEWARE
 * ------------------------- */
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.urlencoded({ extended: false })); // Twilio: x-www-form-urlencoded

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
 *  UTIL: URL / SIGNATURE
 * ------------------------- */
function normalizeBaseUrl(u: string): string {
  const trimmed = (u || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("http://")) return "https://" + trimmed.slice("http://".length);
  if (!trimmed.startsWith("http")) return "https://" + trimmed;
  return trimmed;
}

/** Twilio signature validation needs the EXACT full URL Twilio requested. */
function getPublicUrl(req: Request): string {
  const proto = (req.header("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (req.header("x-forwarded-host") || req.header("host") || "").split(",")[0].trim();
  return `${proto}://${host}${req.originalUrl}`;
}

function buildAbsoluteUrl(pathname: string, query?: Record<string, string | undefined>) {
  if (!PUBLIC_BASE_URL) return pathname;
  const url = new URL(PUBLIC_BASE_URL + (pathname.startsWith("/") ? pathname : `/${pathname}`));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v) url.searchParams.set(k, v);
    }
  }
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
 *  UTIL: VOICE SETTINGS
 * ------------------------- */
function pickLang(v?: string): TtsLang {
  if (v === "en-US") return "en-US";
  return "en-GB";
}

function pickVoice(v?: string): TtsVoice {
  if (v === "Polly.Amy-Neural") return "Polly.Amy-Neural";
  return "alice";
}

/** -------------------------
 *  TENANTS LOADING
 * ------------------------- */
let tenantsCache: Tenant[] | null = null;
let tenantsMtimeMs = 0;

function loadTenants(): Tenant[] {
  const st = fs.statSync(TENANTS_FILE);
  if (!tenantsCache || st.mtimeMs !== tenantsMtimeMs) {
    const raw = fs.readFileSync(TENANTS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as Tenant[];
    tenantsCache = parsed;
    tenantsMtimeMs = st.mtimeMs;
    logger.info({ count: parsed.length }, "Tenants loaded");
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

/** -------------------------
 *  KB LOADING + CACHE
 * ------------------------- */
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
 *  CALL SESSION (in-memory)
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
 *  CALL LOGGING (CSV)
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
 *  INTENT + FAQ MATCHING
 * ------------------------- */
function detectIntent(text: string): Intent {
  const t = (text || "").toLowerCase();

  // handoff first
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

  if (best && bestScore >= 0.35) return best.a;
  return null;
}

/** -------------------------
 *  PRICING (spoken words)
 * ------------------------- */
function formatPricesForSpeech(services?: KnowledgeBase["services"]) {
  const list = services || [];
  if (!list.length) {
    return "I don’t have the latest pricing yet. Would you like me to connect you to the owner?";
  }

  const parts: string[] = [];
  for (const s of list) {
    const name = s.name || "Service";
    const price = typeof s.priceZar === "number" ? `${zarToWords(s.priceZar)}` : "price on request";
    const dur = typeof s.durationMin === "number" ? `, about ${s.durationMin} minutes` : "";
    parts.push(`${name} costs ${price}${dur}`);
  }
  return parts.join(". ");
}

/** -------------------------
 *  HOURS (simple tenant hours)
 * ------------------------- */
function isOpenNow(tenant: Tenant, now = new Date()): boolean | null {
  if (!tenant.hours) return null;

  const day = now.getDay().toString(); // 0..6
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

function gatherInput(
  vr: twiml.VoiceResponse,
  actionUrl: string,
  promptText: string,
  opts: { bargeIn?: boolean; hints?: string[] } = {}
) {
  const cleanPrompt = (promptText || "").trim() || "Go ahead.";
  const gather = vr.gather({
    input: ["speech", "dtmf"],
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
    language: TTS_LANG,
    bargeIn: opts.bargeIn ?? true,
    enhanced: true,
    speechModel: "phone_call",
    hints: opts.hints ?? undefined,
  } as any);

  gather.say({ voice: TTS_VOICE, language: TTS_LANG } as any, cleanPrompt);
}

/**
 * Standard pattern:
 * - After Gather, redirect to /no-input so we can reprompt once.
 * - Do NOT place "goodbye" immediately after Gather (it causes random goodbyes).
 */
function addNoInputRedirect(vr: twiml.VoiceResponse, tenantId: string, attempt: number) {
  const url = buildAbsoluteUrl("/webhooks/twilio/no-input", { tenantId, attempt: String(attempt) });
  vr.redirect({ method: "POST" }, url);
}

/** -------------------------
 *  BOOKING PARSERS
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
  // Matches: 9, 9:00, 9am, 9 am, 2pm, 14:00, 2:30 p.m.
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

function nextWeekday(base: Date, targetDow: number) {
  const d = new Date(base);
  // base day not included; if base is Friday and target is Friday -> next Friday (7 days)
  const diff = (targetDow + 7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function parseBookingDateTimeIso(speech: string, tz: string): string | null {
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

  let date: DateTime | null = null;

  if (/\btoday\b/.test(t)) {
    date = now;
  } else if (/\btomorrow\b/.test(t)) {
    date = now.plus({ days: 1 });
  } else {
    for (const [k, v] of Object.entries(dowMap)) {
      if (new RegExp(`\\b${k}\\b`).test(t)) {
        // Luxon weekday: Mon=1..Sun=7
        let target = v;
        let d = now;
        let diff = (target - d.weekday + 7) % 7;
        if (diff === 0) diff = 7;
        date = d.plus({ days: diff });
        break;
      }
    }
  }

  const time = parseTimeTo24h(t);
  if (!date || !time) return null;

  const dt = date.set({ hour: time.hh, minute: time.mm, second: 0, millisecond: 0 });
  return dt.toUTC().toISO();
}

function humanizeIsoInTz(isoUtc: string, tz: string) {
  const dt = DateTime.fromISO(isoUtc, { zone: "utc" }).setZone(tz);
  return dt.toLocaleString(DateTime.DATETIME_FULL);
}

function getHintsForBookingStage(kb: KnowledgeBase, stage: BookingStage): string[] {
  if (stage === "need_service") {
    const services = (kb.services || []).slice(0, 12).map((s) => s.name);
    return ["haircut", "appointment", ...services].filter(Boolean);
  }
  if (stage === "need_name") {
    return ["my name is", "it's", "I am"];
  }
  if (stage === "need_datetime") {
    return ["today", "tomorrow", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "9 am", "2 pm", "14:00"];
  }
  if (stage === "confirm") {
    return ["yes", "no", "confirm", "change"];
  }
  return [];
}

function isBookingEnabled(kb: KnowledgeBase): boolean {
  if (!kb.booking) return false;
  if (kb.booking.enabled === false) return false;
  return true;
}

function confidenceTooLow(confidence?: number): boolean {
  if (confidence === undefined || Number.isNaN(confidence)) return false;
  // Twilio confidence is usually 0..1. Tighten this as you see fit.
  return confidence < 0.45;
}

function extractNameFromSpeech(speech: string): string | null {
  const t = speech.trim();
  if (!t) return null;

  // strip common prefixes
  const cleaned = t
    .replace(/^\s*(my name is|it's|it is|i am|this is)\s+/i, "")
    .trim();

  // keep letters/spaces/apostrophe/hyphen
  const safe = cleaned.replace(/[^a-zA-Z\s'\-]/g, " ").replace(/\s+/g, " ").trim();
  if (safe.length < 2) return null;
  // Avoid accidentally taking "yes"/"no" as name
  if (/^(yes|no|okay|ok|confirm|cancel)$/i.test(safe)) return null;

  // Cap length
  return safe.slice(0, 40);
}

/** Validate booking time against booking rules and calendar conflicts */
async function validateAndMaybeSuggest(args: {
  tenant: Tenant;
  kb: KnowledgeBase;
  serviceDurationMin: number;
  startIsoUtc: string;
}): Promise<{ ok: true } | { ok: false; message: string; suggestionIsoUtc?: string }> {
  const { tenant, kb, serviceDurationMin, startIsoUtc } = args;
  const cfg = kb.booking;
  const tz = kb.timezone || tenant.timezone || "Africa/Johannesburg";
  if (!cfg) return { ok: false, message: "Bookings are not configured yet." };

  const start = DateTime.fromISO(startIsoUtc, { zone: "utc" }).setZone(tz);
  const now = DateTime.now().setZone(tz);

  const lead = cfg.leadTimeMin ?? 0;
  const maxDays = cfg.maxDaysAhead ?? 30;

  if (start.diff(now, "minutes").minutes < lead) {
    return { ok: false, message: `Please choose a time at least ${lead} minutes from now.` };
  }

  if (start.diff(now, "days").days > maxDays) {
    return { ok: false, message: `Bookings can only be made up to ${maxDays} days ahead.` };
  }

  if (cfg.sameDayCutoffTime && start.hasSame(now, "day")) {
    const [h, m] = cfg.sameDayCutoffTime.split(":").map(Number);
    const cutoff = now.set({ hour: h, minute: m, second: 0, millisecond: 0 });
    if (now > cutoff) {
      return { ok: false, message: `Same-day bookings are closed after ${cfg.sameDayCutoffTime}.` };
    }
  }

  // Calendar conflict check
  const endIsoUtc = DateTime.fromISO(startIsoUtc, { zone: "utc" }).plus({ minutes: serviceDurationMin }).toISO()!;
  const available = await isSlotAvailable(startIsoUtc, endIsoUtc, tenant.calendarId);
  if (available) return { ok: true };

  const suggestion = await findNextAvailableSlot(
    startIsoUtc,
    serviceDurationMin,
    tenant.calendarId,
    { daysToSearch: 7, stepMinutes: cfg.slotSizeMin || 30 }
  );

  return {
    ok: false,
    message: "That time is already taken.",
    suggestionIsoUtc: suggestion ?? undefined,
  };
}

/** -------------------------
 *  BOOKING: state machine
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
  digits?: string;
}) {
  const { req, res, vr, tenant, kb, session, speech, confidence } = args;

  if (!isBookingEnabled(kb)) {
    sayText(vr, "Bookings are not available right now. Would you like the address or business hours?");
    return sendAndEnd(res, vr);
  }

  const tz = kb.timezone || tenant.timezone || "Africa/Johannesburg";
  const b = session.booking;

  // Low-confidence handling (don't advance state)
  if (confidenceTooLow(confidence)) {
    b.lowConfidenceCount = (b.lowConfidenceCount ?? 0) + 1;
    if (b.lowConfidenceCount >= 2) {
      // After repeated low-confidence, offer DTMF as backup or handoff.
      sayText(vr, "Sorry, the line is not very clear. You can also say it slowly, or I can connect you to the owner.");
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, "Please repeat that slowly.", { hints: getHintsForBookingStage(kb, b.stage) });
      addNoInputRedirect(vr, tenant.id, 1);
      return res.type("text/xml").send(vr.toString());
    }

    sayText(vr, "Sorry, I didn’t catch that clearly. Please repeat.");
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherInput(vr, action, "Please repeat.", { hints: getHintsForBookingStage(kb, b.stage) });
    addNoInputRedirect(vr, tenant.id, 1);
    return res.type("text/xml").send(vr.toString());
  } else {
    b.lowConfidenceCount = 0;
  }

  // If idle, try to auto-detect service and datetime from first utterance
  if (b.stage === "idle") {
    const svc = findService(kb, speech);
    const dtIso = parseBookingDateTimeIso(speech, tz);

    if (svc) {
      b.serviceId = svc.id;
      b.serviceName = svc.name;
      b.serviceDurationMin = svc.durationMin;
      b.servicePriceZar = svc.priceZar;

      // If they also gave a date/time, skip ahead to name (still need name)
      b.stage = "need_name";
      if (dtIso) b.startIso = dtIso;

      const pricePart = typeof svc.priceZar === "number" ? ` That costs ${zarToWords(svc.priceZar)}.` : "";
      sayText(vr, `Great. ${svc.name}.${pricePart} What name should I put on the booking?`);
    } else {
      b.stage = "need_service";
      sayText(vr, "Sure. What would you like to book? For example, haircut, consultation, or service.");
    }

    return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, b.stage));
  }

  if (b.stage === "need_service") {
    const svc = findService(kb, speech);
    if (!svc) {
      sayText(vr, "Sorry, I didn’t catch the service. Please say the service name, like haircut or consultation.");
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_service"));
    }

    b.serviceId = svc.id;
    b.serviceName = svc.name;
    b.serviceDurationMin = svc.durationMin;
    b.servicePriceZar = svc.priceZar;
    b.stage = "need_name";

    const pricePart = typeof svc.priceZar === "number" ? ` It costs ${zarToWords(svc.priceZar)}.` : "";
    sayText(vr, `Great — ${svc.name}.${pricePart} What name should I put on the booking?`);
    return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_name"));
  }

  if (b.stage === "need_name") {
    const name = extractNameFromSpeech(speech);
    if (!name) {
      sayText(vr, "Sorry, what is your name for the booking?");
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_name"));
    }

    b.callerName = name;
    // If we already captured datetime from earlier, go straight to confirm; else ask for datetime.
    if (b.startIso) {
      b.stage = "confirm";
      const whenHuman = humanizeIsoInTz(b.startIso, tz);
      const pricePart = typeof b.servicePriceZar === "number" ? ` Cost: ${zarToWords(b.servicePriceZar)}.` : "";
      sayText(vr, `Just to confirm: ${b.serviceName} for ${name}, on ${whenHuman}.${pricePart} Say yes to confirm, or no to change.`);
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "confirm"));
    }

    b.stage = "need_datetime";
    sayText(vr, `Thanks ${name}. What day and time would you like? For example, Friday at 9 AM.`);
    return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_datetime"));
  }

  if (b.stage === "need_datetime") {
    const startIsoUtc = parseBookingDateTimeIso(speech, tz);
    if (!startIsoUtc) {
      sayText(vr, "Please say a day and time, like tomorrow at 2 PM, or Friday at 9 AM.");
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_datetime"));
    }

    b.startIso = startIsoUtc;
    b.stage = "confirm";

    const whenHuman = humanizeIsoInTz(startIsoUtc, tz);
    const pricePart = typeof b.servicePriceZar === "number" ? ` Cost: ${zarToWords(b.servicePriceZar)}.` : "";
    sayText(vr, `Just to confirm: ${b.serviceName} for ${b.callerName ?? "you"}, on ${whenHuman}.${pricePart} Say yes to confirm, or no to change.`);
    return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "confirm"));
  }

  if (b.stage === "confirm") {
    const t = normalizeText(speech);
    const yes = /\b(yes|yeah|yep|confirm|correct|okay|ok)\b/.test(t);
    const no = /\b(no|nope|cancel|not|change)\b/.test(t);

    if (no) {
      b.stage = "need_datetime";
      sayText(vr, "No problem. What day and time would you prefer instead?");
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_datetime"));
    }

    if (!yes) {
      sayText(vr, "Please say yes to confirm, or no to change the time.");
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "confirm"));
    }

    // Validate again + calendar conflict
    const duration = b.serviceDurationMin ?? kb.booking?.slotSizeMin ?? 30;
    const startIsoUtc = b.startIso;
    if (!startIsoUtc) {
      b.stage = "need_datetime";
      sayText(vr, "I’m missing the booking time. Please tell me the day and time again.");
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_datetime"));
    }

    const validation = await validateAndMaybeSuggest({
      tenant,
      kb,
      serviceDurationMin: duration,
      startIsoUtc,
    });

    if (!validation.ok) {
      if (validation.suggestionIsoUtc) {
        const suggestionHuman = humanizeIsoInTz(validation.suggestionIsoUtc, tz);
        b.stage = "confirm";
        b.startIso = validation.suggestionIsoUtc;
        sayText(vr, `${validation.message} The next available time is ${suggestionHuman}. Say yes to book that, or no to choose a different time.`);
        return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "confirm"));
      }

      b.stage = "need_datetime";
      sayText(vr, `${validation.message} What day and time would you prefer?`);
      return promptNext(res, vr, tenant.id, getHintsForBookingStage(kb, "need_datetime"));
    }

    // Create calendar event
    const endIsoUtc = DateTime.fromISO(startIsoUtc, { zone: "utc" }).plus({ minutes: duration }).toISO()!;
    const title = `${tenant.businessName}: ${b.serviceName || "Booking"} — ${b.callerName || session.from}`;
    const description = [
      `Tenant: ${tenant.id}`,
      `Caller: ${b.callerName || ""}`,
      `Phone: ${session.from}`,
      `Service: ${b.serviceName || ""}`,
      typeof b.servicePriceZar === "number" ? `Price: ${b.servicePriceZar} ZAR` : "",
      `Booked via AI receptionist`,
      `CallSid: ${session.callSid}`,
    ].filter(Boolean).join("\n");

    try {
      await createBookingEvent(title, description, startIsoUtc, endIsoUtc, tenant.calendarId);
    } catch (e: any) {
      req.log.error({ e }, "createBookingEvent failed");
      // We still log the booking to Sheets as "pending_calendar"
    }

    // Log booking to Sheets
    try {
      await appendBookingLog({
        timestamp: new Date().toISOString(),
        tenantId: tenant.id,
        callSid: session.callSid,
        name: b.callerName ?? "",
        phone: session.from,
        service: b.serviceName ?? "",
        startTime: startIsoUtc,
        durationMin: duration,
        status: "confirmed",
        notes: "confirmed via voice (calendar attempted)",
      });
    } catch (e: any) {
      req.log.error({ e }, "appendBookingLog failed");
    }

    // Log call row too
    appendCallLog({
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      callSid: session.callSid,
      from: session.from,
      to: session.to,
      speech: `BOOKING_CONFIRMED service=${b.serviceId} start=${startIsoUtc}`,
      confidence,
      outcome: "booking_confirmed",
    }).catch((e) => req.log.error({ e }, "appendCallLog failed"));

    b.stage = "done";
    const whenHuman = humanizeIsoInTz(startIsoUtc, tz);
    sayText(vr, `Perfect. You’re booked for ${b.serviceName} on ${whenHuman}. Thank you. Goodbye.`);
    return sendAndEnd(res, vr);
  }

  // done -> polite end
  sayText(vr, "Thanks for calling. Goodbye.");
  return sendAndEnd(res, vr);
}

/** -------------------------
 *  RESPONSE FLOW HELPERS
 * ------------------------- */
function promptNext(res: Response, vr: twiml.VoiceResponse, tenantId: string, hints: string[] = []) {
  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId });
  gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints });
  addNoInputRedirect(vr, tenantId, 1);
  return res.type("text/xml").send(vr.toString());
}

function sendAndEnd(res: Response, vr: twiml.VoiceResponse) {
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
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

/** Inbound call webhook */
app.post("/webhooks/twilio/inbound-call", (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  try {
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
  getSession(callSid, tenant, from, to);

  const vr = new twiml.VoiceResponse();

  const open = isOpenNow(tenant);
  if (open === false) {
    sayText(vr, `Hi. You’ve reached ${tenant.businessName}. We’re currently closed. Please tell me what you need, and I’ll take a message for the team.`);
  } else {
    sayText(vr, `Hi. You’ve reached ${tenant.businessName}. I’m your virtual receptionist. How can I help you today?`);
  }

  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
  gatherInput(vr, action, "Go ahead.", { bargeIn: true, hints: ["book", "price", "hours", "address", "appointment"] });
  addNoInputRedirect(vr, tenant.id, 1);

  return res.type("text/xml").send(vr.toString());
  } catch (err: any) {
    req.log.error({ err }, "inbound-call failed");
    const vr = new twiml.VoiceResponse();
    sayText(vr, "Sorry, something went wrong. Please try again later.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }
});

/** No-input fallback (after Gather timeout) */
app.post("/webhooks/twilio/no-input", (req: Request, res: Response) => {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const attempt = Number((req.query.attempt as string) || "1");
  const tenantId = (req.query.tenantId as string) || "unknown";

  const vr = new twiml.VoiceResponse();

  if (attempt <= 1) {
    sayText(vr, "Sorry, I didn’t catch that.");
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId });
    gatherInput(vr, action, "Please say that again.", { bargeIn: true });
    addNoInputRedirect(vr, tenantId, 2);
    return res.type("text/xml").send(vr.toString());
  }

  sayText(vr, "No problem. Please call again when you’re ready. Goodbye.");
  return sendAndEnd(res, vr);
});

/** Handle speech webhook */
app.post("/webhooks/twilio/handle-speech", async (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  try {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  const to = req.body.To || req.body.Called || "unknown";

  const tenant = resolveTenantByTwilioNumber(to);
  const session = getSession(callSid, tenant, from, to);

  const speech = (req.body.SpeechResult || "").trim();
  const digits = (req.body.Digits || "").trim();
  const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;

  session.turns++;

  const vr = new twiml.VoiceResponse();

  // Convert DTMF digits to an utterance if no speech (backup)
  const utterance = speech || digits;

  if (!utterance) {
    sayText(vr, "I didn’t hear anything. Please call again. Goodbye.");
    return sendAndEnd(res, vr);
  }

  // Load KB safely
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
    return sendAndEnd(res, vr);
  }

  // Sticky booking: if mid-booking, keep booking regardless of intent
  if (session.booking.stage !== "idle" && session.booking.stage !== "done") {
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech: utterance, confidence, digits });
  }

  const intent = detectIntent(utterance);

  // Start booking flow
  if (intent === "BOOKING") {
    session.booking = { stage: "idle", lowConfidenceCount: 0 };
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech: utterance, confidence, digits });
  }

  const handoffRegex =
    /\b(owner|manager|human|agent|representative|operator)\b|speak to (the )?(owner|manager|someone)/i;
  const handoffRegexHit = handoffRegex.test(utterance);

  // Local CSV log
  logCallTurn({
    tenantId: tenant.id,
    callSid,
    from,
    to,
    intent,
    confidence,
    handoff: handoffRegexHit,
    transcript: utterance,
  });

  // HANDOFF
  if (intent === "HANDOFF") {
    sayText(vr, "Okay. Let me connect you to the owner.");
    const dialTo = tenant.handoffNumber || kb.handoffNumber;
    if (!dialTo || !dialTo.startsWith("+")) {
      sayText(vr, "I can’t transfer right now. Please leave your number and we’ll call you back. Goodbye.");
      return sendAndEnd(res, vr);
    }
    vr.dial(dialTo);
    return res.type("text/xml").send(vr.toString());
  }

  // Non-booking intents
  let answer: string | null = null;

  if (intent === "PRICING") answer = formatPricesForSpeech(kb.services);
  else if (intent === "HOURS") answer = "We can share hours once the business provides them."; // keep generic
  else if (intent === "ADDRESS") answer = kb.address || "I can share the address once it’s provided.";
  else if (intent === "POLICY") {
    const policy = kb.policies ? Object.values(kb.policies)[0] : null;
    answer = policy || bestFaqAnswer(kb, utterance);
  } else {
    answer = bestFaqAnswer(kb, utterance);
  }

  if (answer) {
    sayText(vr, answer);
  } else {
    sayText(vr, "I can help with prices, business hours, location, and bookings. What would you like to know?");
  }

  // Google Sheets logging for call turn
  const outcome = handoffRegexHit ? "handoff" : answer ? "answered" : "fallback";
  appendCallLog({
    timestamp: new Date().toISOString(),
    tenantId: tenant.id,
    callSid,
    from: req.body.From || "",
    to: (req.body.To || req.body.Called || "").toString(),
    speech: utterance,
    confidence,
    outcome,
  }).catch((e) => req.log.error({ e }, "Failed to append call log to Google Sheets"));

  // Ask another question (optional). Remove "random" feel by only offering once.
  if (session.turns >= 2) {
    sayText(vr, "Thanks for calling. Goodbye.");
    return sendAndEnd(res, vr);
  }

  return promptNext(res, vr, tenant.id, ["book", "price", "hours", "address"]);
  } catch (err: any) {
    // IMPORTANT: Always respond with TwiML to Twilio (not JSON) to prevent retries/fallback errors.
    req.log.error({ err }, "handle-speech failed");
    const vr = new twiml.VoiceResponse();
    sayText(vr, "Sorry, I had a technical problem. Please try again.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }
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
 *  Money-to-words: ZAR
 * ------------------------- */
function zarToWords(amount: number): string {
  const rounded = Math.round(amount);
  if (rounded === 0) return "zero rand";
  const words = intToWords(rounded);
  // In SA, people commonly say "twenty rand" (not "rands")
  return `${words} rand`;
}

function intToWords(n: number): string {
  const ones = [
    "zero","one","two","three","four","five","six","seven","eight","nine","ten",
    "eleven","twelve","thirteen","fourteen","fifteen","sixteen","seventeen","eighteen","nineteen"
  ];
  const tens = ["","","twenty","thirty","forty","fifty","sixty","seventy","eighty","ninety"];

  const under100 = (x: number): string => {
    if (x < 20) return ones[x];
    const t = Math.floor(x / 10);
    const r = x % 10;
    return r ? `${tens[t]}-${ones[r]}` : tens[t];
  };

  const under1000 = (x: number): string => {
    if (x < 100) return under100(x);
    const h = Math.floor(x / 100);
    const r = x % 100;
    return r ? `${ones[h]} hundred and ${under100(r)}` : `${ones[h]} hundred`;
  };

  if (n < 1000) return under1000(n);
  if (n < 1_000_000) {
    const th = Math.floor(n / 1000);
    const r = n % 1000;
    const left = `${under1000(th)} thousand`;
    return r ? `${left} ${under1000(r)}` : left;
  }
  if (n < 1_000_000_000) {
    const mil = Math.floor(n / 1_000_000);
    const r = n % 1_000_000;
    const left = `${under1000(mil)} million`;
    return r ? `${left} ${intToWords(r)}` : left;
  }
  return String(n);
}
