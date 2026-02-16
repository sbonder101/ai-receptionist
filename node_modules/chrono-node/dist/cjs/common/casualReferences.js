"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.now = now;
exports.today = today;
exports.yesterday = yesterday;
exports.tomorrow = tomorrow;
exports.theDayBefore = theDayBefore;
exports.theDayAfter = theDayAfter;
exports.tonight = tonight;
exports.lastNight = lastNight;
exports.evening = evening;
exports.yesterdayEvening = yesterdayEvening;
exports.midnight = midnight;
exports.morning = morning;
exports.afternoon = afternoon;
exports.noon = noon;
const results_1 = require("../results");
const dates_1 = require("../utils/dates");
const types_1 = require("../types");
function now(reference) {
    const targetDate = reference.getDateWithAdjustedTimezone();
    const component = new results_1.ParsingComponents(reference, {});
    (0, dates_1.assignSimilarDate)(component, targetDate);
    (0, dates_1.assignSimilarTime)(component, targetDate);
    component.assign("timezoneOffset", reference.getTimezoneOffset());
    component.addTag("casualReference/now");
    return component;
}
function today(reference) {
    const targetDate = reference.getDateWithAdjustedTimezone();
    const component = new results_1.ParsingComponents(reference, {});
    (0, dates_1.assignSimilarDate)(component, targetDate);
    (0, dates_1.implySimilarTime)(component, targetDate);
    component.delete("meridiem");
    component.addTag("casualReference/today");
    return component;
}
function yesterday(reference) {
    return theDayBefore(reference, 1).addTag("casualReference/yesterday");
}
function tomorrow(reference) {
    return theDayAfter(reference, 1).addTag("casualReference/tomorrow");
}
function theDayBefore(reference, numDay) {
    return theDayAfter(reference, -numDay);
}
function theDayAfter(reference, nDays) {
    const targetDate = reference.getDateWithAdjustedTimezone();
    const component = new results_1.ParsingComponents(reference, {});
    const newDate = new Date(targetDate.getTime());
    newDate.setDate(newDate.getDate() + nDays);
    (0, dates_1.assignSimilarDate)(component, newDate);
    (0, dates_1.implySimilarTime)(component, newDate);
    component.delete("meridiem");
    return component;
}
function tonight(reference, implyHour = 22) {
    const targetDate = reference.getDateWithAdjustedTimezone();
    const component = new results_1.ParsingComponents(reference, {});
    (0, dates_1.assignSimilarDate)(component, targetDate);
    component.imply("hour", implyHour);
    component.imply("meridiem", types_1.Meridiem.PM);
    component.addTag("casualReference/tonight");
    return component;
}
function lastNight(reference, implyHour = 0) {
    let targetDate = reference.getDateWithAdjustedTimezone();
    const component = new results_1.ParsingComponents(reference, {});
    if (targetDate.getHours() < 6) {
        targetDate = new Date(targetDate.getTime() - 24 * 60 * 60 * 1000);
    }
    (0, dates_1.assignSimilarDate)(component, targetDate);
    component.imply("hour", implyHour);
    return component;
}
function evening(reference, implyHour = 20) {
    const component = new results_1.ParsingComponents(reference, {});
    component.imply("meridiem", types_1.Meridiem.PM);
    component.imply("hour", implyHour);
    component.addTag("casualReference/evening");
    return component;
}
function yesterdayEvening(reference, implyHour = 20) {
    let targetDate = reference.getDateWithAdjustedTimezone();
    const component = new results_1.ParsingComponents(reference, {});
    targetDate = new Date(targetDate.getTime() - 24 * 60 * 60 * 1000);
    (0, dates_1.assignSimilarDate)(component, targetDate);
    component.imply("hour", implyHour);
    component.imply("meridiem", types_1.Meridiem.PM);
    component.addTag("casualReference/yesterday");
    component.addTag("casualReference/evening");
    return component;
}
function midnight(reference) {
    const component = new results_1.ParsingComponents(reference, {});
    if (reference.getDateWithAdjustedTimezone().getHours() > 2) {
        component.addDurationAsImplied({ day: 1 });
    }
    component.assign("hour", 0);
    component.imply("minute", 0);
    component.imply("second", 0);
    component.imply("millisecond", 0);
    component.addTag("casualReference/midnight");
    return component;
}
function morning(reference, implyHour = 6) {
    const component = new results_1.ParsingComponents(reference, {});
    component.imply("meridiem", types_1.Meridiem.AM);
    component.imply("hour", implyHour);
    component.imply("minute", 0);
    component.imply("second", 0);
    component.imply("millisecond", 0);
    component.addTag("casualReference/morning");
    return component;
}
function afternoon(reference, implyHour = 15) {
    const component = new results_1.ParsingComponents(reference, {});
    component.imply("meridiem", types_1.Meridiem.PM);
    component.imply("hour", implyHour);
    component.imply("minute", 0);
    component.imply("second", 0);
    component.imply("millisecond", 0);
    component.addTag("casualReference/afternoon");
    return component;
}
function noon(reference) {
    const component = new results_1.ParsingComponents(reference, {});
    component.imply("meridiem", types_1.Meridiem.AM);
    component.assign("hour", 12);
    component.imply("minute", 0);
    component.imply("second", 0);
    component.imply("millisecond", 0);
    component.addTag("casualReference/noon");
    return component;
}
//# sourceMappingURL=casualReferences.js.map