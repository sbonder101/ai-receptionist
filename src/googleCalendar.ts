// googleCalendar.ts
import { google } from "googleapis";
import { DateTime } from "luxon";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getCalendarAuth() {
  const clientEmail = requiredEnv("GOOGLE_CLIENT_EMAIL");
  const privateKeyRaw = requiredEnv("GOOGLE_PRIVATE_KEY");
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: [
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
    ],
  });
}

export type BookingRequest = {
  calendarId: string;
  tenantId: string;
  callSid: string;
  serviceName: string;
  customerPhone: string;
  startIsoUtc: string;     // stored as UTC ISO
  durationMin: number;
  timezone: string;        // "Africa/Johannesburg"
};

export type BookingResult =
  | { ok: true; eventId: string; htmlLink?: string }
  | { ok: false; reason: "busy" | "error"; message?: string };

export async function checkCalendarBusy(args: {
  calendarId: string;
  startIsoUtc: string;
  endIsoUtc: string;
}): Promise<boolean> {
  const auth = getCalendarAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin: args.startIsoUtc,
      timeMax: args.endIsoUtc,
      items: [{ id: args.calendarId }],
    },
  });

  const busy = resp.data.calendars?.[args.calendarId]?.busy || [];
  return busy.length > 0;
}

export async function createBookingEvent(req: BookingRequest): Promise<BookingResult> {
  const auth = getCalendarAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const start = DateTime.fromISO(req.startIsoUtc, { zone: "utc" });
  if (!start.isValid) return { ok: false, reason: "error", message: "Invalid start time" };

  const end = start.plus({ minutes: req.durationMin });

  // 1) Prevent double-booking (manual events included)
  const isBusy = await checkCalendarBusy({
    calendarId: req.calendarId,
    startIsoUtc: start.toISO()!,
    endIsoUtc: end.toISO()!,
  });

  if (isBusy) return { ok: false, reason: "busy" };

  // 2) Create event
  const summary = `${req.serviceName}`;
  const description =
    `Booked via AI Receptionist\n` +
    `Tenant: ${req.tenantId}\n` +
    `CallSid: ${req.callSid}\n` +
    `Customer: ${req.customerPhone}`;

  const result = await calendar.events.insert({
    calendarId: req.calendarId,
    requestBody: {
      summary,
      description,
      start: {
        // Store with timezone so calendar shows correctly to humans
        dateTime: start.setZone(req.timezone).toISO()!,
        timeZone: req.timezone,
      },
      end: {
        dateTime: end.setZone(req.timezone).toISO()!,
        timeZone: req.timezone,
      },
      // Optional: add reminders later
    },
  });

  return { ok: true, eventId: result.data.id || "unknown", htmlLink: result.data.htmlLink || undefined };
}
