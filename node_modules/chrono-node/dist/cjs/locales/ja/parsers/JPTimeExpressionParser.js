"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const types_1 = require("../../../types");
const constants_1 = require("../constants");
const FIRST_REG_PATTERN = new RegExp("(?:" +
    "(午前|午後|A.M.|P.M.|AM|PM)" +
    ")?" +
    "(?:[\\s,，、]*)" +
    "(?:([0-9０-９]+|[" +
    Object.keys(constants_1.NUMBER).join("") +
    "]+)(?:\\s*)(?:時(?!間)|:|：)" +
    "(?:\\s*)" +
    "([0-9０-９]+|半|[" +
    Object.keys(constants_1.NUMBER).join("") +
    "]+)?(?:\\s*)(?:分|:|：)?" +
    "(?:\\s*)" +
    "([0-9０-９]+|[" +
    Object.keys(constants_1.NUMBER).join("") +
    "]+)?(?:\\s*)(?:秒)?)" +
    "(?:\\s*(A.M.|P.M.|AM?|PM?))?", "i");
const SECOND_REG_PATTERN = new RegExp("(?:^\\s*(?:から|\\-|\\–|\\－|\\~|\\〜)\\s*)" +
    "(?:" +
    "(午前|午後|A.M.|P.M.|AM|PM)" +
    ")?" +
    "(?:[\\s,，、]*)" +
    "(?:([0-9０-９]+|[" +
    Object.keys(constants_1.NUMBER).join("") +
    "]+)(?:\\s*)(?:時|:|：)" +
    "(?:\\s*)" +
    "([0-9０-９]+|半|[" +
    Object.keys(constants_1.NUMBER).join("") +
    "]+)?(?:\\s*)(?:分|:|：)?" +
    "(?:\\s*)" +
    "([0-9０-９]+|[" +
    Object.keys(constants_1.NUMBER).join("") +
    "]+)?(?:\\s*)(?:秒)?)" +
    "(?:\\s*(A.M.|P.M.|AM?|PM?))?", "i");
const AM_PM_HOUR_GROUP_1 = 1;
const HOUR_GROUP = 2;
const MINUTE_GROUP = 3;
const SECOND_GROUP = 4;
const AM_PM_HOUR_GROUP_2 = 5;
class JPTimeExpressionParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern() {
        return FIRST_REG_PATTERN;
    }
    innerExtract(context, match) {
        var _a, _b;
        if (match.index > 0 && context.text[match.index - 1].match(/\w/)) {
            return null;
        }
        const result = context.createParsingResult(match.index, match[0]);
        result.start = createTimeComponents(context, match[HOUR_GROUP], match[MINUTE_GROUP], match[SECOND_GROUP], (_a = match[AM_PM_HOUR_GROUP_1]) !== null && _a !== void 0 ? _a : match[AM_PM_HOUR_GROUP_2]);
        if (!result.start) {
            match.index += match[0].length;
            return null;
        }
        match = SECOND_REG_PATTERN.exec(context.text.substring(result.index + result.text.length));
        if (!match) {
            return result;
        }
        result.text = result.text + match[0];
        result.end = createTimeComponents(context, match[HOUR_GROUP], match[MINUTE_GROUP], match[SECOND_GROUP], (_b = match[AM_PM_HOUR_GROUP_1]) !== null && _b !== void 0 ? _b : match[AM_PM_HOUR_GROUP_2]);
        if (!result.end) {
            return null;
        }
        if (!result.end.isCertain("meridiem") && result.start.isCertain("meridiem")) {
            result.end.imply("meridiem", result.start.get("meridiem"));
            if (result.start.get("meridiem") === types_1.Meridiem.PM) {
                if (result.start.get("hour") - 12 > result.end.get("hour")) {
                    result.end.imply("meridiem", types_1.Meridiem.AM);
                }
                else if (result.end.get("hour") < 12) {
                    result.end.assign("hour", result.end.get("hour") + 12);
                }
            }
        }
        if (result.end.date().getTime() < result.start.date().getTime()) {
            result.end.imply("day", result.end.get("day") + 1);
        }
        return result;
    }
}
exports.default = JPTimeExpressionParser;
function createTimeComponents(context, matchHour, matchMinute, matchSecond, matchAmPm) {
    let hour = 0;
    let meridiem = -1;
    let targetComponents = context.createParsingComponents();
    hour = parseInt((0, constants_1.toHankaku)(matchHour));
    if (isNaN(hour)) {
        hour = (0, constants_1.jaStringToNumber)(matchHour);
    }
    if (hour > 24) {
        return null;
    }
    if (matchMinute) {
        let minute;
        if (matchMinute === "半") {
            minute = 30;
        }
        else {
            minute = parseInt((0, constants_1.toHankaku)(matchMinute));
            if (isNaN(minute)) {
                minute = (0, constants_1.jaStringToNumber)(matchMinute);
            }
        }
        if (minute >= 60)
            return null;
        targetComponents.assign("minute", minute);
    }
    if (matchSecond) {
        let second = parseInt((0, constants_1.toHankaku)(matchSecond));
        if (isNaN(second)) {
            second = (0, constants_1.jaStringToNumber)(matchSecond);
        }
        if (second >= 60)
            return null;
        targetComponents.assign("second", second);
    }
    if (matchAmPm) {
        if (hour > 12) {
            return null;
        }
        const AMPMString = matchAmPm;
        if (AMPMString === "午前" || AMPMString[0].toLowerCase() === "a") {
            meridiem = types_1.Meridiem.AM;
            if (hour === 12)
                hour = 0;
        }
        else if (AMPMString === "午後" || AMPMString[0].toLowerCase() === "p") {
            meridiem = types_1.Meridiem.PM;
            if (hour != 12)
                hour += 12;
        }
    }
    targetComponents.assign("hour", hour);
    if (meridiem >= 0) {
        targetComponents.assign("meridiem", meridiem);
    }
    else {
        if (hour < 12) {
            targetComponents.imply("meridiem", types_1.Meridiem.AM);
        }
        else {
            targetComponents.imply("meridiem", types_1.Meridiem.PM);
        }
    }
    return targetComponents;
}
//# sourceMappingURL=JPTimeExpressionParser.js.map