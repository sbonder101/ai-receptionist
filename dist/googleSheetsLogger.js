"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendCallLog = appendCallLog;
exports.appendBookingLog = appendBookingLog;
// googleSheetsLogger.ts
const googleapis_1 = require("googleapis");
function requiredEnv(name) {
    const v = process.env[name];
    if (!v)
        throw new Error(`Missing env var: ${name}`);
    return v;
}
function getAuth() {
    const clientEmail = requiredEnv("GOOGLE_CLIENT_EMAIL");
    const privateKeyRaw = requiredEnv("GOOGLE_PRIVATE_KEY");
    const privateKey = privateKeyRaw.replace(/\\n/g, "\n"); // Render commonly stores \n literally
    return new googleapis_1.google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
}
/**
 * Small helper: normalize tab names and prevent broken ranges.
 * If tab includes special chars/spaces, Sheets API expects it quoted: 'My Tab'!A1:H1
 */
function tabRange(tabName, a1) {
    const safeTab = /[ \-\(\)\[\]\{\}\.\,]/.test(tabName) || tabName.includes("'")
        ? `'${tabName.replace(/'/g, "''")}'`
        : tabName;
    return `${safeTab}!${a1}`;
}
async function ensureHeaderRow(sheets, spreadsheetId, tabName, headerValues, headerRangeA1 // e.g. "A1:H1"
) {
    const range = tabRange(tabName, headerRangeA1);
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const row = existing.data.values?.[0];
    if (row && row.length > 0)
        return;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: { values: [headerValues] },
    });
}
function withRetry(fn, opts) {
    const retries = opts?.retries ?? 3;
    const baseMs = opts?.baseMs ?? 400;
    return (async () => {
        let lastErr = null;
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                return await fn();
            }
            catch (e) {
                lastErr = e;
                const status = e?.code || e?.response?.status;
                const retryable = status === 429 || (typeof status === "number" && status >= 500 && status <= 599);
                if (!retryable || attempt === retries)
                    break;
                const delay = baseMs * Math.pow(2, attempt);
                await new Promise((r) => setTimeout(r, delay));
            }
        }
        throw lastErr;
    })();
}
/** -------------------------
 *  CALLS
 * ------------------------- */
async function appendCallLog(row) {
    const spreadsheetId = requiredEnv("GSHEETS_SPREADSHEET_ID");
    const tabName = process.env.GSHEETS_TAB_NAME || "Calls";
    const auth = getAuth();
    const sheets = googleapis_1.google.sheets({ version: "v4", auth });
    await withRetry(() => ensureHeaderRow(sheets, spreadsheetId, tabName, ["Timestamp", "Tenant", "CallSid", "From", "To", "Speech", "Confidence", "Outcome"], "A1:H1"));
    await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId,
        range: tabRange(tabName, "A:H"),
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
            values: [
                [
                    row.timestamp,
                    row.tenantId,
                    row.callSid,
                    row.from,
                    row.to,
                    row.speech,
                    row.confidence ?? "",
                    row.outcome,
                ],
            ],
        },
    }));
}
/** -------------------------
 *  BOOKINGS
 * ------------------------- */
async function appendBookingLog(row) {
    const spreadsheetId = requiredEnv("GSHEETS_SPREADSHEET_ID");
    const tabName = process.env.GSHEETS_BOOKINGS_TAB_NAME || "Bookings";
    const auth = getAuth();
    const sheets = googleapis_1.google.sheets({ version: "v4", auth });
    await withRetry(() => ensureHeaderRow(sheets, spreadsheetId, tabName, [
        "Timestamp",
        "Tenant",
        "CallSid",
        "From",
        "ServiceId",
        "ServiceName",
        "StartISO",
        "Status",
        "Notes",
    ], "A1:I1"));
    await withRetry(() => sheets.spreadsheets.values.append({
        spreadsheetId,
        range: tabRange(tabName, "A:I"),
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
            values: [
                [
                    row.timestamp,
                    row.tenantId,
                    row.callSid,
                    row.from,
                    row.serviceId,
                    row.serviceName,
                    row.startIso,
                    row.status,
                    row.notes ?? "",
                ],
            ],
        },
    }));
}
