"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const results_1 = require("../../../results");
const AbstractParserWithWordBoundaryChecking_1 = require("./AbstractParserWithWordBoundaryChecking");
const duration_1 = require("../../../calculation/duration");
class RUTimeUnitCasualRelativeFormatParser extends AbstractParserWithWordBoundaryChecking_1.AbstractParserWithLeftRightBoundaryChecking {
    innerPatternString(context) {
        return `(эти|последние|прошлые|следующие|после|спустя|через|\\+|-)\\s*(${constants_1.TIME_UNITS_PATTERN})`;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let timeUnits = (0, constants_1.parseDuration)(match[2]);
        switch (prefix) {
            case "последние":
            case "прошлые":
            case "-":
                timeUnits = (0, duration_1.reverseDuration)(timeUnits);
                break;
        }
        return results_1.ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
}
exports.default = RUTimeUnitCasualRelativeFormatParser;
//# sourceMappingURL=RUTimeUnitCasualRelativeFormatParser.js.map