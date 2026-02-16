import { TIME_UNITS_PATTERN, parseDuration } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithLeftRightBoundaryChecking } from "./AbstractParserWithWordBoundaryChecking.js";
import { reverseDuration } from "../../../calculation/duration.js";
export default class RUTimeUnitCasualRelativeFormatParser extends AbstractParserWithLeftRightBoundaryChecking {
    innerPatternString(context) {
        return `(эти|последние|прошлые|следующие|после|спустя|через|\\+|-)\\s*(${TIME_UNITS_PATTERN})`;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let timeUnits = parseDuration(match[2]);
        switch (prefix) {
            case "последние":
            case "прошлые":
            case "-":
                timeUnits = reverseDuration(timeUnits);
                break;
        }
        return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
}
//# sourceMappingURL=RUTimeUnitCasualRelativeFormatParser.js.map