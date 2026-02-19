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
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
}

function resolveCalendarId(override?: string) {
  return override || process.env.GOOGLE_CALENDAR_ID || requiredEnv("GOOGLE_CALENDAR_ID");
}

/**
 * Create booking event on Google Calendar.
 * IMPORTANT: Share the target calendar with the service account (GOOGLE_CLIENT_EMAIL).
 */
export async function createBookingEvent(
  title: string,
  description: string,
  startIsoUtc: string,
  endIsoUtc: string,
  calendarIdOverride?: string
) {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const calendarId = resolveCalendarId(calendarIdOverride);
  

  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: title,
      description,
      start: { dateTime: startIsoUtc, timeZone: "UTC" },
      end: { dateTime: endIsoUtc, timeZone: "UTC" },
    },
  });

  return res.data;
}

/**
 * Check if a given time slot is available (no conflicts) using FreeBusy.
 * Returns true if free.
 */
export async function isSlotAvailable(
  startIsoUtc: string,
  endIsoUtc: string,
  calendarIdOverride?: string
): Promise<boolean> {
  const auth = getAuth();
  const calendar = google.calendar({ version: "v3", auth });

  const calendarId = resolveCalendarId(calendarIdOverride);

  const res = await calendar.freebusy.query({
    requestBody: {
      timeMin: startIsoUtc,
      timeMax: endIsoUtc,
      items: [{ id: calendarId }],
    },
  });

  const busy = res.data.calendars?.[calendarId]?.busy || [];
  return busy.length === 0;
}

/**
 * Find next available slot starting at `startIsoUtc` by stepping forward in `stepMinutes`.
 * Returns ISO UTC of suggested start, or null if none found in the search window.
 */
export async function findNextAvailableSlot(
  startIsoUtc: string,
  durationMin: number,
  calendarIdOverride?: string,
  opts?: { daysToSearch?: number; stepMinutes?: number }
): Promise<string | null> {
  const daysToSearch = opts?.daysToSearch ?? 7;
  const stepMinutes = opts?.stepMinutes ?? 30;

  let cursor = DateTime.fromISO(startIsoUtc, { zone: "utc" });
  const endSearch = cursor.plus({ days: daysToSearch });

  while (cursor < endSearch) {
    const start = cursor.toUTC().toISO()!;
    const end = cursor.plus({ minutes: durationMin }).toUTC().toISO()!;
    const ok = await isSlotAvailable(start, end, calendarIdOverride);
    if (ok) return start;
    cursor = cursor.plus({ minutes: stepMinutes });
  }

  return null;
}
