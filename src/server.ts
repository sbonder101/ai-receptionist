import express, { Request, Response, NextFunction } from "express";
import dotenv from "dotenv";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import pinoHttp from "pino-http";
import pino from "pino";
import { v4 as uuidv4 } from "uuid";
import { twiml } from "twilio";
import type {
  VoiceResponseSayAttributes,
  VoiceResponseGatherAttributes
} from "twilio/lib/twiml/VoiceResponse";
import { validateRequest } from "twilio/lib/webhooks/webhooks";

dotenv.config();

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = (process.env.BASE_URL || "").replace(/\/+$/, "");
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VALIDATE_SIGNATURE = (process.env.TWILIO_VALIDATE_SIGNATURE || "false") === "true";

const TTS_VOICE =
  (process.env.TTS_VOICE as VoiceResponseSayAttributes["voice"]) || "alice";

const TTS_LANG =
  (process.env.TTS_LANG as VoiceResponseSayAttributes["language"]) || "en-ZA";

if (!BASE_URL) {
  logger.warn("BASE_URL is not set. TwiML callbacks may be wrong. Set BASE_URL in .env");
}

app.set("trust proxy", 1);
app.use(helmet());

// Twilio sends x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Request ID for traceability
app.use((req: Request, res: Response, next: NextFunction) => {
  const existing = req.header("x-request-id");
  (req as any).requestId = existing || uuidv4();
  res.setHeader("x-request-id", (req as any).requestId);
  next();
});

// Structured request logging
app.use(
  pinoHttp({
    logger,
    customProps: (req) => ({ requestId: (req as any).requestId }),
  })
);

// Rate limit (protects public endpoints)
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

function buildUrl(path: string): string {
  if (!BASE_URL) return path; // fallback
  return `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

function twilioSignatureOk(req: Request): boolean {
  if (!TWILIO_VALIDATE_SIGNATURE) return true;

  if (!TWILIO_AUTH_TOKEN) {
    logger.error("TWILIO_VALIDATE_SIGNATURE=true but TWILIO_AUTH_TOKEN is missing");
    return false;
  }

  const signature = req.header("X-Twilio-Signature") || "";
  const fullUrl = buildUrl(req.originalUrl);

  return validateRequest(TWILIO_AUTH_TOKEN, signature, fullUrl, req.body);
}

/**
 * Tenant routing (demo).
 * Later:
 * - map Called/To numbers to tenant
 * - or use query param tenantId
 */
function resolveTenantId(req: Request): string {
  return (req.query.tenantId as string) || "demo-sbo-tech";
}

type TwilioVoiceBody = {
  CallSid?: string;
  From?: string;
  To?: string;
  Called?: string;
  SpeechResult?: string;
  Confidence?: string;
};

function say(vr: twiml.VoiceResponse, text: string) {
  vr.say({ voice: TTS_VOICE, language: TTS_LANG }, text);
}

function gatherSpeech(vr: twiml.VoiceResponse, actionUrl: string, prompt: string) {
  const gather = vr.gather({
    input: ["speech"],
    speechTimeout: "auto",
    action: actionUrl,
    method: "POST",
    language: TTS_LANG as VoiceResponseGatherAttributes["language"],
  } as VoiceResponseGatherAttributes);

  gather.say({ voice: TTS_VOICE, language: TTS_LANG }, prompt);
}

app.get("/health", (_req, res) => res.json({ ok: true }));

/**
 * 1) Inbound call webhook
 * Twilio will POST here when a call comes in.
 */
app.post("/webhooks/twilio/inbound-call", (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const tenantId = resolveTenantId(req);
  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";

  req.log.info({ tenantId, callSid, from }, "Inbound call received");

  const vr = new twiml.VoiceResponse();

  // Greeting
  say(vr, "Hi, you’ve reached Sbo Tech. I’m the AI receptionist. How can I help you today?");

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
app.post("/webhooks/twilio/handle-speech", (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {
  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  const tenantId = resolveTenantId(req);
  const callSid = req.body.CallSid || "unknown";
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;

  req.log.info({ tenantId, callSid, speech, confidence }, "Speech received");

  const vr = new twiml.VoiceResponse();

  if (!speech) {
    say(vr, "I didn’t hear anything. Please call again. Goodbye.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }

  // Demo intent routing (replace later with LLM + RAG)
  const lower = speech.toLowerCase();
  let answer: string;

  if (/(price|cost|how much)/i.test(lower)) {
    answer = "A haircut is one hundred and twenty rand. A fade is one hundred and fifty rand.";
  } else if (/(open|close|hours|time)/i.test(lower)) {
    answer = "We are open Monday to Saturday from 9 AM to 7 PM.";
  } else if (/(where|location|address|direction)/i.test(lower)) {
    answer = "We are located at 123 Main Road, near Shoprite.";
  } else if (/(book|booking|appointment)/i.test(lower)) {
    answer = "Sure. Please tell me your name and preferred time. I will capture it and confirm.";
  } else {
    answer =
      "I can help with prices, hours, location, and bookings. Please ask one of those, or tell me what you need and I will take your details.";
  }

  say(vr, answer);

  // Loop another gather to keep the call going
  const action = buildUrl(`/webhooks/twilio/handle-speech?tenantId=${encodeURIComponent(tenantId)}`);
  gatherSpeech(vr, action, "What else can I help you with?");

  say(vr, "Okay, goodbye.");
  vr.hangup();

  res.type("text/xml").send(vr.toString());
});

// Central error handler
app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error", requestId: (req as any).requestId });
});

app.listen(PORT, () => {
  logger.info(`Sbo Tech AI receptionist webhook running on http://localhost:${PORT}`);
});