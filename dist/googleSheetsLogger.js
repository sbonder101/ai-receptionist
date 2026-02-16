"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.appendCallLog = appendCallLog;
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
    // Render commonly stores \n literally; convert to actual newlines:
    const privateKey = privateKeyRaw.replace(/\\n/g, "\n");
    return new googleapis_1.google.auth.JWT({
        email: clientEmail,
        key: privateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
}
async function ensureHeaderRow(sheets, spreadsheetId, tabName) {
    // Writes header to row 1 if empty (safe enough for demo).
    const range = `${tabName}!A1:H1`;
    const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
    const row = existing.data.values?.[0];
    if (row && row.length > 0)
        return;
    await sheets.spreadsheets.values.update({
        spreadsheetId,
        range,
        valueInputOption: "RAW",
        requestBody: {
            values: [[
                    "Timestamp",
                    "Tenant",
                    "CallSid",
                    "From",
                    "To",
                    "Speech",
                    "Confidence",
                    "Outcome"
                ]],
        },
    });
}
async function appendCallLog(row) {
    const spreadsheetId = requiredEnv("GSHEETS_SPREADSHEET_ID");
    const tabName = process.env.GSHEETS_TAB_NAME || "Calls";
    const auth = getAuth();
    const sheets = googleapis_1.google.sheets({ version: "v4", auth });
    await ensureHeaderRow(sheets, spreadsheetId, tabName);
    await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A:H`,
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
            values: [[
                    row.timestamp,
                    row.tenantId,
                    row.callSid,
                    row.from,
                    row.to,
                    row.speech,
                    row.confidence ?? "",
                    row.outcome,
                ]],
        },
    });
}
