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
import tenants from "../data/tenants.json";
import fs from "fs";
import path from "path";

dotenv.config();

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const PORT = Number(process.env.PORT || 3000);
const BASE_URL = normalizeBaseUrl(process.env.BASE_URL || process.env.PUBLIC_BASE_URL || "");
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_VALIDATE_SIGNATURE = (process.env.TWILIO_VALIDATE_SIGNATURE || "false") === "true";


// fix 

function getPublicUrl(req: Request): string {
  const proto = (req.header("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (req.header("x-forwarded-host") || req.header("host") || "").split(",")[0].trim();
  return `${proto}://${host}${req.originalUrl}`; // includes ?query
}



// end fix

function normalizeBaseUrl(u: string): string {
  const trimmed = (u || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  if (trimmed.startsWith("http://")) return "https://" + trimmed.slice("http://".length);
  if (!trimmed.startsWith("http")) return "https://" + trimmed;
  return trimmed;
}

type TtsVoice =
  | "alice"
  | "Polly.Amy-Neural"
  | "Polly.Matthew-Neural"
  | "Polly.Emma-Neural"; // example
type TtsLang = "en-US" | "en-GB";

function pickVoice(v: string | undefined): TtsVoice {
  return v === "alice" ? "alice" : "Polly.Amy-Neural";
}

function pickLang(v: string | undefined): TtsLang {
  if (v === "en-GB") return "en-GB";
  return "en-US";
}

function loadKnowledgeBase(knowledgeBaseId: string) {
  const file = path.join(process.cwd(), "data", `${knowledgeBaseId}.json`);

  if (!fs.existsSync(file)) {
    throw new Error(`KB file not found: ${file}`);
  }

  const raw = fs.readFileSync(file, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`KB JSON invalid: ${file}`);
  }
}

const TTS_VOICE: TtsVoice = pickVoice(process.env.TTS_VOICE);
const TTS_LANG: TtsLang = pickLang(process.env.TTS_LANG);

app.set("trust proxy", 1);
app.use(helmet());

// tennat routing
type Tenant = {
  id: string;
  businessName: string;
  twilioNumber: string;
  timezone: string;
  hours: Record<string, string>;
  handoffNumber: string;
  knowledgeBaseId: string;
};

function resolveTenantByTwilioNumber(to?: string): Tenant {
  const num = (to || "").replace(/\s+/g, "");
  const tenant = (tenants as Tenant[]).find(t => t.twilioNumber === num);

  if (!tenant) {
    // fallback tenant
    return (tenants as Tenant[]).find(t => t.id === "demo-sbo-tech")!;
  }
  return tenant;
}

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
  if (!BASE_URL ) return path; // fallback
  return `${BASE_URL}${path.startsWith("/") ? "" : "/"}${path}`;
}

function buildAbsoluteUrl(req: Request, path: string): string {
  const proto = (req.header("x-forwarded-proto") || "https").split(",")[0].trim();
  const host = (req.header("x-forwarded-host") || req.header("host") || "").split(",")[0].trim();
  return `${proto}://${host}${path.startsWith("/") ? path : `/${path}`}`;
}

const ALLOW_TEST_BYPASS = process.env.ALLOW_TEST_BYPASS === "true";

function twilioSignatureOk(req: Request): boolean {
  

  if (ALLOW_TEST_BYPASS && req.header("x-test-bypass") === process.env.TEST_BYPASS_KEY) {
    return true;
  }

  if (!TWILIO_VALIDATE_SIGNATURE) return true;

  const signature = req.header("x-twilio-signature") || "";
  const url = getPublicUrl(req);
  return validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);
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
    language: TTS_LANG,
  } as any);

  gather.say({ voice: TTS_VOICE, language: TTS_LANG }, prompt);
}


function answerFromKB(kb: any, utterance: string): string | null {
  const u = utterance.toLowerCase();

  if (/(price|cost|how much)/.test(u)) {
    const list = kb.services.map((s: any) => `${s.name} is ${s.price} rand`).join(". ");
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
app.post("/webhooks/twilio/inbound-call", (req: Request<{}, {}, TwilioVoiceBody>, res: Response) => {

  // test
  req.log.info({
    computedUrl: getPublicUrl(req),
    hasSig: !!req.header("x-twilio-signature"),
    host: req.header("host"),
    xfHost: req.header("x-forwarded-host"),
    xfProto: req.header("x-forwarded-proto"),
  }, "twilio sig debug");

  if (!twilioSignatureOk(req)) return res.status(403).send("Invalid Twilio signature");

  
  const callSid = req.body.CallSid || "unknown";
  const from = req.body.From || "unknown";
  const to = req.body.To || req.body.Called;
  const tenant = resolveTenantByTwilioNumber(to);
  const tenantId = tenant.id;

  req.log.info({ tenantId, callSid, from }, "Inbound call received");

  const vr = new twiml.VoiceResponse();

  // Greeting
  say(
    vr,
    `
    <speak>
      <prosody rate="95%" pitch="+1st">
        Hi there.
      </prosody>
      <break time="400ms"/>
      You’ve reached ${tenant.businessName}.
      <break time="300ms"/>
      I’m your virtual receptionist.
      <break time="250ms"/>
      How can I help you today?
    </speak>
    `
  );
  // Gather initial speech
  const action = buildAbsoluteUrl(req, `/webhooks/twilio/handle-speech`);
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
  
  const callSid = req.body.CallSid || "unknown";
  const speech = (req.body.SpeechResult || "").trim();
  const confidence = req.body.Confidence ? Number(req.body.Confidence) : undefined;

  const lower = speech.toLowerCase();
  const to = req.body.To || req.body.Called;
  const tenant = resolveTenantByTwilioNumber(to);
  const tenantId = tenant.id;
  

  req.log.info({ tenantId, callSid, speech, confidence }, "Speech received");

  const vr = new twiml.VoiceResponse();

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

    req.log.info({ tenantId, handoffNumber: tenant.handoffNumber }, "Handoff number check");

    if (!tenant.handoffNumber || !tenant.handoffNumber.startsWith("+")) {
      say(vr, "I can’t transfer right now. Please leave your number and we’ll call you back.");
      vr.hangup();
      return res.type("text/xml").send(vr.toString());
    }
    
    vr.dial(tenant.handoffNumber);
    return res.type("text/xml").send(vr.toString());
  }
 
  
  let kb;
  try {
    kb = loadKnowledgeBase(tenant.knowledgeBaseId);
  } catch (err) {
    // req.log.error({ e, tenantId: tenant.id }, "KB load failed");
    // say(vr, "Sorry, our system is having trouble right now. Please try again later.");
    // vr.hangup();
    // return res.type("text/xml").send(vr.toString());

    req.log.error({ err, knowledgeBaseId: tenant.knowledgeBaseId, tenantId }, "KB load failed");

  }
  
  const answer = kb ? answerFromKB(kb, speech) : null;

  if (answer) {
    say(vr, answer);
  } else {
    say(vr, "Sorry, I’m having trouble accessing the business info right now. Let me connect you to the owner.");
    if (tenant.handoffNumber?.startsWith("+")) {
      vr.dial(tenant.handoffNumber);
      return res.type("text/xml").send(vr.toString());
    }
    say(vr, "Please call again later. Goodbye.");
    vr.hangup();
    return res.type("text/xml").send(vr.toString());
  }



  // Loop another gather to keep the call going
  const action = buildAbsoluteUrl(req, `/webhooks/twilio/handle-speech`);
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