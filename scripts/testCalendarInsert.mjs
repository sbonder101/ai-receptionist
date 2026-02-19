import { google } from "googleapis";
import "dotenv/config";

async function main() {
  const calendarId = process.env.GOOGLE_CALENDAR_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!calendarId || !clientEmail || !privateKey) {
    throw new Error("Missing GOOGLE_CALENDAR_ID / GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY");
  }

  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const calendar = google.calendar({ version: "v3", auth });

  const start = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const end = new Date(Date.now() + 40 * 60 * 1000).toISOString();

  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary: "TEST - AI receptionist",
      description: "Test insert from script",
      start: { dateTime: start, timeZone: "UTC" },
      end: { dateTime: end, timeZone: "UTC" },
    },
  });

  console.log("Inserted OK:", res.data.htmlLink);
}

main().catch((e) => {
  console.error("FAILED:", e?.code, e?.response?.data || e);
  process.exit(1);
});