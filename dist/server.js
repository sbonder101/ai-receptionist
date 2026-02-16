"use strict";
/**
 * server.ts — AI Receptionist (Twilio Voice) + KB + Booking Flow + Google Sheets call logging
 *
 * Key fixes:
 * - NO `ssml="true"` attribute (Twilio rejects it). SSML must be the <Say> text containing <speak>...</speak>.
 * - sayText accepts unknown safely (prevents "(text||'').trim is not a function")
 * - Production-ish booking state machine (multi-turn) + confirmation
 * - Google Sheets logging (uses your appendCallLog from ./googleSheetsLogger)
 *
 * Required files:
 * - data/tenants.json
 * - data/<knowledgeBaseId>.json  (e.g. data/kb_sbotech.json)
 * - googleSheetsLogger.ts (your existing working version)
 *
 * ENV:
 * - PORT=3000
 * - PUBLIC_BASE_URL=https://ai-receptionist-iab1.onrender.com
 * - TWILIO_VALIDATE_SIGNATURE=true|false
 * - TWILIO_AUTH_TOKEN=...
 * - ALLOW_TEST_BYPASS=false
 * - TEST_BYPASS_KEY=...
 * - TTS_VOICE=alice|Polly.Amy-Neural
 * - TTS_LANG=en-GB|en-US
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const pino_http_1 = __importDefault(require("pino-http"));
const pino_1 = __importDefault(require("pino"));
const uuid_1 = require("uuid");
const twilio_1 = require("twilio");
const webhooks_1 = require("twilio/lib/webhooks/webhooks");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const googleSheetsLogger_1 = require("./googleSheetsLogger");
dotenv_1.default.config();
const app = (0, express_1.default)();
const logger = (0, pino_1.default)({ level: process.env.LOG_LEVEL || "info" });
/** -------------------------
 *  ENV
 * ------------------------- */
const PORT = Number(process.env.PORT || 3000);
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VALIDATE_SIGNATURE = (process.env.TWILIO_VALIDATE_SIGNATURE || "false") === "true";
const ALLOW_TEST_BYPASS = (process.env.ALLOW_TEST_BYPASS || "false") === "true";
const TEST_BYPASS_KEY = process.env.TEST_BYPASS_KEY || "";
// Public base URL (Render URL)
const PUBLIC_BASE_URL = normalizeBaseUrl(process.env.PUBLIC_BASE_URL || process.env.BASE_URL || "");
const TTS_VOICE = pickVoice(process.env.TTS_VOICE);
const TTS_LANG = pickLang(process.env.TTS_LANG);
// Data paths
const DATA_DIR = path_1.default.join(process.cwd(), "data");
const TENANTS_FILE = path_1.default.join(DATA_DIR, "tenants.json");
const CALLS_LOG_FILE = path_1.default.join(DATA_DIR, "calls.csv");
/** -------------------------
 *  MIDDLEWARE
 * ------------------------- */
app.set("trust proxy", 1);
app.use((0, helmet_1.default)());
app.use(express_1.default.urlencoded({ extended: false })); // Twilio: x-www-form-urlencoded
app.use((req, res, next) => {
    const existing = req.header("x-request-id");
    req.requestId = existing || (0, uuid_1.v4)();
    res.setHeader("x-request-id", req.requestId);
    next();
});
app.use((0, pino_http_1.default)({
    logger,
    customProps: (req) => ({ requestId: req.requestId }),
}));
app.use((0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
}));
/** -------------------------
 *  UTIL: URL / SIGNATURE
 * ------------------------- */
function normalizeBaseUrl(u) {
    const trimmed = (u || "").trim().replace(/\/+$/, "");
    if (!trimmed)
        return "";
    if (trimmed.startsWith("http://"))
        return "https://" + trimmed.slice("http://".length);
    if (!trimmed.startsWith("http"))
        return "https://" + trimmed;
    return trimmed;
}
/** Twilio signature validation needs exact full URL Twilio requested */
function getPublicUrl(req) {
    const proto = (req.header("x-forwarded-proto") || "https")
        .split(",")[0]
        .trim();
    const host = (req.header("x-forwarded-host") || req.header("host") || "")
        .split(",")[0]
        .trim();
    return `${proto}://${host}${req.originalUrl}`;
}
function buildAbsoluteUrl(pathname, query) {
    if (!PUBLIC_BASE_URL)
        return pathname;
    const url = new URL(PUBLIC_BASE_URL + (pathname.startsWith("/") ? pathname : `/${pathname}`));
    if (query) {
        for (const [k, v] of Object.entries(query)) {
            if (v)
                url.searchParams.set(k, v);
        }
    }
    return url.toString();
}
function twilioSignatureOk(req) {
    if (ALLOW_TEST_BYPASS &&
        TEST_BYPASS_KEY &&
        req.header("x-test-bypass") === TEST_BYPASS_KEY) {
        return true;
    }
    if (!TWILIO_VALIDATE_SIGNATURE)
        return true;
    if (!TWILIO_AUTH_TOKEN) {
        req.log.error("TWILIO_VALIDATE_SIGNATURE=true but TWILIO_AUTH_TOKEN missing");
        return false;
    }
    const signature = req.header("x-twilio-signature") || "";
    const url = getPublicUrl(req);
    return (0, webhooks_1.validateRequest)(TWILIO_AUTH_TOKEN, signature, url, req.body);
}
/** -------------------------
 *  UTIL: VOICE SETTINGS
 * ------------------------- */
function pickLang(v) {
    if (v === "en-US")
        return "en-US";
    return "en-GB";
}
function pickVoice(v) {
    if (v === "Polly.Amy-Neural")
        return "Polly.Amy-Neural";
    return "alice";
}
/** -------------------------
 *  TENANTS LOADING
 * ------------------------- */
let tenantsCache = null;
let tenantsMtimeMs = 0;
function loadTenants() {
    const st = fs_1.default.statSync(TENANTS_FILE);
    if (!tenantsCache || st.mtimeMs !== tenantsMtimeMs) {
        const raw = fs_1.default.readFileSync(TENANTS_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        tenantsCache = parsed;
        tenantsMtimeMs = st.mtimeMs;
        logger.info({ count: parsed.length }, "Tenants loaded");
    }
    return tenantsCache;
}
function normalizeE164(num) {
    return (num || "").replace(/\s+/g, "");
}
function resolveTenantByTwilioNumber(to) {
    const num = normalizeE164(to);
    const tenants = loadTenants();
    const tenant = tenants.find((t) => normalizeE164(t.twilioNumber) === num);
    if (tenant)
        return tenant;
    const fallback = tenants.find((t) => t.id === "demo-sbo-tech");
    if (!fallback)
        throw new Error("No fallback tenant demo-sbo-tech found in tenants.json");
    return fallback;
}
const kbCache = new Map();
function kbPath(knowledgeBaseId) {
    return path_1.default.join(DATA_DIR, `${knowledgeBaseId}.json`);
}
function loadKnowledgeBase(knowledgeBaseId) {
    const file = kbPath(knowledgeBaseId);
    const st = fs_1.default.statSync(file);
    const cached = kbCache.get(knowledgeBaseId);
    if (cached && cached.mtimeMs === st.mtimeMs)
        return cached.kb;
    const raw = fs_1.default.readFileSync(file, "utf-8");
    const kb = JSON.parse(raw);
    kbCache.set(knowledgeBaseId, { kb, mtimeMs: st.mtimeMs });
    return kb;
}
/** -------------------------
 *  CALL SESSION (in-memory)
 * ------------------------- */
const sessions = new Map();
function getSession(callSid, tenant, from, to) {
    const existing = sessions.get(callSid);
    if (existing)
        return existing;
    const s = {
        callSid,
        tenantId: tenant.id,
        from,
        to,
        createdAt: Date.now(),
        turns: 0,
        booking: { step: "idle" },
    };
    sessions.set(callSid, s);
    return s;
}
/** -------------------------
 *  CALL LOGGING (CSV)
 * ------------------------- */
function ensureCallsCsvHeader() {
    if (!fs_1.default.existsSync(CALLS_LOG_FILE)) {
        fs_1.default.mkdirSync(path_1.default.dirname(CALLS_LOG_FILE), { recursive: true });
        fs_1.default.writeFileSync(CALLS_LOG_FILE, "time,tenantId,callSid,from,to,intent,confidence,handoff,transcript\n", "utf-8");
    }
}
function csvEscape(v) {
    const s = (v ?? "").toString();
    if (/[,"\n]/.test(s))
        return `"${s.replace(/"/g, '""')}"`;
    return s;
}
function logCallTurn(params) {
    ensureCallsCsvHeader();
    const line = [
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
    fs_1.default.appendFileSync(CALLS_LOG_FILE, line, "utf-8");
}
/** -------------------------
 *  INTENT + FAQ MATCHING
 * ------------------------- */
function detectIntent(text) {
    const t = (text || "").toLowerCase();
    if (/\b(owner|manager|human|agent|representative|operator)\b/.test(t))
        return "HANDOFF";
    if (/speak to (the )?(owner|manager|someone)/.test(t))
        return "HANDOFF";
    if (/\bcomplaint|angry|refund|escalate\b/.test(t))
        return "HANDOFF";
    if (/\b(price|cost|how much|charge|rates|fee)\b/.test(t))
        return "PRICING";
    if (/\b(open|close|hours|time|when|today|tomorrow|weekend)\b/.test(t))
        return "HOURS";
    if (/\b(where|location|address|directions|near)\b/.test(t))
        return "ADDRESS";
    if (/\b(book|booking|appointment|schedule|slot|available)\b/.test(t))
        return "BOOKING";
    if (/\bpolicy|policies|cancellation|late|deposit|refund\b/.test(t))
        return "POLICY";
    return "OTHER";
}
function tokenize(s) {
    return (s || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
}
function bestFaqAnswer(kb, utterance) {
    const faqs = kb.faqs || [];
    if (!faqs.length)
        return null;
    const uTokens = new Set(tokenize(utterance));
    if (!uTokens.size)
        return null;
    let bestScore = 0;
    let best = null;
    for (const f of faqs) {
        const qTokens = tokenize(f.q);
        if (!qTokens.length)
            continue;
        let hit = 0;
        for (const t of qTokens)
            if (uTokens.has(t))
                hit++;
        const score = hit / qTokens.length;
        if (score > bestScore) {
            bestScore = score;
            best = f;
        }
    }
    if (best && bestScore >= 0.35)
        return best.a;
    return null;
}
function formatPrices(services) {
    const list = services || [];
    if (!list.length)
        return "I don’t have the latest pricing yet. Would you like me to connect you to the owner?";
    return list
        .map((s) => {
        const name = s.name || "Service";
        const price = typeof s.priceZar === "number"
            ? `R${s.priceZar}`
            : s.price
                ? `R${s.price}`
                : "price on request";
        const dur = typeof s.durationMin === "number"
            ? ` (${s.durationMin} minutes)`
            : s.duration
                ? ` (${s.duration})`
                : "";
        return `${name}: ${price}${dur}`;
    })
        .join(". ");
}
/** -------------------------
 *  HOURS (simple tenant hours)
 * ------------------------- */
function isOpenNow(tenant, now = new Date()) {
    if (!tenant.hours)
        return null;
    const day = now.getDay().toString(); // 0..6
    const spec = tenant.hours[day];
    if (!spec)
        return false;
    const [oh, om] = spec.open.split(":").map(Number);
    const [ch, cm] = spec.close.split(":").map(Number);
    if ([oh, om, ch, cm].some((n) => Number.isNaN(n)))
        return null;
    const mins = now.getHours() * 60 + now.getMinutes();
    const openMins = oh * 60 + om;
    const closeMins = ch * 60 + cm;
    return mins >= openMins && mins <= closeMins;
}
/** -------------------------
 *  TWIML HELPERS
 * ------------------------- */
function toPlainString(x) {
    if (x === null || x === undefined)
        return "";
    if (typeof x === "string")
        return x;
    if (typeof x === "number" || typeof x === "boolean")
        return String(x);
    try {
        return JSON.stringify(x);
    }
    catch {
        return String(x);
    }
}
function sayText(vr, text) {
    const clean = toPlainString(text).trim();
    if (!clean)
        return;
    vr.say({ voice: TTS_VOICE, language: TTS_LANG }, clean);
}
function saySsml(vr, ssml) {
    const clean = (ssml || "").trim();
    if (!clean)
        return;
    // IMPORTANT: no ssml="true" attribute. The SSML is the text body.
    vr.say({ voice: TTS_VOICE, language: TTS_LANG }, clean);
}
function gatherSpeech(vr, actionUrl, promptText, opts = {}) {
    const gather = vr.gather({
        input: ["speech"],
        speechTimeout: "auto",
        action: actionUrl,
        method: "POST",
        language: TTS_LANG,
        bargeIn: opts.bargeIn ?? true,
    });
    gather.say({ voice: TTS_VOICE, language: TTS_LANG }, promptText.trim());
}
/** -------------------------
 *  BOOKING ENGINE (state machine)
 * ------------------------- */
function matchService(kb, utterance) {
    const services = kb.services || [];
    if (!services.length)
        return null;
    const t = utterance.toLowerCase();
    for (const s of services) {
        const keys = (s.keywords || []).map((k) => k.toLowerCase());
        if (keys.some((k) => t.includes(k)))
            return s;
    }
    for (const s of services) {
        if (t.includes(s.name.toLowerCase()))
            return s;
    }
    return null;
}
function parseWhenLocal(utterance, now) {
    const t = utterance.toLowerCase();
    let dayOffset = null;
    if (/\btoday\b/.test(t))
        dayOffset = 0;
    else if (/\btomorrow\b/.test(t))
        dayOffset = 1;
    const weekdays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    for (let i = 0; i < weekdays.length; i++) {
        if (new RegExp(`\\b${weekdays[i]}\\b`).test(t)) {
            const target = i;
            const cur = now.getDay();
            let diff = (target - cur + 7) % 7;
            if (diff === 0)
                diff = 7;
            dayOffset = diff;
            break;
        }
    }
    let hour = null;
    let minute = 0;
    const hhmm = t.match(/\b(\d{1,2}):(\d{2})\b/);
    if (hhmm) {
        hour = Number(hhmm[1]);
        minute = Number(hhmm[2]);
    }
    else {
        const ampm = t.match(/\b(\d{1,2})\s?(am|pm)\b/);
        if (ampm) {
            hour = Number(ampm[1]);
            const ap = ampm[2];
            if (ap === "pm" && hour < 12)
                hour += 12;
            if (ap === "am" && hour === 12)
                hour = 0;
        }
    }
    if (hour === null) {
        if (/\bmorning\b/.test(t))
            hour = 10;
        else if (/\bafternoon\b/.test(t))
            hour = 14;
        else if (/\bevening\b/.test(t))
            hour = 17;
    }
    if (dayOffset === null && hour === null)
        return null;
    const base = new Date(now);
    base.setSeconds(0, 0);
    if (dayOffset !== null)
        base.setDate(base.getDate() + dayOffset);
    if (hour !== null)
        base.setHours(hour, minute, 0, 0);
    else
        base.setHours(10, 0, 0, 0);
    return base;
}
function validateBookingTime(kb, when, now) {
    const b = kb.booking;
    if (!b)
        return "Bookings are not configured yet.";
    const lead = b.leadTimeMin ?? 0;
    const maxDays = b.maxDaysAhead ?? 30;
    const diffMs = when.getTime() - now.getTime();
    if (diffMs < lead * 60000)
        return `Please choose a time at least ${lead} minutes from now.`;
    const maxMs = maxDays * 24 * 60 * 60000;
    if (diffMs > maxMs)
        return `Bookings can only be made up to ${maxDays} days ahead.`;
    if (b.sameDayCutoffTime && when.toDateString() === now.toDateString()) {
        const [h, m] = b.sameDayCutoffTime.split(":").map(Number);
        const cutoff = new Date(now);
        cutoff.setHours(h, m, 0, 0);
        if (now > cutoff)
            return `Same-day bookings are closed after ${b.sameDayCutoffTime}.`;
    }
    return null;
}
async function handleBookingFlow(args) {
    const { vr, session, tenant, kb, speech } = args;
    const now = new Date();
    const service = matchService(kb, speech);
    const when = parseWhenLocal(speech, now);
    const state = session.booking;
    if (state.step === "idle") {
        const chosenService = service;
        const chosenWhen = when;
        if (!chosenService && !chosenWhen) {
            session.booking = { step: "need_service" };
            saySsml(vr, `<speak>Sure. What would you like to book? For example, haircut, fade, or beard trim.</speak>`);
            return;
        }
        if (!chosenService) {
            session.booking = { step: "need_service", whenText: speech };
            saySsml(vr, `<speak>Sure. Which service do you want to book?</speak>`);
            return;
        }
        if (!chosenWhen) {
            session.booking = { step: "need_datetime", serviceId: chosenService.id };
            saySsml(vr, `<speak>Great. What day and time would you like?</speak>`);
            return;
        }
        const err = validateBookingTime(kb, chosenWhen, now);
        if (err) {
            session.booking = { step: "need_datetime", serviceId: chosenService.id };
            sayText(vr, err);
            saySsml(vr, `<speak>What day and time would you prefer instead?</speak>`);
            return;
        }
        session.booking = {
            step: "confirm",
            serviceId: chosenService.id,
            startIso: chosenWhen.toISOString(),
        };
        saySsml(vr, `<speak>
        Just to confirm:
        <break time="150ms"/>
        ${escapeForSsml(chosenService.name)}
        on ${escapeForSsml(chosenWhen.toLocaleString("en-ZA"))}.
        <break time="200ms"/>
        Say <emphasis>yes</emphasis> to confirm, or <emphasis>no</emphasis> to change it.
      </speak>`);
        return;
    }
    if (state.step === "need_service") {
        const chosenService = service;
        const carriedWhen = state.whenText ? parseWhenLocal(state.whenText, now) : null;
        if (!chosenService) {
            saySsml(vr, `<speak>Sorry, I didn’t catch the service. Please say haircut, fade, or beard trim.</speak>`);
            return;
        }
        if (!carriedWhen) {
            session.booking = { step: "need_datetime", serviceId: chosenService.id };
            saySsml(vr, `<speak>Great. What day and time would you like?</speak>`);
            return;
        }
        const err = validateBookingTime(kb, carriedWhen, now);
        if (err) {
            session.booking = { step: "need_datetime", serviceId: chosenService.id };
            sayText(vr, err);
            saySsml(vr, `<speak>What day and time would you prefer?</speak>`);
            return;
        }
        session.booking = {
            step: "confirm",
            serviceId: chosenService.id,
            startIso: carriedWhen.toISOString(),
        };
        saySsml(vr, `<speak>
        Confirm ${escapeForSsml(chosenService.name)} on ${escapeForSsml(carriedWhen.toLocaleString("en-ZA"))}?
        Say yes to confirm, or no to change.
      </speak>`);
        return;
    }
    if (state.step === "need_datetime") {
        const chosenWhen = when;
        if (!chosenWhen) {
            saySsml(vr, `<speak>Please tell me a day and time, like tomorrow at 10, or Friday at 2 pm.</speak>`);
            return;
        }
        const svc = (kb.services || []).find((s) => s.id === state.serviceId);
        if (!svc) {
            session.booking = { step: "idle" };
            sayText(vr, "I’m missing the service list right now. Please try again.");
            return;
        }
        const err = validateBookingTime(kb, chosenWhen, now);
        if (err) {
            sayText(vr, err);
            saySsml(vr, `<speak>What day and time would you prefer?</speak>`);
            return;
        }
        session.booking = {
            step: "confirm",
            serviceId: svc.id,
            startIso: chosenWhen.toISOString(),
        };
        saySsml(vr, `<speak>
        Confirm ${escapeForSsml(svc.name)} on ${escapeForSsml(chosenWhen.toLocaleString("en-ZA"))}?
        Say yes to confirm, or no to change.
      </speak>`);
        return;
    }
    if (state.step === "confirm") {
        const t = speech.toLowerCase();
        const yes = /\b(yes|yeah|yep|correct|confirm|ok)\b/.test(t);
        const no = /\b(no|nope|change|cancel)\b/.test(t);
        const svc = (kb.services || []).find((s) => s.id === state.serviceId);
        if (!svc) {
            session.booking = { step: "idle" };
            sayText(vr, "Something went wrong with the service list. Please try again.");
            return;
        }
        if (no) {
            session.booking = { step: "need_datetime", serviceId: svc.id };
            saySsml(vr, `<speak>No problem. What day and time would you prefer instead?</speak>`);
            return;
        }
        if (!yes) {
            saySsml(vr, `<speak>Please say yes to confirm, or no to change.</speak>`);
            return;
        }
        // Confirmed → log as a “booking_confirmed” outcome.
        // If you want, later add a separate "Bookings" sheet/tab.
        await (0, googleSheetsLogger_1.appendCallLog)({
            timestamp: new Date().toISOString(),
            tenantId: tenant.id,
            callSid: session.callSid,
            from: session.from,
            to: session.to,
            speech: `BOOKING_CONFIRMED service=${svc.id} start=${state.startIso}`,
            confidence: undefined,
            outcome: "booking_confirmed",
        });
        session.booking = { step: "complete" };
        const whenLocal = new Date(state.startIso).toLocaleString("en-ZA");
        saySsml(vr, `<speak>
        Perfect — you’re booked for ${escapeForSsml(svc.name)}.
        <break time="150ms"/>
        ${escapeForSsml(whenLocal)}.
      </speak>`);
        await (0, googleSheetsLogger_1.appendBookingLog)({
            timestamp: new Date().toISOString(),
            tenantId: tenant.id,
            callSid: session.callSid,
            from: session.from,
            serviceId: svc.id,
            serviceName: svc.name,
            startIso: state.startIso,
            status: "confirmed",
            notes: "confirmed via voice",
        });
        return;
    }
    if (state.step === "complete") {
        session.booking = { step: "idle" };
        saySsml(vr, `<speak>Anything else I can help you with?</speak>`);
        return;
    }
}
/** -------------------------
 *  HEALTH + ADMIN
 * ------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/admin/calls.csv", (_req, res) => {
    ensureCallsCsvHeader();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="calls.csv"');
    fs_1.default.createReadStream(CALLS_LOG_FILE).pipe(res);
});
/** -------------------------
 *  ROUTES
 * ------------------------- */
/** 1) Inbound call webhook */
app.post("/webhooks/twilio/inbound-call", (req, res) => {
    req.log.info({
        computedUrl: getPublicUrl(req),
        host: req.header("host"),
        xfHost: req.header("x-forwarded-host"),
        xfProto: req.header("x-forwarded-proto"),
        hasSig: !!req.header("x-twilio-signature"),
    }, "twilio inbound");
    if (!twilioSignatureOk(req))
        return res.status(403).send("Invalid Twilio signature");
    const callSid = req.body.CallSid || "unknown";
    const from = req.body.From || "unknown";
    const to = req.body.To || req.body.Called || "unknown";
    const tenant = resolveTenantByTwilioNumber(to);
    getSession(callSid, tenant, from, to);
    const vr = new twilio_1.twiml.VoiceResponse();
    const open = isOpenNow(tenant);
    if (open === false) {
        saySsml(vr, `<speak>
          Hi! You’ve reached ${escapeForSsml(tenant.businessName)}.
          <break time="250ms"/>
          We’re currently closed.
          <break time="250ms"/>
          Please tell me what you need, and I’ll take a message for the team.
        </speak>`);
    }
    else {
        saySsml(vr, `<speak>
          Hi there.
          <break time="250ms"/>
          You’ve reached ${escapeForSsml(tenant.businessName)}.
          <break time="250ms"/>
          I’m your virtual receptionist.
          <break time="200ms"/>
          How can I help you today?
        </speak>`);
    }
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", {
        tenantId: tenant.id,
    });
    gatherSpeech(vr, action, "Go ahead.", { bargeIn: true });
    sayText(vr, "Sorry, I didn’t catch that. Goodbye.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
});
/** 2) Handle speech webhook */
app.post("/webhooks/twilio/handle-speech", async (req, res) => {
    if (!twilioSignatureOk(req))
        return res.status(403).send("Invalid Twilio signature");
    const callSid = req.body.CallSid || "unknown";
    const from = req.body.From || "unknown";
    const to = req.body.To || req.body.Called || "unknown";
    const tenant = resolveTenantByTwilioNumber(to);
    const session = getSession(callSid, tenant, from, to);
    const speech = (req.body.SpeechResult || "").trim();
    const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;
    session.turns++;
    const vr = new twilio_1.twiml.VoiceResponse();
    if (!speech) {
        sayText(vr, "I didn’t hear anything. Please call again. Goodbye.");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
    }
    // Load KB safely
    let kb;
    try {
        kb = loadKnowledgeBase(tenant.knowledgeBaseId);
    }
    catch (e) {
        req.log.error({ err: e, tenantId: tenant.id }, "KB load failed");
        sayText(vr, "Sorry, I’m having trouble accessing the business info right now.");
        if (tenant.handoffNumber?.startsWith("+")) {
            sayText(vr, "Let me connect you to someone who can help.");
            vr.dial(tenant.handoffNumber);
            return res.type("text/xml").send(vr.toString());
        }
        sayText(vr, "Please try again later. Goodbye.");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
    }
    const intent = detectIntent(speech);
    const handoffRegex = /\b(owner|manager|human|agent|representative|operator)\b|speak to (the )?(owner|manager|someone)/i;
    const handoffRegexHit = handoffRegex.test(speech);
    // Local CSV log (optional)
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
        saySsml(vr, `<speak>
          Okay.
          <break time="150ms"/>
          Let me connect you to the owner.
        </speak>`);
        const dialTo = tenant.handoffNumber || kb.handoffNumber;
        if (!dialTo || !dialTo.startsWith("+")) {
            sayText(vr, "I can’t transfer right now. Please leave your number and we’ll call you back. Goodbye.");
            vr.hangup();
            return res.type("text/xml").send(vr.toString());
        }
        vr.dial(dialTo);
        return res.type("text/xml").send(vr.toString());
    }
    // BOOKING FLOW: sticky across turns
    if (session.booking.step !== "idle" || intent === "BOOKING") {
        await handleBookingFlow({ vr, session, tenant, kb, speech });
        // Google sheet logging for the turn (you already have it working)
        const outcome = session.booking.step === "confirm"
            ? "booking_confirm_pending"
            : session.booking.step === "complete"
                ? "booking_confirmed"
                : "booking_flow";
        (0, googleSheetsLogger_1.appendCallLog)({
            timestamp: new Date().toISOString(),
            tenantId: tenant.id,
            callSid,
            from: req.body.From || "",
            to: (req.body.To || req.body.Called || "").toString(),
            speech,
            confidence,
            outcome,
        }).catch((e) => req.log.error({ e }, "Failed to append call log to Google Sheets"));
        // Continue conversation
        if (session.turns >= 6) {
            sayText(vr, "Thanks for calling. Goodbye.");
            vr.hangup();
            return res.type("text/xml").send(vr.toString());
        }
        const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", {
            tenantId: tenant.id,
        });
        gatherSpeech(vr, action, "Anything else?", { bargeIn: true });
        sayText(vr, "Okay, goodbye.");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
    }
    // Non-booking intents
    let answer = null;
    if (intent === "PRICING")
        answer = formatPrices(kb.services);
    else if (intent === "HOURS") {
        // If you want, format kb.hours into text later; for now keep it simple:
        answer = "We are open Monday to Friday 9 to 6, Saturday 9 to 3. Closed Sundays.";
    }
    else if (intent === "ADDRESS")
        answer = kb.address || "I can share the address once it’s provided.";
    else if (intent === "POLICY") {
        const policy = kb.policies ? Object.values(kb.policies)[0] : null;
        answer = policy || bestFaqAnswer(kb, speech);
    }
    else {
        answer = bestFaqAnswer(kb, speech);
    }
    if (answer) {
        sayText(vr, answer);
    }
    else {
        saySsml(vr, `<speak>
          I can help with prices, business hours, location, and bookings.
          <break time="200ms"/>
          What would you like to know?
        </speak>`);
    }
    const outcome = handoffRegexHit ? "handoff" : answer ? "answered" : "fallback";
    (0, googleSheetsLogger_1.appendCallLog)({
        timestamp: new Date().toISOString(),
        tenantId: tenant.id,
        callSid,
        from: req.body.From || "",
        to: (req.body.To || req.body.Called || "").toString(),
        speech,
        confidence,
        outcome,
    }).catch((e) => req.log.error({ e }, "Failed to append call log to Google Sheets"));
    if (session.turns >= 4) {
        sayText(vr, "Thanks for calling. Goodbye.");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
    }
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", {
        tenantId: tenant.id,
    });
    gatherSpeech(vr, action, "Anything else I can help you with?", { bargeIn: true });
    sayText(vr, "Okay, goodbye.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
});
/** -------------------------
 *  ERROR HANDLER
 * ------------------------- */
app.use((err, req, res, _next) => {
    req.log.error({ err }, "Unhandled error");
    res.status(500).json({
        error: "Internal server error",
        requestId: req.requestId,
    });
});
app.listen(PORT, () => {
    logger.info(`AI receptionist webhook running on http://localhost:${PORT}`);
});
/** -------------------------
 *  SSML escaping helper
 * ------------------------- */
function escapeForSsml(s) {
    return (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
}
