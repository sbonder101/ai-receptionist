import { Component, ParsedComponents, ParsedResult, ParsingReference, TimezoneAbbrMap } from "./types";
import { Duration } from "./calculation/duration";
export declare class ReferenceWithTimezone {
    readonly instant: Date;
    readonly timezoneOffset?: number | null;
    constructor(instant?: Date, timezoneOffset?: number);
    static fromDate(date: Date): ReferenceWithTimezone;
    static fromInput(input?: ParsingReference | Date, timezoneOverrides?: TimezoneAbbrMap): ReferenceWithTimezone;
    getDateWithAdjustedTimezone(): Date;
    getSystemTimezoneAdjustmentMinute(date?: Date, overrideTimezoneOffset?: number): number;
    getTimezoneOffset(): number;
}
export declare class ParsingComponents implements ParsedComponents {
    private knownValues;
    private impliedValues;
    private reference;
    private _tags;
    constructor(reference: ReferenceWithTimezone, knownComponents?: {
        [c in Component]?: number;
    });
    static createRelativeFromReference(reference: ReferenceWithTimezone, duration?: Duration): ParsingComponents;
    get(component: Component): number | null;
    isCertain(component: Component): boolean;
    getCertainComponents(): Array<Component>;
    imply(component: Component, value: number): ParsingComponents;
    assign(component: Component, value: number): ParsingComponents;
    addDurationAsImplied(duration: Duration): ParsingComponents;
    delete(components: Component | Component[]): void;
    clone(): ParsingComponents;
    isOnlyDate(): boolean;
    isOnlyTime(): boolean;
    isOnlyWeekdayComponent(): boolean;
    isDateWithUnknownYear(): boolean;
    isValidDate(): boolean;
    toString(): string;
    date(): Date;
    addTag(tag: string): ParsingComponents;
    addTags(tags: string[] | Set<string>): ParsingComponents;
    tags(): Set<string>;
    private dateWithoutTimezoneAdjustment;
}
export declare class ParsingResult implements ParsedResult {
    refDate: Date;
    index: number;
    text: string;
    reference: ReferenceWithTimezone;
    start: ParsingComponents;
    end?: ParsingComponents;
    constructor(reference: ReferenceWithTimezone, index: number, text: string, start?: ParsingComponents, end?: ParsingComponents);
    clone(): ParsingResult;
    date(): Date;
    addTag(tag: string): ParsingResult;
    addTags(tags: string[] | Set<string>): ParsingResult;
    tags(): Set<string>;
    toString(): string;
}
