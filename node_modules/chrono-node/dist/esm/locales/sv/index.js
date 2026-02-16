import { includeCommonConfiguration } from "../../configurations.js";
import { Chrono } from "../../chrono.js";
import { ParsingResult, ParsingComponents, ReferenceWithTimezone } from "../../results.js";
import { Meridiem, Weekday } from "../../types.js";
import SlashDateFormatParser from "../../common/parsers/SlashDateFormatParser.js";
import ISOFormatParser from "../../common/parsers/ISOFormatParser.js";
import SVWeekdayParser from "./parsers/SVWeekdayParser.js";
import SVMonthNameLittleEndianParser from "./parsers/SVMonthNameLittleEndianParser.js";
import SVTimeUnitCasualRelativeFormatParser from "./parsers/SVTimeUnitCasualRelativeFormatParser.js";
import SVCasualDateParser from "./parsers/SVCasualDateParser.js";
export { Chrono, ParsingResult, ParsingComponents, ReferenceWithTimezone };
export { Meridiem, Weekday };
export const casual = new Chrono(createCasualConfiguration());
export const strict = new Chrono(createConfiguration(true));
export function parse(text, ref, option) {
    return casual.parse(text, ref, option);
}
export function parseDate(text, ref, option) {
    return casual.parseDate(text, ref, option);
}
export function createCasualConfiguration(littleEndian = true) {
    const option = createConfiguration(false, littleEndian);
    option.parsers.unshift(new SVCasualDateParser());
    return option;
}
export function createConfiguration(strictMode = true, littleEndian = true) {
    return includeCommonConfiguration({
        parsers: [
            new ISOFormatParser(),
            new SlashDateFormatParser(littleEndian),
            new SVMonthNameLittleEndianParser(),
            new SVWeekdayParser(),
            new SVTimeUnitCasualRelativeFormatParser(),
        ],
        refiners: [],
    }, strictMode);
}
//# sourceMappingURL=index.js.map