import { WEEKDAY_DICTIONARY } from "../constants.js";
import { matchAnyPattern } from "../../../utils/pattern.js";
import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { createParsingComponentsAtWeekday } from "../../../calculation/weekdays.js";
const PATTERN = new RegExp("(?:(?:\\,|\\(|\\（)\\s*)?" +
    "(?:på\\s*?)?" +
    "(?:(förra|senaste|nästa|kommande)\\s*)?" +
    `(${matchAnyPattern(WEEKDAY_DICTIONARY)})` +
    "(?:\\s*(?:\\,|\\)|\\）))?" +
    "(?:\\s*(förra|senaste|nästa|kommande)\\s*vecka)?" +
    "(?=\\W|$)", "i");
const PREFIX_GROUP = 1;
const SUFFIX_GROUP = 3;
const WEEKDAY_GROUP = 2;
export default class SVWeekdayParser extends AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context, match) {
        const dayOfWeek = match[WEEKDAY_GROUP].toLowerCase();
        const offset = WEEKDAY_DICTIONARY[dayOfWeek];
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
        return createParsingComponentsAtWeekday(context.reference, offset, modifier);
    }
}
//# sourceMappingURL=SVWeekdayParser.js.map