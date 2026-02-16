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
const tenants_json_1 = __importDefault(require("../data/tenants.json"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
dotenv_1.default.config();
const app = (0, express_1.default)();
const logger = (0, pino_1.default)({ level: process.env.LOG_LEVEL || "info" });
const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VALIDATE_SIGNATURE = (process.env.TWILIO_VALIDATE_SIGNATURE || "false") === "true";
function pickVoice(v) {
    return v === "alice" ? "alice" : "alice";
}
function pickLang(v) {
    if (v === "en-US")
        return "en-US";
    return "en-ZA";
}
function loadKnowledgeBase(knowledgeBaseId) {
    const file = path_1.default.join(process.cwd(), "data", `${knowledgeBaseId}.json`);
    return JSON.parse(fs_1.default.readFileSync(file, "utf-8"));
}
const TTS_VOICE = pickVoice(process.env.TTS_VOICE);
const TTS_LANG = pickLang(process.env.TTS_LANG);
app.set("trust proxy", 1);
app.use((0, helmet_1.default)());
function resolveTenantByTwilioNumber(to) {
    const num = (to || "").replace(/\s+/g, "");
    const tenant = tenants_json_1.default.find(t => t.twilioNumber === num);
    if (!tenant) {
        // fallback tenant
        return tenants_json_1.default.find(t => t.id === "demo-sbo-tech");
    }
    return tenant;
}
// Twilio sends x-www-form-urlencoded
app.use(express_1.default.urlencoded({ extended: false }));
// Request ID for traceability
app.use((req, res, next) => {
    const existing = req.header("x-request-id");
    req.requestId = existing || (0, uuid_1.v4)();
    res.setHeader("x-request-id", req.requestId);
    next();
});
// Structured request logging
app.use((0, pino_http_1.default)({
    logger,
    customProps: (req) => ({ requestId: req.requestId }),
}));
// Rate limit (protects public endpoints)
app.use((0, express_rate_limit_1.default)({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
}));
function buildUrl(path) {
    if (!BASE_URL)
        return path; // fallback
    return `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}
function twilioSignatureOk(req) {
    if (!TWILIO_VALIDATE_SIGNATURE)
        return true;
    if (!TWILIO_AUTH_TOKEN) {
        logger.error("TWILIO_VALIDATE_SIGNATURE=true but TWILIO_AUTH_TOKEN is missing");
        return false;
    }
    const signature = req.header("X-Twilio-Signature") || "";
    const fullUrl = buildUrl(req.originalUrl);
    return (0, webhooks_1.validateRequest)(TWILIO_AUTH_TOKEN, signature, fullUrl, req.body);
}
/**
 * Tenant routing (demo).
 * Later:
 * - map Called/To numbers to tenant
 * - or use query param tenantId
 */
function resolveTenantId(req) {
    return req.query.tenantId || "demo-sbo-tech";
}
function say(vr, text) {
    vr.say({ voice: TTS_VOICE, language: TTS_LANG }, text);
}
function gatherSpeech(vr, actionUrl, prompt) {
    const gather = vr.gather({
        input: ["speech"],
        speechTimeout: "auto",
        action: actionUrl,
        method: "POST",
        language: TTS_LANG,
    });
    gather.say({ voice: TTS_VOICE, language: TTS_LANG }, prompt);
}
function twilioAuth(req, res, next) {
    const signature = req.headers["x-twilio-signature"];
    const url = `${process.env.PUBLIC_BASE_URL}${req.originalUrl}`;
    const isValid = (0, webhooks_1.validateRequest)(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body);
    if (!isValid) {
        return res.status(403).send("Forbidden");
    }
    next();
}
function answerFromKB(kb, utterance) {
    const u = utterance.toLowerCase();
    if (/(price|cost|how much)/.test(u)) {
        const list = kb.services.map((s) => `${s.name} is ${s.price} rand`).join(". ");
        return list;
    }
    if (/(open|close|hours|time)/.test(u)) {
        return kb.hours;
    }
    if (/(where|location|address)/.test(u)) {
        return kb.address;
    }
    if (/(book|booking|appointment)/.test(u)) {
        return kb.bookingRules + " I can take your name and preferred time.";
    }
    for (const faq of kb.faqs || []) {
        if (u.includes(faq.q.toLowerCase().split(" ")[0])) {
            return faq.a;
        }
    }
    return null;
}
app.get("/health", (_req, res) => res.json({ ok: true }));
/**
 * 1) Inbound call webhook
 * Twilio will POST here when a call comes in.
 */
app.post("/webhooks/twilio/inbound-call", (req, res) => {
    if (!twilioSignatureOk(req))
        return res.status(403).send("Invalid Twilio signature");
    const callSid = req.body.CallSid || "unknown";
    const from = req.body.From || "unknown";
    const to = req.body.To || req.body.Called;
    const tenant = resolveTenantByTwilioNumber(to);
    const tenantId = tenant.id;
    req.log.info({ tenantId, callSid, from }, "Inbound call received");
    const vr = new twilio_1.twiml.VoiceResponse();
    // Greeting
    say(vr, `Hi, you’ve reached ${tenant.businessName}. I’m the AI receptionist. How can I help you?`);
    // Gather initial speech
    const action = buildUrl(`/webhooks/twilio/handle-speech?tenantId=${encodeURIComponent(tenantId)}`);
    gatherSpeech(vr, action, "Please tell me what you need.");
    // Fallback if user says nothing
    say(vr, "Sorry, I didn’t catch that. Goodbye.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
});
/**
 * 2) Handle speech webhook
 * Twilio will POST here after <Gather> captures speech.
 */
app.post("/webhooks/twilio/handle-speech", (req, res) => {
    if (!twilioSignatureOk(req))
        return res.status(403).send("Invalid Twilio signature");
    const callSid = req.body.CallSid || "unknown";
    const speech = (req.body.SpeechResult || "").trim();
    const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;
    const lower = speech.toLowerCase();
    const to = req.body.To || req.body.Called;
    const tenant = resolveTenantByTwilioNumber(to);
    const tenantId = tenant.id;
    req.log.info({ tenantId, callSid, speech, confidence }, "Speech received");
    const vr = new twilio_1.twiml.VoiceResponse();
    // No speech
    if (!speech) {
        say(vr, "I didn’t hear anything. Please call again. Goodbye.");
        vr.hangup();
        return res.type("text/xml").send(vr.toString());
    }
    // handoff fallback
    const handoffRegex = /\b(owner|manager|human|agent|representative)\b|speak to (the )?(owner|manager)/i;
    if (handoffRegex.test(speech)) {
        say(vr, "Let me connect you to the owner.");
        vr.dial(tenant.handoffNumber);
        return res.type("text/xml").send(vr.toString());
    }
    const kb = loadKnowledgeBase(tenant.knowledgeBaseId);
    const answer = answerFromKB(kb, speech);
    if (answer) {
        say(vr, answer);
    }
    else {
        say(vr, "I can help with prices, hours, location, and bookings. What would you like to know?");
    }
    // Loop another gather to keep the call going
    const action = buildUrl(`/webhooks/twilio/handle-speech?tenantId=${encodeURIComponent(tenantId)}`);
    gatherSpeech(vr, action, "What else can I help you with?");
    say(vr, "Okay, goodbye.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
});
// Central error handler
app.use((err, req, res, _next) => {
    req.log.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error", requestId: req.requestId });
});
app.listen(PORT, () => {
    logger.info(`Sbo Tech AI receptionist webhook running on http://localhost:${PORT}`);
});
