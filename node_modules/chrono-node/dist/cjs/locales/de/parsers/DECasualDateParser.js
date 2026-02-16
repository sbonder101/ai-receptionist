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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const AbstractParserWithWordBoundary_1 = require("../../../common/parsers/AbstractParserWithWordBoundary");
const dates_1 = require("../../../utils/dates");
const DECasualTimeParser_1 = __importDefault(require("./DECasualTimeParser"));
const references = __importStar(require("../../../common/casualReferences"));
const duration_1 = require("../../../calculation/duration");
const PATTERN = new RegExp(`(jetzt|heute|morgen|übermorgen|uebermorgen|gestern|vorgestern|letzte\\s*nacht)` +
    `(?:\\s*(morgen|vormittag|mittags?|nachmittag|abend|nacht|mitternacht))?` +
    `(?=\\W|$)`, "i");
const DATE_GROUP = 1;
const TIME_GROUP = 2;
class DECasualDateParser extends AbstractParserWithWordBoundary_1.AbstractParserWithWordBoundaryChecking {
    innerPattern(context) {
        return PATTERN;
    }
    innerExtract(context, match) {
        let targetDate = context.reference.getDateWithAdjustedTimezone();
        const dateKeyword = (match[DATE_GROUP] || "").toLowerCase();
        const timeKeyword = (match[TIME_GROUP] || "").toLowerCase();
        let component = context.createParsingComponents();
        switch (dateKeyword) {
            case "jetzt":
                component = references.now(context.reference);
                break;
            case "heute":
                component = references.today(context.reference);
                break;
            case "morgen":
                targetDate = (0, duration_1.addDuration)(targetDate, { day: 1 });
                (0, dates_1.assignSimilarDate)(component, targetDate);
                (0, dates_1.implySimilarTime)(component, targetDate);
                break;
            case "übermorgen":
            case "uebermorgen":
                targetDate = (0, duration_1.addDuration)(targetDate, { day: 2 });
                (0, dates_1.assignSimilarDate)(component, targetDate);
                (0, dates_1.implySimilarTime)(component, targetDate);
                break;
            case "gestern":
                targetDate = (0, duration_1.addDuration)(targetDate, { day: -1 });
                (0, dates_1.assignSimilarDate)(component, targetDate);
                (0, dates_1.implySimilarTime)(component, targetDate);
                break;
            case "vorgestern":
                targetDate = (0, duration_1.addDuration)(targetDate, { day: -2 });
                (0, dates_1.assignSimilarDate)(component, targetDate);
                (0, dates_1.implySimilarTime)(component, targetDate);
                break;
            default:
                if (dateKeyword.match(/letzte\s*nacht/)) {
                    if (targetDate.getHours() > 6) {
                        targetDate = (0, duration_1.addDuration)(targetDate, { day: -1 });
                    }
                    (0, dates_1.assignSimilarDate)(component, targetDate);
                    component.imply("hour", 0);
                }
                break;
        }
        if (timeKeyword) {
            component = DECasualTimeParser_1.default.extractTimeComponents(component, timeKeyword);
        }
        return component;
    }
}
exports.default = DECasualDateParser;
//# sourceMappingURL=DECasualDateParser.js.map