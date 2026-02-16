import { google } from "googleapis";

type CallLogRow = {
  timestamp: string;
  tenantId: string;
  callSid: string;
  from: string;
  to: string;
  speech: string;
  confidence?: number;
  outcome: string;
};

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function getAuth() {
  const clientEmail = requiredEnv("GOOGLE_CLIENT_EMAIL");
  const privateKeyRaw = requiredEnv("GOOGLE_PRIVATE_KEY");

  // Render commonly stores \n literally; convert to actual newlines:
  const privateKey = privateKeyRaw.replace(/\\n/g, "\n");

  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

async function ensureHeaderRow(sheets: any, spreadsheetId: string, tabName: string) {
  // Writes header to row 1 if empty (safe enough for demo).
  const range = `${tabName}!A1:H1`;
  const existing = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  const row = existing.data.values?.[0];

  if (row && row.length > 0) return;

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

export async function appendCallLog(row: CallLogRow) {
  const spreadsheetId = requiredEnv("GSHEETS_SPREADSHEET_ID");
  const tabName = process.env.GSHEETS_TAB_NAME || "Calls";

  const auth = getAuth();
  const sheets = google.sheets({ version: "v4", auth });

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