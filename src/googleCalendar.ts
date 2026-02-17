import { google } from "googleapis";
import { DateTime } from "luxon";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getAuth() {
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

function calendarClient() {
  const auth = getAuth();
  return google.calendar({ version: "v3", auth });
}

export async function isSlotAvailable(args: {
  calendarId: string;
  startIsoUtc: string;
  endIsoUtc: string;
  timeZone: string;
}): Promise<boolean> {
  const cal = calendarClient();

  const resp = await cal.freebusy.query({
    requestBody: {
      timeMin: args.startIsoUtc,
      timeMax: args.endIsoUtc,
      timeZone: args.timeZone,
      items: [{ id: args.calendarId }],
    },
  });

  const busy = resp.data.calendars?.[args.calendarId]?.busy || [];
  return busy.length === 0;
}

export async function createBookingEvent(args: {
  calendarId: string;
  tenantId: string;
  callSid: string;
  customerName: string;
  customerPhone: string;
  serviceName: string;
  startIsoUtc: string;
  endIsoUtc: string;
  timeZone: string;
  priceZar?: number;
}) {
  const cal = calendarClient();

  const priceLine =
    typeof args.priceZar === "number" ? `Price: ZAR ${args.priceZar}` : "Price: on request";

  const summary = `${args.serviceName} — ${args.customerName || args.customerPhone}`;
  const description = [
    `Tenant: ${args.tenantId}`,
    `CallSid: ${args.callSid}`,
    `Customer: ${args.customerName}`,
    `Phone: ${args.customerPhone}`,
    `Service: ${args.serviceName}`,
    priceLine,
  ]
    .filter(Boolean)
    .join("\n");

  await cal.events.insert({
    calendarId: args.calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: args.startIsoUtc, timeZone: "UTC" },
      end: { dateTime: args.endIsoUtc, timeZone: "UTC" },
      extendedProperties: {
        private: {
          tenantId: args.tenantId,
          callSid: args.callSid,
          phone: args.customerPhone,
        },
      },
    },
  });
}

/**
 * Find next available slot after a starting point.
 * - looks ahead a limited number of days
 * - steps forward in increments (slotSize)
 */
export async function findNextAvailableSlot(args: {
  calendarId: string;
  startIsoUtc: string;
  durationMin: number;
  timeZone: string;
  lookAheadDays: number;
  stepMin: number;
}): Promise<string | null> {
  const start = DateTime.fromISO(args.startIsoUtc, { zone: "utc" });
  const endLimit = start.plus({ days: args.lookAheadDays });

  let cursor = start;

  while (cursor < endLimit) {
    const end = cursor.plus({ minutes: args.durationMin });
    const ok = await isSlotAvailable({
      calendarId: args.calendarId,
      startIsoUtc: cursor.toISO()!,
      endIsoUtc: end.toISO()!,
      timeZone: args.timeZone,
    });
    if (ok) return cursor.toISO()!;
    cursor = cursor.plus({ minutes: args.stepMin });
  }

  return null;
}
