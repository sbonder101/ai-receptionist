"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cleanName = cleanName;
exports.normalizeSpelledName = normalizeSpelledName;
const COMMON_PREFIX_RE = /^(my name is|its|it is|i am|im|this is)\s+/i;
function cleanName(raw) {
    const s = (raw ?? "")
        .trim()
        .replace(COMMON_PREFIX_RE, "")
        .replace(/[^a-zA-Z'\-\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();
    if (!s)
        return null;
    if (s.length < 2 || s.length > 40)
        return null;
    // must contain at least 2 letters
    const letters = (s.match(/[a-zA-Z]/g) || []).length;
    if (letters < 2)
        return null;
    return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
// For spelled names like "K A R A B O" or "kay a ar..."
function normalizeSpelledName(raw) {
    const s = (raw ?? "").trim();
    // If it looks like spaced letters, collapse them.
    const tokens = s.split(/\s+/).filter(Boolean);
    const singleLetters = tokens.every((t) => /^[a-zA-Z]$/.test(t));
    if (singleLetters && tokens.length >= 2) {
        return tokens.join("").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return cleanName(s);
}
