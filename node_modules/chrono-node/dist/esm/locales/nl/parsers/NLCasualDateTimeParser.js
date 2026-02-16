import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { Meridiem } from "../../../types.js";
import { assignSimilarDate, implySimilarTime } from "../../../utils/dates.js";
const DATE_GROUP = 1;
const TIME_OF_DAY_GROUP = 2;
export default class NLCasualDateTimeParser extends AbstractParserWithWordBoundaryChecking {
    innerPattern(context) {
        return /(gisteren|morgen|van)(ochtend|middag|namiddag|avond|nacht)(?=\W|$)/i;
    }
    innerExtract(context, match) {
        const dateText = match[DATE_GROUP].toLowerCase();
        const timeText = match[TIME_OF_DAY_GROUP].toLowerCase();
        const component = context.createParsingComponents();
        const targetDate = context.refDate;
        switch (dateText) {
            case "gisteren":
                const previousDay = new Date(targetDate.getTime());
                previousDay.setDate(previousDay.getDate() - 1);
                assignSimilarDate(component, previousDay);
                break;
            case "van":
                assignSimilarDate(component, targetDate);
                break;
            case "morgen":
                const nextDay = new Date(targetDate.getTime());
                nextDay.setDate(nextDay.getDate() + 1);
                assignSimilarDate(component, nextDay);
                implySimilarTime(component, nextDay);
                break;
        }
        switch (timeText) {
            case "ochtend":
                component.imply("meridiem", Meridiem.AM);
                component.imply("hour", 6);
                break;
            case "middag":
                component.imply("meridiem", Meridiem.AM);
                component.imply("hour", 12);
                break;
            case "namiddag":
                component.imply("meridiem", Meridiem.PM);
                component.imply("hour", 15);
                break;
            case "avond":
                component.imply("meridiem", Meridiem.PM);
                component.imply("hour", 20);
                break;
        }
        return component;
    }
}
//# sourceMappingURL=NLCasualDateTimeParser.js.map