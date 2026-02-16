import { parseDuration, TIME_UNITS_PATTERN } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithLeftBoundaryChecking } from "./AbstractParserWithWordBoundaryChecking.js";
import { reverseDuration } from "../../../calculation/duration.js";
export default class RUTimeUnitAgoFormatParser extends AbstractParserWithLeftBoundaryChecking {
    innerPatternString(context) {
        return `(${TIME_UNITS_PATTERN})\\s{0,5}назад(?=(?:\\W|$))`;
    }
    innerExtract(context, match) {
        const timeUnits = parseDuration(match[1]);
        const outputTimeUnits = reverseDuration(timeUnits);
        return ParsingComponents.createRelativeFromReference(context.reference, outputTimeUnits);
    }
}
//# sourceMappingURL=RUTimeUnitAgoFormatParser.js.map