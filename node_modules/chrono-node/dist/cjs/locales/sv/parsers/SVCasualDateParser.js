"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const dates_1 = require("../../../utils/dates");
const references = __importStar(require("../../../common/casualReferences"));
const PATTERN = new RegExp(`(nu|idag|imorgon|övermorgon|igår|förrgår|i\\s*förrgår)` +
    `(?:\\s*(?:på\\s*)?(morgonen?|förmiddagen?|middagen?|eftermiddagen?|kvällen?|natten?|midnatt))?` +
    `(?=\\W|$)`, "i");
const DATE_GROUP = 1;
const TIME_GROUP = 2;
class SVCasualDateParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern(context) {
        return PATTERN;
    }
    innerExtract(context, match) {
        const targetDate = context.refDate;
        const dateKeyword = (match[DATE_GROUP] || "").toLowerCase();
        const timeKeyword = (match[TIME_GROUP] || "").toLowerCase();
        let component = context.createParsingComponents();
        switch (dateKeyword) {
            case "nu":
                component = references.now(context.reference);
                break;
            case "idag":
                component = references.today(context.reference);
                break;
            case "imorgon":
            case "imorn":
                const nextDay = new Date(targetDate.getTime());
                nextDay.setDate(nextDay.getDate() + 1);
                (0, dates_1.assignSimilarDate)(component, nextDay);
                (0, dates_1.implySimilarTime)(component, nextDay);
                break;
            case "igår":
                const previousDay = new Date(targetDate.getTime());
                previousDay.setDate(previousDay.getDate() - 1);
                (0, dates_1.assignSimilarDate)(component, previousDay);
                (0, dates_1.implySimilarTime)(component, previousDay);
                break;
            case "förrgår":
            case "i förrgår":
                const twoDaysAgo = new Date(targetDate.getTime());
                twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
                (0, dates_1.assignSimilarDate)(component, twoDaysAgo);
                (0, dates_1.implySimilarTime)(component, twoDaysAgo);
                break;
        }
        switch (timeKeyword) {
            case "morgon":
            case "morgonen":
                component.imply("hour", 6);
                component.imply("minute", 0);
                component.imply("second", 0);
                component.imply("millisecond", 0);
                break;
            case "förmiddag":
            case "förmiddagen":
                component.imply("hour", 9);
                component.imply("minute", 0);
                component.imply("second", 0);
                component.imply("millisecond", 0);
                break;
            case "middag":
            case "middagen":
                component.imply("hour", 12);
                component.imply("minute", 0);
                component.imply("second", 0);
                component.imply("millisecond", 0);
                break;
            case "eftermiddag":
            case "eftermiddagen":
                component.imply("hour", 15);
                component.imply("minute", 0);
                component.imply("second", 0);
                component.imply("millisecond", 0);
                break;
            case "kväll":
            case "kvällen":
                component.imply("hour", 20);
                component.imply("minute", 0);
                component.imply("second", 0);
                component.imply("millisecond", 0);
                break;
            case "natt":
            case "natten":
            case "midnatt":
                if (timeKeyword === "midnatt") {
                    component.imply("hour", 0);
                }
                else {
                    component.imply("hour", 2);
                }
                component.imply("minute", 0);
                component.imply("second", 0);
                component.imply("millisecond", 0);
                break;
        }
        return component;
    }
}
exports.default = SVCasualDateParser;
//# sourceMappingURL=SVCasualDateParser.js.map