"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const results_1 = require("../../../results");
const AbstractParserWithWordBoundaryChecking_1 = require("./AbstractParserWithWordBoundaryChecking");
const duration_1 = require("../../../calculation/duration");
class UKTimeUnitAgoFormatParser extends AbstractParserWithWordBoundaryChecking_1.AbstractParserWithLeftBoundaryChecking {
    innerPatternString(context) {
        return `(${constants_1.TIME_UNITS_PATTERN})\\s{0,5}тому(?=(?:\\W|$))`;
    }
    innerExtract(context, match) {
        const timeUnits = (0, constants_1.parseDuration)(match[1]);
        const outputTimeUnits = (0, duration_1.reverseDuration)(timeUnits);
        return results_1.ParsingComponents.createRelativeFromReference(context.reference, outputTimeUnits);
    }
}
exports.default = UKTimeUnitAgoFormatParser;
//# sourceMappingURL=UKTimeUnitAgoFormatParser.js.map