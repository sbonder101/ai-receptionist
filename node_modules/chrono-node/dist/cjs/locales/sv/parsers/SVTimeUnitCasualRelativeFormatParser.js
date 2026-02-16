"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const constants_1 = require("../constants");
const results_1 = require("../../../results");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const duration_1 = require("../../../calculation/duration");
const PATTERN = new RegExp(`(denna|den här|förra|passerade|nästa|kommande|efter|\\+|-)\\s*(${constants_1.TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
const PATTERN_NO_ABBR = new RegExp(`(denna|den här|förra|passerade|nästa|kommande|efter|\\+|-)\\s*(${constants_1.TIME_UNITS_NO_ABBR_PATTERN})(?=\\W|$)`, "i");
class SVTimeUnitCasualRelativeFormatParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    constructor(allowAbbreviations = true) {
        super();
        this.allowAbbreviations = allowAbbreviations;
    }
    innerPattern() {
        return this.allowAbbreviations ? PATTERN : PATTERN_NO_ABBR;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let duration = (0, constants_1.parseDuration)(match[2]);
        if (!duration) {
            return null;
        }
        switch (prefix) {
            case "förra":
            case "passerade":
            case "-":
                duration = (0, duration_1.reverseDuration)(duration);
                break;
        }
        return results_1.ParsingComponents.createRelativeFromReference(context.reference, duration);
    }
}
exports.default = SVTimeUnitCasualRelativeFormatParser;
//# sourceMappingURL=SVTimeUnitCasualRelativeFormatParser.js.map