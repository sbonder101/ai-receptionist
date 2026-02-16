"use strict";
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
// If you want JSON import: enable resolveJsonModule in tsconfig.
// Alternatively, read tenants via fs (shown below) to avoid TS JSON import issues.
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
// IMPORTANT for action URLs. Set to your public domain (Render URL).
// Example: https://ai-receptionist-iab1.onrender.com
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
/** IMPORTANT:
 * Twilio signature validation needs the EXACT full URL Twilio requested.
 * On Render/Cloudflare you must reconstruct using forwarded headers + originalUrl (includes query).
 */
function getPublicUrl(req) {
    const proto = (req.header("x-forwarded-proto") || "https").split(",")[0].trim();
    const host = (req.header("x-forwarded-host") || req.header("host") || "").split(",")[0].trim();
    return `${proto}://${host}${req.originalUrl}`; // includes query string
}
function buildAbsoluteUrl(pathname, query) {
    if (!PUBLIC_BASE_URL)
        return pathname; // fallback (local)
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
    // postman bypass for testing (never enable in real prod without strict key)
    if (ALLOW_TEST_BYPASS && TEST_BYPASS_KEY && req.header("x-test-bypass") === TEST_BYPASS_KEY) {
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
/**
 * Twilio classic voices: "alice"
 * Twilio Polly examples: "Polly.Amy-Neural", "Polly.Matthew", etc.
 * Use strings; Twilio will reject unsupported combos.
 */
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
function detectIntent(text) {
    const t = (text || "").toLowerCase();
    // handoff first (high priority)
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
/**
 * Simple scoring:
 * - token overlap / question tokens
 * Good enough to feel "smart" without ML.
 */
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
    // threshold to avoid nonsense matches
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
        const price = s.price ? `R${s.price}` : "price on request";
        const dur = s.duration ? ` (${s.duration})` : "";
        return `${s.name}: ${price}${dur}`;
    })
        .join(". ");
}
/** -------------------------
 *  HOURS (simple v1)
 * ------------------------- */
function isOpenNow(tenant, now = new Date()) {
    // if no hours configured, don’t block
    if (!tenant.hours)
        return null;
    const day = now.getDay().toString(); // "0".."6"
    const spec = tenant.hours[day];
    if (!spec)
        return false;
    // parse "HH:MM"
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
function sayText(vr, text) {
    const clean = (text || "").trim();
    if (!clean)
        return;
    vr.say({ voice: TTS_VOICE, language: TTS_LANG }, clean);
}
function saySsml(vr, ssml) {
    // IMPORTANT:
    // - ssml must be valid and not empty
    // - trim to avoid “un-parsable” issues
    const clean = (ssml || "").trim();
    if (!clean)
        return;
    vr.say({ voice: TTS_VOICE, language: TTS_LANG, ssml: true }, clean);
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
 *  HEALTH + ADMIN
 * ------------------------- */
app.get("/health", (_req, res) => res.json({ ok: true }));
// Quick CSV download to open in Excel
app.get("/admin/calls.csv", (_req, res) => {
    ensureCallsCsvHeader();
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="calls.csv"');
    fs_1.default.createReadStream(CALLS_LOG_FILE).pipe(res);
});
/** -------------------------
 *  ROUTES
 * ------------------------- */
/**
 * 1) Inbound call webhook
 * Configure your Twilio number "A call comes in" -> this endpoint
 */
app.post("/webhooks/twilio/inbound-call", (req, res) => {
    // Optional debug line
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
    const session = getSession(callSid, tenant, from, to);
    req.log.info({ tenantId: tenant.id, callSid, from, to }, "Inbound call received");
    const vr = new twilio_1.twiml.VoiceResponse();
    // Open/Closed
    const open = isOpenNow(tenant);
    if (open === false) {
        // Closed-hours experience (WOW)
        saySsml(vr, `<speak>
        Hi! You’ve reached ${escapeForSsml(tenant.businessName)}.
        <break time="250ms"/>
        We’re currently closed.
        <break time="250ms"/>
        Please tell me what you need, and I’ll take a message for the team.
      </speak>`);
    }
    else {
        // Natural greeting (SSML)
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
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherSpeech(vr, action, "Go ahead.", { bargeIn: true });
    // If no speech captured
    sayText(vr, "Sorry, I didn’t catch that. Goodbye.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
});
/**
 * 2) Handle speech webhook
 */
app.post("/webhooks/twilio/handle-speech", (req, res) => {
    if (!twilioSignatureOk(req))
        return res.status(403).send("Invalid Twilio signature");
    const callSid = req.body.CallSid || "unknown";
    const from = req.body.From || "unknown";
    const to = req.body.To || req.body.Called || "unknown";
    // Prefer To-number routing; query tenantId is helpful but not trusted
    const tenant = resolveTenantByTwilioNumber(to);
    const session = getSession(callSid, tenant, from, to);
    const speech = (req.body.SpeechResult || "").trim();
    const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;
    session.turns++;
    req.log.info({ tenantId: tenant.id, callSid, from, to, speech, confidence, turns: session.turns }, "Speech received");
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
        // Offer handoff if available
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
    const handoffRegexHit = intent === "HANDOFF";
    // Log call turn (business value)
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
        if (!tenant.handoffNumber || !tenant.handoffNumber.startsWith("+")) {
            sayText(vr, "I can’t transfer right now. Please leave your number and we’ll call you back. Goodbye.");
            vr.hangup();
            return res.type("text/xml").send(vr.toString());
        }
        vr.dial(tenant.handoffNumber);
        return res.type("text/xml").send(vr.toString());
    }
    // Respond by intent + fallback to FAQ match
    let answer = null;
    if (intent === "PRICING")
        answer = formatPrices(kb.services);
    else if (intent === "HOURS")
        answer = kb.hours || "I can share hours once they’re provided by the business.";
    else if (intent === "ADDRESS")
        answer = kb.address || "I can share the address once it’s provided by the business.";
    else if (intent === "BOOKING")
        answer = kb.booking?.notes || "We can help with bookings. What day and time would you prefer?";
    else if (intent === "POLICY") {
        // Try policy map or FAQ
        const policy = kb.policies ? Object.values(kb.policies)[0] : null;
        answer = policy || bestFaqAnswer(kb, speech);
    }
    else {
        // OTHER -> FAQ best match
        answer = bestFaqAnswer(kb, speech);
    }
    if (answer) {
        sayText(vr, answer);
    }
    else {
        // A helpful guided fallback (feels professional)
        saySsml(vr, `<speak>
        I can help with prices, business hours, location, and bookings.
        <break time="200ms"/>
        What would you like to know?
      </speak>`);
    }
    // log call in google sheets
    const handoffRegex = /\b(owner|manager|human|agent|representative)\b|speak to (the )?(owner|manager)/i;
    const outcome = handoffRegex.test(speech)
        ? "handoff"
        : answer
            ? "answered"
            : "fallback";
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
    // Continue conversation (cap turns to avoid endless loop)
    if (session.turns >= 4) {
        sayText(vr, "Thanks for calling. Goodbye.");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
    }
    const action = buildAbsoluteUrl("/webhooks/twilio/handle-speech", { tenantId: tenant.id });
    gatherSpeech(vr, action, "Anything else I can help you with?", { bargeIn: true });
    sayText(vr, "Okay, goodbye.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
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
