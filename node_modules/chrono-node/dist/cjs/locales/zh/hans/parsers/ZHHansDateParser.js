"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const AbstractParserWithWordBoundary_1 = require("../../../../common/parsers/AbstractParserWithWordBoundary");
const constants_1 = require("../constants");
const YEAR_GROUP = 1;
const MONTH_GROUP = 2;
const DAY_GROUP = 3;
class ZHHansDateParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return new RegExp("(" +
            "\\d{2,4}|" +
            "[" +
            Object.keys(constants_1.NUMBER).join("") +
            "]{4}|" +
            "[" +
            Object.keys(constants_1.NUMBER).join("") +
            "]{2}" +
            ")?" +
            "(?:\\s*)" +
            "(?:年)?" +
            "(?:[\\s|,|，]*)" +
            "(" +
            "\\d{1,2}|" +
            "[" +
            Object.keys(constants_1.NUMBER).join("") +
            "]{1,3}" +
            ")" +
            "(?:\\s*)" +
            "(?:月)" +
            "(?:\\s*)" +
            "(" +
            "\\d{1,2}|" +
            "[" +
            Object.keys(constants_1.NUMBER).join("") +
            "]{1,3}" +
            ")?" +
            "(?:\\s*)" +
            "(?:日|号)?");
    }
    innerExtract(context, match) {
        const result = context.createParsingResult(match.index, match[0]);
        let month = parseInt(match[MONTH_GROUP]);
        if (isNaN(month))
            month = (0, constants_1.zhStringToNumber)(match[MONTH_GROUP]);
        result.start.assign("month", month);
        if (match[DAY_GROUP]) {
            let day = parseInt(match[DAY_GROUP]);
            if (isNaN(day))
                day = (0, constants_1.zhStringToNumber)(match[DAY_GROUP]);
            result.start.assign("day", day);
        }
        else {
            result.start.imply("day", context.refDate.getDate());
        }
        if (match[YEAR_GROUP]) {
            let year = parseInt(match[YEAR_GROUP]);
            if (isNaN(year))
                year = (0, constants_1.zhStringToYear)(match[YEAR_GROUP]);
            result.start.assign("year", year);
        }
        else {
            result.start.imply("year", context.refDate.getFullYear());
        }
        return result;
    }
}
exports.default = ZHHansDateParser;
//# sourceMappingURL=ZHHansDateParser.js.map