"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const results_1 = require("../../../results");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const pattern_1 = require("../../../utils/pattern");
const PATTERN = new RegExp(`(questo|ultimo|scorso|prossimo|dopo\\s*questo|questa|ultima|scorsa|prossima\\s*questa)\\s*(${(0, pattern_1.matchAnyPattern)(constants_1.TIME_UNIT_DICTIONARY)})(?=\\s*)` + "(?=\\W|$)", "i");
const MODIFIER_WORD_GROUP = 1;
const RELATIVE_WORD_GROUP = 2;
class ITRelativeDateFormatParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context, match) {
        const modifier = match[MODIFIER_WORD_GROUP].toLowerCase();
        const unitWord = match[RELATIVE_WORD_GROUP].toLowerCase();
        const timeunit = constants_1.TIME_UNIT_DICTIONARY[unitWord];
        if (modifier == "prossimo" || modifier.startsWith("dopo")) {
            const timeUnits = {};
            timeUnits[timeunit] = 1;
            return results_1.ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
        }
        if (modifier == "prima" || modifier == "precedente") {
            const timeUnits = {};
            timeUnits[timeunit] = -1;
            return results_1.ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
        }
        const components = context.createParsingComponents();
        let date = new Date(context.reference.instant.getTime());
        if (unitWord.match(/settimana/i)) {
            date.setDate(date.getDate() - date.getDay());
            components.imply("day", date.getDate());
            components.imply("month", date.getMonth() + 1);
            components.imply("year", date.getFullYear());
        }
        else if (unitWord.match(/mese/i)) {
            date.setDate(1);
            components.imply("day", date.getDate());
            components.assign("year", date.getFullYear());
            components.assign("month", date.getMonth() + 1);
        }
        else if (unitWord.match(/anno/i)) {
            date.setDate(1);
            date.setMonth(0);
            components.imply("day", date.getDate());
            components.imply("month", date.getMonth() + 1);
            components.assign("year", date.getFullYear());
        }
        return components;
    }
}
exports.default = ITRelativeDateFormatParser;
//# sourceMappingURL=ITRelativeDateFormatParser.js.map