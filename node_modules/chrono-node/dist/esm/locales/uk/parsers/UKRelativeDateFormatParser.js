import { TIME_UNIT_DICTIONARY } from "../constants.js";
import { ParsingComponents } from "../../../results.js";
import { matchAnyPattern } from "../../../utils/pattern.js";
import { AbstractParserWithLeftRightBoundaryChecking } from "./AbstractParserWithWordBoundaryChecking.js";
const MODIFIER_WORD_GROUP = 1;
const RELATIVE_WORD_GROUP = 2;
export default class UKRelativeDateFormatParser extends AbstractParserWithLeftRightBoundaryChecking {
    innerPatternString(context) {
        return (`(в минулому|у минулому|на минулому|минулого|на наступному|в наступному|у наступному|наступного|на цьому|в цьому|у цьому|цього)\\s*` +
            `(${matchAnyPattern(TIME_UNIT_DICTIONARY)})(?=\\s*)`);
    }
    innerExtract(context, match) {
        const modifier = match[MODIFIER_WORD_GROUP].toLowerCase();
        const unitWord = match[RELATIVE_WORD_GROUP].toLowerCase();
        const timeunit = TIME_UNIT_DICTIONARY[unitWord];
        if (modifier == "на наступному" ||
            modifier == "в наступному" ||
            modifier == "у наступному" ||
            modifier == "наступного") {
            const timeUnits = {};
            timeUnits[timeunit] = 1;
            return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
        }
        if (modifier == "на минулому" ||
            modifier == "в минулому" ||
            modifier == "у минулому" ||
            modifier == "минулого") {
            const timeUnits = {};
            timeUnits[timeunit] = -1;
            return ParsingComponents.createRelativeFromReference(context.reference, timeUnits);
        }
        const components = context.createParsingComponents();
        let date = new Date(context.reference.instant.getTime());
        if (timeunit.match(/week/i)) {
            date.setDate(date.getDate() - date.getDay());
            components.imply("day", date.getDate());
            components.imply("month", date.getMonth() + 1);
            components.imply("year", date.getFullYear());
        }
        else if (timeunit.match(/month/i)) {
            date.setDate(1);
            components.imply("day", date.getDate());
            components.assign("year", date.getFullYear());
            components.assign("month", date.getMonth() + 1);
        }
        else if (timeunit.match(/year/i)) {
            date.setDate(1);
            date.setMonth(0);
            components.imply("day", date.getDate());
            components.imply("month", date.getMonth() + 1);
            components.assign("year", date.getFullYear());
        }
        return components;
    }
}
//# sourceMappingURL=UKRelativeDateFormatParser.js.map