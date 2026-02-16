"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const types_1 = require("../../../types");
const dates_1 = require("../../../utils/dates");
const DATE_GROUP = 1;
const TIME_OF_DAY_GROUP = 2;
class NLCasualDateTimeParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
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
                (0, dates_1.assignSimilarDate)(component, previousDay);
                break;
            case "van":
                (0, dates_1.assignSimilarDate)(component, targetDate);
                break;
            case "morgen":
                const nextDay = new Date(targetDate.getTime());
                nextDay.setDate(nextDay.getDate() + 1);
                (0, dates_1.assignSimilarDate)(component, nextDay);
                (0, dates_1.implySimilarTime)(component, nextDay);
                break;
        }
        switch (timeText) {
            case "ochtend":
                component.imply("meridiem", types_1.Meridiem.AM);
                component.imply("hour", 6);
                break;
            case "middag":
                component.imply("meridiem", types_1.Meridiem.AM);
                component.imply("hour", 12);
                break;
            case "namiddag":
                component.imply("meridiem", types_1.Meridiem.PM);
                component.imply("hour", 15);
                break;
            case "avond":
                component.imply("meridiem", types_1.Meridiem.PM);
                component.imply("hour", 20);
                break;
        }
        return component;
    }
}
exports.default = NLCasualDateTimeParser;
//# sourceMappingURL=NLCasualDateTimeParser.js.map