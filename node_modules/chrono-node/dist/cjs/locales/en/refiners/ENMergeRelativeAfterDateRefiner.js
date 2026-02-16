"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const abstractRefiners_1 = require("../../../common/abstractRefiners");
const results_1 = require("../../../results");
const constants_1 = require("../constants");
const duration_1 = require("../../../calculation/duration");
function IsPositiveFollowingReference(result) {
    return result.text.match(/^[+-]/i) != null;
}
function IsNegativeFollowingReference(result) {
    return result.text.match(/^-/i) != null;
}
class ENMergeRelativeAfterDateRefiner extends abstractRefiners_1.MergingRefiner {
    shouldMergeResults(textBetween, currentResult, nextResult) {
        if (!textBetween.match(/^\s*$/i)) {
            return false;
        }
        return IsPositiveFollowingReference(nextResult) || IsNegativeFollowingReference(nextResult);
    }
    mergeResults(textBetween, currentResult, nextResult, context) {
        let timeUnits = (0, constants_1.parseDuration)(nextResult.text);
        if (IsNegativeFollowingReference(nextResult)) {
            timeUnits = (0, duration_1.reverseDuration)(timeUnits);
        }
        const components = results_1.ParsingComponents.createRelativeFromReference(results_1.ReferenceWithTimezone.fromDate(currentResult.start.date()), timeUnits);
        return new results_1.ParsingResult(currentResult.reference, currentResult.index, `${currentResult.text}${textBetween}${nextResult.text}`, components);
    }
}
exports.default = ENMergeRelativeAfterDateRefiner;
//# sourceMappingURL=ENMergeRelativeAfterDateRefiner.js.map