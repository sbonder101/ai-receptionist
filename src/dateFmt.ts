const DEFAULT_TZ = process.env.BOOKING_TIMEZONE || "Africa/Johannesburg";

export function formatBookingDateTime(startISO: string, tz = DEFAULT_TZ) {
  const d = new Date(startISO);
  if (Number.isNaN(d.getTime())) {
    return { dateText: "the selected date", timeText: "the selected time" };
  }

  const dateText = new Intl.DateTimeFormat("en-ZA", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);

  // IMPORTANT: no timeZoneName here, so it won’t say GMT+2 / SAST.
  const timeText = new Intl.DateTimeFormat("en-ZA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(d);

  return { dateText, timeText };
}