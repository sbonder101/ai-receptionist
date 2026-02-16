import { Duration } from "../../calculation/duration.js";
import { Timeunit } from "../../types.js";
export declare const WEEKDAY_DICTIONARY: {
    [word: string]: number;
};
export declare const MONTH_DICTIONARY: {
    [word: string]: number;
};
export declare const ORDINAL_NUMBER_DICTIONARY: {
    [word: string]: number;
};
export declare const INTEGER_WORD_DICTIONARY: {
    [word: string]: number;
};
export declare const TIME_UNIT_DICTIONARY: {
    [word: string]: Timeunit;
};
export declare const TIME_UNIT_NO_ABBR_DICTIONARY: {
    [word: string]: Timeunit;
};
export declare function parseDuration(timeunitText: any): Duration;
export declare const NUMBER_PATTERN: string;
export declare const ORDINAL_NUMBER_PATTERN: string;
export declare const TIME_UNIT_PATTERN: string;
export declare const TIME_UNITS_PATTERN: string;
export declare const TIME_UNITS_NO_ABBR_PATTERN: string;
export declare function parseNumberPattern(match: string): number;
export declare function parseOrdinalNumberPattern(match: string): number;
export declare function parseYear(match: string): number;
