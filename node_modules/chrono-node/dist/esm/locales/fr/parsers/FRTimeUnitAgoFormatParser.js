import { parseDuration, TIME_UNITS_PATTERN } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { reverseDuration } from "../../../calculation/duration.js";
export default class FRTimeUnitAgoFormatParser extends AbstractParserWithWordBoundaryChecking {
    constructor() {
        super();
    }
    innerPattern() {
        return new RegExp(`il y a\\s*(${TIME_UNITS_PATTERN})(?=(?:\\W|$))`, "i");
    }
    innerExtract(context, match) {
        const timeUnits = parseDuration(match[1]);
        const outputTimeUnits = reverseDuration(timeUnits);
        return ParsingComponents.createRelativeFromReference(context.reference, outputTimeUnits);
    }
}
//# sourceMappingURL=FRTimeUnitAgoFormatParser.js.map