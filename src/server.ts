/**
 * server.ts — AI Receptionist (Twilio Voice) + KB + Booking + Google Sheets
 *
 * Fixes:
 * - Robust speech handling: confidence gating + DTMF fallback menu
 * - Prices spoken naturally: "twenty rands" via SSML
 * - No random "Anything else?" loops: controlled gather + reprompt caps
 * - Booking flow: stable single stage machine + confirmation + logging
 *
 * Notes:
 * - Twilio SSML: pass "<speak>...</speak>" as Say body text (NO ssml attribute).
 * - Twilio Gather: can accept speech + dtmf simultaneously.
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
import { appendCallLog, appendBookingLog } from "./googleSheetsLogger";
import { createBookingEvent } from "./googleCalendar";

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

// Public base URL (Render URL)
const PUBLIC_BASE_URL = normalizeBaseUrl(
  process.env.PUBLIC_BASE_URL || process.env.BASE_URL || ""
);

// Voice defaults
type TtsVoice = "alice" | "Polly.Amy-Neural";
type TtsLang = "en-US" | "en-GB";
const TTS_VOICE: TtsVoice = pickVoice(process.env.TTS_VOICE);
const TTS_LANG: TtsLang = pickLang(process.env.TTS_LANG);

// Speech robustness
const MIN_CONFIDENCE = Number(process.env.MIN_SPEECH_CONFIDENCE ?? "0.45"); // tune: 0.35–0.60
const MAX_TURNS = Number(process.env.MAX_TURNS ?? "6");
const MAX_REPROMPTS = Number(process.env.MAX_REPROMPTS ?? "2");

// Data paths
const DATA_DIR = path.join(process.cwd(), "data");
const TENANTS_FILE = path.join(DATA_DIR, "tenants.json");
const CALLS_LOG_FILE = path.join(DATA_DIR, "calls.csv");

/** -------------------------
 *  TYPES
 * ------------------------- */
type HoursSpec = {
  [day: string]: { open: string; close: string } | undefined; // 0=Sun..6=Sat
};

type Tenant = {
  id: string;
  businessName: string;
  twilioNumber: string; // E.164
  timezone?: string;
  hours?: HoursSpec;
  handoffNumber?: string;
  knowledgeBaseId: string;
  calendarId?: string; // NEW
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
  sameDayCutoffTime?: string;
  leadTimeMin?: number;
  maxDaysAhead?: number;
};

type KnowledgeBase = {
  businessName?: string;
  timezone?: string; // future
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
  Digits?: string; // DTMF
  CallStatus?: string;
};

type Intent = "HANDOFF" | "PRICING" | "HOURS" | "ADDRESS" | "BOOKING" | "POLICY" | "OTHER";

type BookingStage = "idle" | "need_service" | "need_datetime" | "confirm" | "done";

type BookingState = {
  stage: BookingStage;
  serviceId?: string;
  serviceName?: string;
  startIso?: string;
  reprompts: number; // booking-local reprompt counter
};

type CallSession = {
  callSid: string;
  tenantId: string;
  from: string;
  to: string;
  createdAt: number;
  turns: number;
  reprompts: number; // global reprompt counter
  booking: BookingState;
};

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
 *  UTIL: URL / SIGNATURE
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
  return validateRequest(TWILIO_AUTH_TOKEN, signature, url, (req as any).body);
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
 *  TENANTS
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
 *  CSV LOGGING (optional local)
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
 *  NLP: intent + FAQ
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
 *  MONEY SPEAKING (ZAR)
 * ------------------------- */
function extractPriceValue(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return null;

  // "R20", "R 20", "20", "20.50"
  const cleaned = v.replace(/,/g, "").trim();
  const m = cleaned.match(/(?:r\s*)?(\d+(?:\.\d{1,2})?)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function moneySsmlZar(amount: number): string {
  // For voice, best = cardinal numbers; avoid "R20"
  // If cents exist, speak them too.
  const rounded = Math.round(amount * 100) / 100;
  const rands = Math.floor(rounded);
  const cents = Math.round((rounded - rands) * 100);

  if (cents > 0) {
    return `<say-as interpret-as="cardinal">${rands}</say-as> rands and <say-as interpret-as="cardinal">${cents}</say-as> cents`;
  }
  return `<say-as interpret-as="cardinal">${rands}</say-as> rands`;
}

function formatPricesSsml(services?: KnowledgeBase["services"]): string {
  const list = services || [];
  if (!list.length) {
    return `<speak>I don’t have the latest pricing yet. Would you like me to connect you to the owner?</speak>`;
  }

  // Example: "Haircut: twenty rands. Beard trim: thirty rands."
  const parts: string[] = [];
  for (const s of list) {
    const name = escapeForSsml(s.name || "Service");
    const amt = extractPriceValue(s.priceZar);
    const dur = typeof s.durationMin === "number" ? `, about <say-as interpret-as="cardinal">${s.durationMin}</say-as> minutes` : "";

    if (amt === null) {
      parts.push(`${name}: price on request${dur}`);
    } else {
      parts.push(`${name}: ${moneySsmlZar(amt)}${dur}`);
    }
  }

  return `<speak>${parts.join(". ")}.</speak>`;
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
  vr.say({ voice: TTS_VOICE, language: TTS_LANG } as any, clean);
}

/**
 * One unified gather:
 * - speech + dtmf
 * - if nothing captured, Twilio continues after gather block
 */
function gatherInput(
  vr: twiml.VoiceResponse,
  actionUrl: string,
  promptSsml: string,
  opts?: { bargeIn?: boolean; speechTimeout?: "auto" | number; numDigits?: number }
) {
  const gather = vr.gather({
    input: ["speech", "dtmf"],
    speechTimeout: opts?.speechTimeout ?? "auto",
    action: actionUrl,
    method: "POST",
    language: TTS_LANG,
    bargeIn: opts?.bargeIn ?? true,
    numDigits: opts?.numDigits ?? 1,
    timeout: 6,
  } as any);

  // Speak prompt inside Gather
  saySsml(gather as any, promptSsml);
}

/** -------------------------
 *  BOOKING (single stage)
 * ------------------------- */
function normalizeText(s: string) {
  return (s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function isBookingEnabled(kb: KnowledgeBase): boolean {
  if (!kb.booking) return false;
  return kb.booking.enabled !== false;
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

function nextWeekday(base: Date, targetDow: number) {
  const d = new Date(base);
  const diff = (targetDow + 7 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return d;
}

function parseBookingDateTime(speech: string): string | null {
  const t = normalizeText(speech);
  const now = new Date();

  const dowMap: Record<string, number> = {
    sunday: 0, sun: 0,
    monday: 1, mon: 1,
    tuesday: 2, tue: 2, tues: 2,
    wednesday: 3, wed: 3,
    thursday: 4, thu: 4, thur: 4, thurs: 4,
    friday: 5, fri: 5,
    saturday: 6, sat: 6,
  };

  let date: Date | null = null;

  if (/\btoday\b/.test(t)) date = new Date(now);
  else if (/\btomorrow\b/.test(t)) {
    date = new Date(now);
    date.setDate(date.getDate() + 1);
  } else {
    for (const [k, v] of Object.entries(dowMap)) {
      if (new RegExp(`\\b${k}\\b`).test(t)) {
        date = nextWeekday(now, v);
        break;
      }
    }
  }

  const time = parseTimeTo24h(t);
  if (!date || !time) return null;

  date.setHours(time.hh, time.mm, 0, 0);
  return date.toISOString();
}

function humanizeIso(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("en-ZA", {
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "short",
  });
}

/** -------------------------
 *  FALLBACK MENU (DTMF)
 * ------------------------- */
function menuPromptSsml(): string {
  return `<speak>
    Sorry, I didn’t catch that.
    <break time="200ms"/>
    You can say what you need, or press:
    <break time="150ms"/>
    1 for bookings,
    2 for prices,
    3 for hours,
    4 for location,
    or 0 to speak to the owner.
  </speak>`;
}

function digitsToIntent(d?: string): Intent | null {
  switch ((d || "").trim()) {
    case "1": return "BOOKING";
    case "2": return "PRICING";
    case "3": return "HOURS";
    case "4": return "ADDRESS";
    case "0": return "HANDOFF";
    default: return null;
  }
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
  const { req, res, vr, tenant, kb, session, speech } = args;

  if (!isBookingEnabled(kb)) {
    saySsml(vr, `<speak>Bookings are not available right now. Would you like prices, hours, or the address?</speak>`);
    return endWithNextPrompt(res, vr, tenant.id);
  }

  const b = session.booking;

  if (b.stage === "idle" || b.stage === "done") {
    // start booking
    session.booking = { stage: "need_service", reprompts: 0 };
  }

  if (session.booking.stage === "need_service") {
    const svc = findService(kb, speech);

    if (!svc) {
      b.reprompts++;
      if (b.reprompts > MAX_REPROMPTS) {
        // DTMF menu fallback after repeated failure
        const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
        gatherInput(vr, action, `<speak>Which service would you like? You can say “haircut”, “fade”, or “beard trim”.</speak>`);
        saySsml(vr, menuPromptSsml());
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
      }

      saySsml(vr, `<speak>Sure. What would you like to book? For example: haircut, fade, or beard trim.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id);
    }

    b.serviceId = svc.id;
    b.serviceName = svc.name;
    b.stage = "need_datetime";
    b.reprompts = 0;

    saySsml(
      vr,
      `<speak>
        Great. For a ${escapeForSsml(b.serviceName)}.
        <break time="150ms"/>
        What day and time would you like? For example, Friday at 9 a.m.
      </speak>`
    );
    return endWithNextPrompt(res, vr, tenant.id);
  }

  if (session.booking.stage === "need_datetime") {
    const startIso = parseBookingDateTime(speech);

    if (!startIso) {
      b.reprompts++;
      saySsml(vr, `<speak>Please say a day and time, like Friday at 9 a.m. or tomorrow at 2 p.m.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id);
    }

    b.startIso = startIso;
    b.stage = "confirm";
    b.reprompts = 0;

    saySsml(
      vr,
      `<speak>
        Just to confirm:
        <break time="150ms"/>
        ${escapeForSsml(b.serviceName ?? "your service")}
        on ${escapeForSsml(humanizeIso(startIso))}.
        <break time="200ms"/>
        Say yes to confirm, or no to change it.
      </speak>`
    );
    return endWithNextPrompt(res, vr, tenant.id);
  }

  if (session.booking.stage === "confirm") {
    const t = normalizeText(speech);
    const yes = /\b(yes|yeah|yep|confirm|correct|okay|ok)\b/.test(t);
    const no = /\b(no|nope|cancel|not|change)\b/.test(t);

    if (no) {
      b.stage = "need_datetime";
      saySsml(vr, `<speak>No problem. What day and time would you prefer instead?</speak>`);
      return endWithNextPrompt(res, vr, tenant.id);
    }

    if (!yes) {
      b.reprompts++;
      saySsml(vr, `<speak>Please say yes to confirm, or no to change the time.</speak>`);
      return endWithNextPrompt(res, vr, tenant.id);
    }

    // Confirmed booking → check calendar + create event
    const svc = (kb.services || []).find((s) => s.id === b.serviceId) ?? null;
    const durationMin = svc?.durationMin ?? 30;

    const timezone = kb.timezone || tenant.timezone || "Africa/Johannesburg";
    const calendarId = tenant.calendarId;

    if (!calendarId) {
      // Calendar not configured, fallback to Sheets only
      req.log.warn({ tenantId: tenant.id }, "No calendarId configured; skipping calendar insert");
    } else {
      try {
        const calResult = await createBookingEvent({
          calendarId,
          tenantId: tenant.id,
          callSid: session.callSid,
          serviceName: b.serviceName ?? "Booking",
          customerPhone: session.from,
          startIsoUtc: b.startIso ?? "",
          durationMin,
          timezone,
        });

        if (!calResult.ok && calResult.reason === "busy") {
          // Slot already taken — manual event or another booking
          b.stage = "need_datetime";
          saySsml(vr, `<speak>
            Sorry, that time is already booked.
            <break time="150ms"/>
            Please tell me another day and time.
          </speak>`);
          return endWithNextPrompt(res, vr, tenant.id);
        }

        if (!calResult.ok) {
          req.log.error({ calResult }, "Calendar insert failed");
          // We can still proceed, but better to be honest:
          saySsml(vr, `<speak>
            I’m having trouble confirming on the calendar right now.
            <break time="150ms"/>
            Please try another time, or I can connect you to the owner.
          </speak>`);
          b.stage = "need_datetime";
          return endWithNextPrompt(res, vr, tenant.id);
        }

        // Optional: store eventId in booking notes for auditing
        // b.calendarEventId = calResult.eventId
      } catch (e) {
        req.log.error({ e }, "Calendar createBookingEvent threw");
        b.stage = "need_datetime";
        saySsml(vr, `<speak>
          I couldn’t confirm that slot right now.
          <break time="150ms"/>
          Please tell me another day and time.
        </speak>`);
        return endWithNextPrompt(res, vr, tenant.id);
      }
    }

    // If calendar succeeded (or calendarId missing), now log to Sheets:
    await appendBookingLog({
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      callSid: session.callSid,
      name: "",
      phone: session.from,
      service: b.serviceName ?? "",
      startTime: b.startIso ?? "",
      durationMin,
      status: "confirmed",
      notes: "confirmed via voice",
    });

    b.stage = "done";

    // Call log outcome
    appendCallLog({
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      callSid: session.callSid,
      from: session.from,
      to: session.to,
      speech: `BOOKING_CONFIRMED service=${b.serviceId} start=${b.startIso}`,
      confidence: undefined,
      outcome: "booking_confirmed",
    }).catch((e) => req.log.error({ e }, "appendCallLog failed"));

    saySsml(vr, `<speak>Perfect. You’re booked. We’ll see you then. Goodbye.</speak>`);
    vr.hangup();
    return res.type("text/xml").send(vr.toString());

  }

  // Safety fallback
  session.booking = { stage: "need_service", reprompts: 0 };
  saySsml(vr, `<speak>Sure. What would you like to book?</speak>`);
  return endWithNextPrompt(res, vr, tenant.id);
}

/** -------------------------
 *  RESPONSE FLOW HELPERS
 * ------------------------- */
function endWithNextPrompt(res: Response, vr: twiml.VoiceResponse, tenantId: string) {
  // Respect turn cap
  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId });

  // Minimal prompt; avoid "Anything else?" randomness
  gatherInput(vr, action, `<speak>Go ahead.</speak>`, { bargeIn: true, numDigits: 1 });

  // If no input after gather: end politely
  saySsml(vr, `<speak>Sorry, I didn’t catch that. Goodbye.</speak>`);
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
        <break time="250ms"/>
        We’re currently closed.
        <break time="200ms"/>
        You can still tell me what you need.
      </speak>`
    );
  } else {
    saySsml(
      vr,
      `<speak>
        Hi there.
        <break time="200ms"/>
        You’ve reached ${escapeForSsml(tenant.businessName)}.
        <break time="200ms"/>
        How can I help you today?
      </speak>`
    );
  }

  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
  gatherInput(vr, action, `<speak>Go ahead.</speak>`, { bargeIn: true });

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

  // Turn cap
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

  // Inputs
  const digits = (req.body.Digits || "").trim();
  const speechRaw = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;

  // If user pressed a key, use menu intent immediately
  const digitIntent = digitsToIntent(digits);
  const speech = speechRaw;

  // Sticky booking: continue booking regardless of intent if mid-booking
  if (session.booking.stage !== "idle" && session.booking.stage !== "done") {
    const utter = digitIntent ? "" : speech; // digits don’t carry booking data
    if (!utter) {
      saySsml(vr, menuPromptSsml());
      return endWithNextPrompt(res, vr, tenant.id);
    }
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech: utter, confidence });
  }

  // If nothing captured at all
  if (!speech && !digitIntent) {
    session.reprompts++;
    if (session.reprompts > MAX_REPROMPTS) {
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, menuPromptSsml(), { numDigits: 1 });
      saySsml(vr, `<speak>Goodbye.</speak>`);
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    saySsml(vr, `<speak>Sorry, I didn’t catch that. Please say it again.</speak>`);
    return endWithNextPrompt(res, vr, tenant.id);
  }

  // Low-confidence speech: reprompt + menu fallback
  if (speech && typeof confidence === "number" && confidence < MIN_CONFIDENCE) {
    session.reprompts++;
    req.log.info({ confidence, speech }, "Low confidence speech");

    if (session.reprompts > MAX_REPROMPTS) {
      const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
      gatherInput(vr, action, menuPromptSsml(), { numDigits: 1 });
      saySsml(vr, `<speak>Goodbye.</speak>`);
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    saySsml(
      vr,
      `<speak>
        Sorry, I’m not sure I heard you correctly.
        <break time="150ms"/>
        Please say that again, or use the keypad.
      </speak>`
    );
    return endWithNextPrompt(res, vr, tenant.id);
  }

  // Determine intent
  const intent: Intent = digitIntent ?? detectIntent(speech);

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

  // Booking start
  if (intent === "BOOKING") {
    session.booking = { stage: "need_service", reprompts: 0 };
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  // Answers
  let answered = false;

  if (intent === "PRICING") {
    saySsml(vr, formatPricesSsml(kb.services));
    answered = true;
  } else if (intent === "HOURS") {
    // Keep this simple for now; later format from kb.hours properly.
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
    // Guided fallback instead of "Anything else"
    saySsml(
      vr,
      `<speak>
        I can help with bookings, prices, hours, and location.
        <break time="150ms"/>
        What would you like?
      </speak>`
    );
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

  return endWithNextPrompt(res, vr, tenant.id);
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
 *  SSML escaping helper
 * ------------------------- */
function escapeForSsml(s: string) {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
