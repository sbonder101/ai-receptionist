/**
 * server.ts — AI Receptionist (Twilio Voice) + KB + Booking Flow + Google Sheets call logging
 *
 * Notes:
 * - Twilio SSML: include "<speak>...</speak>" as the Say text (NO ssml="true" attribute).
 * - Booking: single state machine using `stage` only (prevents looping).
 * - Google Sheets: uses appendCallLog from ./googleSheetsLogger (as you shared).
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
import { appendCallLog } from "./googleSheetsLogger";

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
  timezone?: string;
  hours?: HoursSpec;
  handoffNumber?: string; // E.164 optional
  knowledgeBaseId: string; // e.g. "kb_sbotech"
};

type KBService = {
  id: string;
  name: string;
  priceZar?: number;
  durationMin: number;
  keywords?: string[];
};

type KBBooking = {
  enabled?: boolean; // <-- added (instead of "allowed")
  slotSizeMin: number;
  bufferMin?: number;
  sameDayCutoffTime?: string; // "16:00"
  leadTimeMin?: number; // e.g. 30
  maxDaysAhead?: number; // e.g. 30
};

type KnowledgeBase = {
  businessName?: string;
  timezone?: string; // "Africa/Johannesburg"
  address?: string;
  handoffNumber?: string;

  hours?: {
    mon: Array<{ open: string; close: string }>;
    tue: Array<{ open: string; close: string }>;
    wed: Array<{ open: string; close: string }>;
    thu: Array<{ open: string; close: string }>;
    fri: Array<{ open: string; close: string }>;
    sat: Array<{ open: string; close: string }>;
    sun: Array<{ open: string; close: string }>;
  };

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

type BookingStage = "idle" | "need_service" | "need_datetime" | "confirm" | "done";

type BookingState = {
  stage: BookingStage;
  serviceId?: string;
  serviceName?: string;
  startIso?: string; // ISO date-time
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
    booking: { stage: "idle" },
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

function formatPrices(services?: KnowledgeBase["services"]) {
  const list = services || [];
  if (!list.length) {
    return "I don’t have the latest pricing yet. Would you like me to connect you to the owner?";
  }

  return list
    .map((s) => {
      const name = s.name || "Service";
      const price = typeof s.priceZar === "number" ? `R${s.priceZar}` : "price on request";
      const dur = typeof s.durationMin === "number" ? ` (${s.durationMin} minutes)` : "";
      return `${name}: ${price}${dur}`;
    })
    .join(". ");
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

// SSML is just the body text with <speak>...</speak>
function saySsml(vr: twiml.VoiceResponse, ssml: string) {
  const clean = (ssml || "").trim();
  if (!clean) return;
  vr.say({ voice: TTS_VOICE, language: TTS_LANG } as any, clean);
}

function gatherSpeech(
  vr: twiml.VoiceResponse,
  actionUrl: string,
  promptText: string,
  opts: { bargeIn?: boolean } = {}
) {
  const gather = vr.gather({
    input: ["speech"],
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
    language: TTS_LANG,
    bargeIn: opts.bargeIn ?? true,
  } as any);

  gather.say({ voice: TTS_VOICE, language: TTS_LANG } as any, promptText.trim());
}

/** -------------------------
 *  BOOKING: single stage machine
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

  if (/\btoday\b/.test(t)) {
    date = new Date(now);
  } else if (/\btomorrow\b/.test(t)) {
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

function continueOrEnd(res: Response, vr: twiml.VoiceResponse, tenantId: string, endAfterThis?: boolean) {
  if (endAfterThis) {
    sayText(vr, "Thanks for calling. Goodbye.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId });
  gatherSpeech(vr, action, "Anything else?", { bargeIn: true });
  sayText(vr, "Okay, goodbye.");
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
}

function isBookingEnabled(kb: KnowledgeBase): boolean {
  // default to enabled if booking config exists
  if (!kb.booking) return false;
  if (kb.booking.enabled === false) return false;
  return true;
}

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

  if (!isBookingEnabled(kb)) {
    sayText(vr, "Bookings are not available right now. Would you like the address or business hours?");
    return continueOrEnd(res, vr, tenant.id);
  }

  const b = session.booking;

  if (b.stage === "need_service") {
    const svc = findService(kb, speech);
    if (!svc) {
      saySsml(vr, `<speak>Sure. What would you like to book? For example: haircut, fade, or beard trim.</speak>`);
      return continueOrEnd(res, vr, tenant.id);
    }

    b.serviceId = svc.id;
    b.serviceName = svc.name;
    b.stage = "need_datetime";

    sayText(vr, `Great — for a ${b.serviceName}. What day and time would you like? For example, Friday at 9 AM.`);
    return continueOrEnd(res, vr, tenant.id);
  }

  if (b.stage === "need_datetime") {
    const startIso = parseBookingDateTime(speech);
    if (!startIso) {
      saySsml(vr, `<speak>Please say a day and time, like Friday at 9 a.m. or tomorrow at 2 p.m.</speak>`);
      return continueOrEnd(res, vr, tenant.id);
    }

    b.startIso = startIso;
    b.stage = "confirm";

    sayText(vr, `Just to confirm: ${b.serviceName ?? "your service"} on ${humanizeIso(startIso)}. Should I book it? Say yes or no.`);
    return continueOrEnd(res, vr, tenant.id);
  }

  if (b.stage === "confirm") {
    const t = normalizeText(speech);
    const yes = /\b(yes|yeah|yep|confirm|correct|okay|ok)\b/.test(t);
    const no = /\b(no|nope|cancel|not|change)\b/.test(t);

    if (no) {
      b.stage = "need_datetime";
      sayText(vr, "No problem. What day and time would you prefer instead?");
      return continueOrEnd(res, vr, tenant.id);
    }

    if (!yes) {
      sayText(vr, "Please say yes to confirm, or no to change the time.");
      return continueOrEnd(res, vr, tenant.id);
    }

    // Confirmed:
    b.stage = "done";

    saySsml(vr, `<speak>Perfect. You’re booked. We’ll see you then.</speak>`);

    // Optional: log booking confirmation as a call-log outcome
    appendCallLog({
      timestamp: new Date().toISOString(),
      tenantId: tenant.id,
      callSid: session.callSid,
      from: session.from,
      to: session.to,
      speech: `BOOKING_CONFIRMED service=${b.serviceId ?? ""} start=${b.startIso ?? ""}`,
      confidence,
      outcome: "booking_confirmed",
    }).catch((e) => req.log.error({ e }, "Failed to append booking confirmation to Google Sheets"));

    return continueOrEnd(res, vr, tenant.id, true);
  }

  // idle/done -> reset and start
  session.booking = { stage: "need_service" };
  sayText(vr, "Sure. What would you like to book?");
  return continueOrEnd(res, vr, tenant.id);
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
  gatherSpeech(vr, action, "Go ahead.", { bargeIn: true });

  sayText(vr, "Sorry, I didn’t catch that. Goodbye.");
  vr.hangup();

  res.type("text/xml").send(vr.toString());
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

  if (!speech) {
    sayText(vr, "I didn’t hear anything. Please call again. Goodbye.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
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
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Sticky booking: if mid-booking, keep booking regardless of detected intent.
  if (session.booking.stage !== "idle" && session.booking.stage !== "done") {
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  const intent = detectIntent(speech);

  // If user says booking, start booking flow
  if (intent === "BOOKING") {
    session.booking = { stage: "need_service" };
    return handleBookingTurn({ req, res, vr, tenant, kb, session, speech, confidence });
  }

  const handoffRegex =
    /\b(owner|manager|human|agent|representative|operator)\b|speak to (the )?(owner|manager|someone)/i;
  const handoffRegexHit = handoffRegex.test(speech);

  // Local CSV log
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

  // HANDOFF
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
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }

    vr.dial(dialTo);
    return res.type("text/xml").send(vr.toString());
  }

  // Non-booking intents
  let answer: string | null = null;

  if (intent === "PRICING") answer = formatPrices(kb.services);
  else if (intent === "HOURS") answer = "We are open Monday to Friday 9 to 6, Saturday 9 to 3. Closed Sundays.";
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
  gatherSpeech(vr, action, "Anything else I can help you with?", { bargeIn: true });

  sayText(vr, "Okay, goodbye.");
  vr.hangup();
  return res.type("text/xml").send(vr.toString());
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
