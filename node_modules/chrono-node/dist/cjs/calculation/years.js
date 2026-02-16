"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.findMostLikelyADYear = findMostLikelyADYear;
exports.findYearClosestToRef = findYearClosestToRef;
const duration_1 = require("./duration");
function findMostLikelyADYear(yearNumber) {
    if (yearNumber < 100) {
        if (yearNumber > 50) {
            yearNumber = yearNumber + 1900;
        }
        else {
            yearNumber = yearNumber + 2000;
        }
    }
    return yearNumber;
}
function findYearClosestToRef(refDate, day, month) {
    let date = new Date(refDate);
    date.setMonth(month - 1);
    date.setDate(day);
    const nextYear = (0, duration_1.addDuration)(date, { "year": 1 });
    const lastYear = (0, duration_1.addDuration)(date, { "year": -1 });
    if (Math.abs(nextYear.getTime() - refDate.getTime()) < Math.abs(date.getTime() - refDate.getTime())) {
        date = nextYear;
    }
    else if (Math.abs(lastYear.getTime() - refDate.getTime()) < Math.abs(date.getTime() - refDate.getTime())) {
        date = lastYear;
    }
    return date.getFullYear();
}
//# sourceMappingURL=years.js.map