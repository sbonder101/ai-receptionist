"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const pattern_1 = require("../../../utils/pattern");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const weekdays_1 = require("../../../calculation/weekdays");
const PATTERN = new RegExp("(?:(?:\\,|\\(|\\（)\\s*)?" +
    "(?:på\\s*?)?" +
    "(?:(förra|senaste|nästa|kommande)\\s*)?" +
    `(${(0, pattern_1.matchAnyPattern)(constants_1.WEEKDAY_DICTIONARY)})` +
    "(?:\\s*(?:\\,|\\)|\\）))?" +
    "(?:\\s*(förra|senaste|nästa|kommande)\\s*vecka)?" +
    "(?=\\W|$)", "i");
const PREFIX_GROUP = 1;
const SUFFIX_GROUP = 3;
const WEEKDAY_GROUP = 2;
class SVWeekdayParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context, match) {
        const dayOfWeek = match[WEEKDAY_GROUP].toLowerCase();
        const offset = constants_1.WEEKDAY_DICTIONARY[dayOfWeek];
        const prefix = match[PREFIX_GROUP];
        const postfix = match[SUFFIX_GROUP];
        let modifierWord = prefix || postfix;
        modifierWord = modifierWord || "";
        modifierWord = modifierWord.toLowerCase();
        let modifier = null;
        if (modifierWord.match(/förra|senaste/)) {
            modifier = "last";
        }
        else if (modifierWord.match(/nästa|kommande/)) {
            modifier = "next";
        }
        return (0, weekdays_1.createParsingComponentsAtWeekday)(context.reference, offset, modifier);
    }
}
exports.default = SVWeekdayParser;
//# sourceMappingURL=SVWeekdayParser.js.map