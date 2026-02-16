import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { assignSimilarDate, implySimilarTime } from "../../../utils/dates.js";
import DECasualTimeParser from "./DECasualTimeParser.js";
import * as references from "../../../common/casualReferences.js";
import { addDuration } from "../../../calculation/duration.js";
const PATTERN = new RegExp(`(jetzt|heute|morgen|übermorgen|uebermorgen|gestern|vorgestern|letzte\\s*nacht)` +
    `(?:\\s*(morgen|vormittag|mittags?|nachmittag|abend|nacht|mitternacht))?` +
    `(?=\\W|$)`, "i");
const DATE_GROUP = 1;
const TIME_GROUP = 2;
export default class DECasualDateParser extends AbstractParserWithWordBoundaryChecking {
    innerPattern(context) {
        return PATTERN;
    }
    innerExtract(context, match) {
        let targetDate = context.reference.getDateWithAdjustedTimezone();
        const dateKeyword = (match[DATE_GROUP] || "").toLowerCase();
        const timeKeyword = (match[TIME_GROUP] || "").toLowerCase();
        let component = context.createParsingComponents();
        switch (dateKeyword) {
            case "jetzt":
                component = references.now(context.reference);
                break;
            case "heute":
                component = references.today(context.reference);
                break;
            case "morgen":
                targetDate = addDuration(targetDate, { day: 1 });
                assignSimilarDate(component, targetDate);
                implySimilarTime(component, targetDate);
                break;
            case "übermorgen":
            case "uebermorgen":
                targetDate = addDuration(targetDate, { day: 2 });
                assignSimilarDate(component, targetDate);
                implySimilarTime(component, targetDate);
                break;
            case "gestern":
                targetDate = addDuration(targetDate, { day: -1 });
                assignSimilarDate(component, targetDate);
                implySimilarTime(component, targetDate);
                break;
            case "vorgestern":
                targetDate = addDuration(targetDate, { day: -2 });
                assignSimilarDate(component, targetDate);
                implySimilarTime(component, targetDate);
                break;
            default:
                if (dateKeyword.match(/letzte\s*nacht/)) {
                    if (targetDate.getHours() > 6) {
                        targetDate = addDuration(targetDate, { day: -1 });
                    }
                    assignSimilarDate(component, targetDate);
                    component.imply("hour", 0);
                }
                break;
        }
        if (timeKeyword) {
            component = DECasualTimeParser.extractTimeComponents(component, timeKeyword);
        }
        return component;
    }
}
//# sourceMappingURL=DECasualDateParser.js.map