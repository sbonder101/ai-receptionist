"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createBookingEvent = createBookingEvent;
exports.isSlotAvailable = isSlotAvailable;
exports.findNextAvailableSlot = findNextAvailableSlot;
const googleapis_1 = require("googleapis");
const luxon_1 = require("luxon");
function requiredEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var: ${name}`);
    return v;
}
function getAuth() {
    const clientEmail = requiredEnv("GOOGLE_CLIENT_EMAIL");
    const privateKeyRaw = requiredEnv("GOOGLE_PRIVATE_KEY");
    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
    return new googleapis_1.google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: ["https://www.googleapis.com/auth/calendar"],
    });
}
function resolveCalendarId(override) {
    return override || process.env.GOOGLE_CALENDAR_ID || requiredEnv("GOOGLE_CALENDAR_ID");
}
/**
 * Create booking event on Google Calendar.
 * IMPORTANT: Share the target calendar with the service account (GOOGLE_CLIENT_EMAIL).
 */
async function createBookingEvent(title, description, startIsoUtc, endIsoUtc, calendarIdOverride) {
    const auth = getAuth();
    const calendar = googleapis_1.google.calendar({ version: "v3", auth });
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
async function isSlotAvailable(startIsoUtc, endIsoUtc, calendarIdOverride) {
    const auth = getAuth();
    const calendar = googleapis_1.google.calendar({ version: "v3", auth });
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
async function findNextAvailableSlot(startIsoUtc, durationMin, calendarIdOverride, opts) {
    const daysToSearch = opts?.daysToSearch ?? 7;
    const stepMinutes = opts?.stepMinutes ?? 30;
    let cursor = luxon_1.DateTime.fromISO(startIsoUtc, { zone: "utc" });
    const endSearch = cursor.plus({ days: daysToSearch });
    while (cursor < endSearch) {
        const start = cursor.toUTC().toISO();
        const end = cursor.plus({ minutes: durationMin }).toUTC().toISO();
        const ok = await isSlotAvailable(start, end, calendarIdOverride);
        if (ok)
            return start;
        cursor = cursor.plus({ minutes: stepMinutes });
    }
    return null;
}
