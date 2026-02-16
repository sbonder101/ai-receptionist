import { TIME_UNITS_PATTERN, parseDuration } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithLeftRightBoundaryChecking } from "./AbstractParserWithWordBoundaryChecking.js";
import { reverseDuration } from "../../../calculation/duration.js";
export default class UKTimeUnitCasualRelativeFormatParser extends AbstractParserWithLeftRightBoundaryChecking {
    innerPatternString(context) {
        return `(ці|останні|минулі|майбутні|наступні|після|через|\\+|-)\\s*(${TIME_UNITS_PATTERN})`;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let timeUnits = parseDuration(match[3]);
        switch (prefix) {
            case "останні":
            case "минулі":
            case "-":
                timeUnits = reverseDuration(timeUnits);
                break;
        }
        return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
}
//# sourceMappingURL=UKTimeUnitCasualRelativeFormatParser.js.map