import { object, objects, optionalString, string, strings } from '../internal/json.js';
import { LocalizedText } from './localized-text.js';
import { DialectAction, oneOf } from './names.js';

/** Corrections for a package that deviates from the standard, from dialects.json. */
export class Dialect {
    /** @internal */
    constructor(json) {
        const match = object(json, 'match');
        /** Dialect name. */
        this.name = string(json, 'name');
        /** What the dialect is for. */
        this.description = LocalizedText.from(object(json, 'description'));
        /** Namespaces that select this dialect. */
        this.namespaces = Object.freeze(match === null ? [] : strings(match, 'namespaces'));
        /** Value of header/softwareDesc that selects this dialect. */
        this.softwareDescription = match === null ? null : optionalString(match, 'softwareDesc');
        /** Corrections to apply. */
        this.corrections = Object.freeze(objects(json, 'corrections').map((c) => new DialectCorrection(c)));
        Object.freeze(this);
    }
}

/** One correction of a dialect. */
export class DialectCorrection {
    /** @internal */
    constructor(json) {
        /** Diagnostic code reported when the correction is applied. */
        this.code = string(json, 'code');
        /** What the correction does, one of {@link DialectAction}. */
        this.action = oneOf(string(json, 'action'), DialectAction, 'dialect action');
        /** XML paths the correction applies to. */
        this.paths = Object.freeze(strings(json, 'paths'));
        /** Original value (replaceNamespace). */
        this.from = optionalString(json, 'from');
        /** Replacement value (replaceNamespace). */
        this.to = optionalString(json, 'to');
        Object.freeze(this);
    }
}
