import { TIME_UNITS_PATTERN, parseDuration } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { reverseDuration } from "../../../calculation/duration.js";
const PATTERN = new RegExp(`(questo|ultimo|passato|prossimo|dopo|questa|ultima|passata|prossima|\\+|-)\\s*(${TIME_UNITS_PATTERN})(?=\\W|$)`, "i");
export default class ENTimeUnitCasualRelativeFormatParser extends AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context, match) {
        const prefix = match[1].toLowerCase();
        let timeUnits = parseDuration(match[2]);
        switch (prefix) {
            case "last":
            case "past":
            case "-":
                timeUnits = reverseDuration(timeUnits);
                break;
        }
        return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
    }
}
//# sourceMappingURL=ITTimeUnitCasualRelativeFormatParser.js.map