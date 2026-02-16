import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { assignSimilarDate } from "../../../utils/dates.js";
import * as references from "../../../common/casualReferences.js";
const PATTERN = /(ora|oggi|stasera|questa sera|domani|dmn|ieri\s*sera)(?=\W|$)/i;
export default class ITCasualDateParser extends AbstractParserWithWordBoundaryChecking {
    innerPattern(context) {
        return PATTERN;
    }
    innerExtract(context, match) {
        let targetDate = context.refDate;
        const lowerText = match[0].toLowerCase();
        const component = context.createParsingComponents();
        switch (lowerText) {
            case "ora":
                return references.now(context.reference);
            case "oggi":
                return references.today(context.reference);
            case "ieri":
                return references.yesterday(context.reference);
            case "domani":
            case "dmn":
                return references.tomorrow(context.reference);
            case "stasera":
            case "questa sera":
                return references.tonight(context.reference);
            default:
                if (lowerText.match(/ieri\s*sera/)) {
                    if (targetDate.getHours() > 6) {
                        const previousDay = new Date(targetDate.getTime());
                        previousDay.setDate(previousDay.getDate() - 1);
                        targetDate = previousDay;
                    }
                    assignSimilarDate(component, targetDate);
                    component.imply("hour", 0);
                }
                break;
        }
        return component;
    }
}
//# sourceMappingURL=ITCasualDateParser.js.map