import { TIME_UNITS_PATTERN, parseDuration, TIME_UNITS_NO_ABBR_PATTERN } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { reverseDuration } from "../../../calculation/duration.js";
const PATTERN = new RegExp(`(denna|den här|förra|passerade|nästa|kommande|efter|\\+|-)\\s*(${TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
const PATTERN_NO_ABBR = new RegExp(`(denna|den här|förra|passerade|nästa|kommande|efter|\\+|-)\\s*(${TIME_UNITS_NO_ABBR_PATTERN})(?=\\W|$)`, "i");
export default class SVTimeUnitCasualRelativeFormatParser extends AbstractParserWithWordBoundaryChecking {
    allowAbbreviations;
    constructor(allowAbbreviations = true) {
        super();
        this.allowAbbreviations = allowAbbreviations;
    }
    innerPattern() {
        return this.allowAbbreviations ? PATTERN : PATTERN_NO_ABBR;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let duration = parseDuration(match[2]);
        if (!duration) {
            return null;
        }
        switch (prefix) {
            case "förra":
            case "passerade":
            case "-":
                duration = reverseDuration(duration);
                break;
        }
        return ParsingComponents.createRelativeFromReference(context.reference, duration);
    }
}
//# sourceMappingURL=SVTimeUnitCasualRelativeFormatParser.js.map