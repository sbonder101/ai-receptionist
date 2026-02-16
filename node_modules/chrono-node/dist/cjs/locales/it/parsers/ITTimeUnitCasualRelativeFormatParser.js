"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const results_1 = require("../../../results");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const duration_1 = require("../../../calculation/duration");
const PATTERN = new RegExp(`(questo|ultimo|passato|prossimo|dopo|questa|ultima|passata|prossima|\\+|-)\\s*(${constants_1.TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
class ENTimeUnitCasualRelativeFormatParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let timeUnits = (0, constants_1.parseDuration)(match[2]);
        switch (prefix) {
            case "last":
            case "past":
            case "-":
                timeUnits = (0, duration_1.reverseDuration)(timeUnits);
                break;
        }
        return results_1.ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
}
exports.default = ENTimeUnitCasualRelativeFormatParser;
//# sourceMappingURL=ITTimeUnitCasualRelativeFormatParser.js.map