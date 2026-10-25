import { isObject, object, string } from '../internal/json.js';
import { LocalizedText } from './localized-text.js';

/** Documentation of a table, column or flattened group, from definition.json. */
export class ElementDefinition {
    /** @internal */
    constructor(json) {
        /** "tr_line" (table), "tr_line.amnt" (column) or "tr_line.currency" (group). */
        this.key = string(json, 'key');
        /** "table", "column" or "group". */
        this.kind = string(json, 'kind');
        /** Official name, usually English only. */
        this.label = LocalizedText.from(object(json, 'label'));
        /** Meaning according to the official documentation. */
        this.definition = LocalizedText.from(object(json, 'definition'));
        /** Practical explanation. */
        this.description = LocalizedText.from(object(json, 'description'));

        /** @type {Map<string, LocalizedText>} Meaning of code values, e.g. "D" = Debit. */
        this.codes = new Map();
        for (const [code, text] of Object.entries(object(json, 'codes') ?? {})) {
            this.codes.set(code, LocalizedText.from(isObject(text) ? text : null) ?? new LocalizedText(null, null));
        }

        Object.freeze(this);
    }
}
