import { Meridiem } from "../../../types.js";
import { AbstractParserWithWordBoundaryChecking } from "../../../common/parsers/AbstractParserWithWordBoundary.js";
import { assignSimilarDate, implySimilarTime } from "../../../utils/dates.js";
export default class PTCasualTimeParser extends AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return /(?:esta\s*)?(manha|manhã|tarde|meia-noite|meio-dia|noite)(?=\W|$)/i;
    }
    innerExtract(context, match) {
        const targetDate = context.refDate;
        const component = context.createParsingComponents();
        switch (match[1].toLowerCase()) {
            case "tarde":
                component.imply("meridiem", Meridiem.PM);
                component.imply("hour", 15);
                break;
            case "noite":
                component.imply("meridiem", Meridiem.PM);
                component.imply("hour", 22);
                break;
            case "manha":
            case "manhã":
                component.imply("meridiem", Meridiem.AM);
                component.imply("hour", 6);
                break;
            case "meia-noite":
                const nextDay = new Date(targetDate.getTime());
                nextDay.setDate(nextDay.getDate() + 1);
                assignSimilarDate(component, nextDay);
                implySimilarTime(component, nextDay);
                component.imply("hour", 0);
                component.imply("minute", 0);
                component.imply("second", 0);
                break;
            case "meio-dia":
                component.imply("meridiem", Meridiem.AM);
                component.imply("hour", 12);
                break;
        }
        return component;
    }
}
//# sourceMappingURL=PTCasualTimeParser.js.map