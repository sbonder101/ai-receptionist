"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const types_1 = require("../../../types");
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const dates_1 = require("../../../utils/dates");
class ESCasualTimeParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return /(?:esta\s*)?(mañana|tarde|medianoche|mediodia|mediodía|noche)(?=\W|$)/i;
    }
    innerExtract(context, match) {
        const targetDate = context.refDate;
        const component = context.createParsingComponents();
        switch (match[1].toLowerCase()) {
            case "tarde":
                component.imply("meridiem", types_1.Meridiem.PM);
                component.imply("hour", 15);
                break;
            case "noche":
                component.imply("meridiem", types_1.Meridiem.PM);
                component.imply("hour", 22);
                break;
            case "mañana":
                component.imply("meridiem", types_1.Meridiem.AM);
                component.imply("hour", 6);
                break;
            case "medianoche":
                const nextDay = new Date(targetDate.getTime());
                nextDay.setDate(nextDay.getDate() + 1);
                (0, dates_1.assignSimilarDate)(component, nextDay);
                (0, dates_1.implySimilarTime)(component, nextDay);
                component.imply("hour", 0);
                component.imply("minute", 0);
                component.imply("second", 0);
                break;
            case "mediodia":
            case "mediodía":
                component.imply("meridiem", types_1.Meridiem.AM);
                component.imply("hour", 12);
                break;
        }
        return component;
    }
}
exports.default = ESCasualTimeParser;
//# sourceMappingURL=ESCasualTimeParser.js.map