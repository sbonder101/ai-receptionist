"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const index_1 = require("../../../index");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const dates_1 = require("../../../utils/dates");
const PATTERN = /(?:questo|questa)?\s{0,3}(mattina|pomeriggio|sera|notte|mezzanotte|mezzogiorno)(?=\W|$)/i;
class ITCasualTimeParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return PATTERN;
    }
    innerExtract(context, match) {
        const targetDate = context.refDate;
        const component = context.createParsingComponents();
        switch (match[1].toLowerCase()) {
            case "pomeriggio":
                component.imply("meridiem", index_1.Meridiem.PM);
                component.imply("hour", 15);
                break;
            case "sera":
            case "notte":
                component.imply("meridiem", index_1.Meridiem.PM);
                component.imply("hour", 20);
                break;
            case "mezzanotte":
                const nextDay = new Date(targetDate.getTime());
                nextDay.setDate(nextDay.getDate() + 1);
                (0, dates_1.assignSimilarDate)(component, nextDay);
                (0, dates_1.implySimilarTime)(component, nextDay);
                component.imply("hour", 0);
                component.imply("minute", 0);
                component.imply("second", 0);
                break;
            case "mattina":
                component.imply("meridiem", index_1.Meridiem.AM);
                component.imply("hour", 6);
                break;
            case "mezzogiorno":
                component.imply("meridiem", index_1.Meridiem.AM);
                component.imply("hour", 12);
                break;
        }
        return component;
    }
}
exports.default = ITCasualTimeParser;
//# sourceMappingURL=ITCasualTimeParser.js.map