"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const results_1 = require("../../../results");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const duration_1 = require("../../../calculation/duration");
class FRTimeUnitAgoFormatParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    constructor() {
        super();
    }
    innerPattern() {
        return new RegExp(`il y a\\s*(${constants_1.TIME_UNITS_PATTERN})(?=(?:\\W|$))`, "i");
    }
    innerExtract(context, match) {
        const timeUnits = (0, constants_1.parseDuration)(match[1]);
        const outputTimeUnits = (0, duration_1.reverseDuration)(timeUnits);
        return results_1.ParsingComponents.createRelativeFromReference(context.reference, outputTimeUnits);
    }
}
exports.default = FRTimeUnitAgoFormatParser;
//# sourceMappingURL=FRTimeUnitAgoFormatParser.js.map