import { parseDuration, TIME_UNITS_PATTERN } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithLeftBoundaryChecking } from "./AbstractParserWithWordBoundaryChecking.js";
import { reverseDuration } from "../../../calculation/duration.js";
export default class UKTimeUnitAgoFormatParser extends AbstractParserWithLeftBoundaryChecking {
    innerPatternString(context) {
        return `(${TIME_UNITS_PATTERN})\\s{0,5}тому(?=(?:\\W|$))`;
    }
    innerExtract(context, match) {
        const timeUnits = parseDuration(match[1]);
        const outputTimeUnits = reverseDuration(timeUnits);
        return ParsingComponents.createRelativeFromReference(context.reference, outputTimeUnits);
    }
}
//# sourceMappingURL=UKTimeUnitAgoFormatParser.js.map