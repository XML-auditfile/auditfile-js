/** What a dialect correction does. Unknown actions are refused when the definitions are loaded. */
export const DialectAction = Object.freeze({
    /** Read a file in `from` as the official namespace. */
    ReplaceNamespace: 'replaceNamespace',
    /** A decimal comma becomes a point. */
    DecimalComma: 'decimalComma',
    /** The time is removed from a date. */
    DateFromDateTime: 'dateFromDateTime',
});

/** How a view column aggregates its values. Unknown aggregates are refused when the definitions are loaded. */
export const ViewAggregate = Object.freeze({
    Sum: 'sum',
    Count: 'count',
    Min: 'min',
    Max: 'max',
});

/** How a view column gets its value from an input row. Unknown operators are refused when the definitions are loaded. */
export const ViewOperator = Object.freeze({
    /** The value of the column. */
    Column: 'column',
    /** The value when `by` is one of the codes, otherwise null. */
    Only: 'only',
    /** The value, negated when `by` is one of the codes. */
    Signed: 'signed',
    /**
     * `prefix`-n instead of the value, where n numbers the distinct values of the column in the order they first
     * occur in its table. Null and empty values stay as they are.
     */
    Pseudonym: 'pseudonym',
});

/**
 * A name from the JSON definitions, checked against the known names.
 * @internal
 * @param {string} value
 * @param {Readonly<Record<string, string>>} allowed
 * @param {string} what
 */
export function oneOf(value, allowed, what) {
    if (!Object.values(allowed).includes(value)) {
        throw new SyntaxError(`Embedded JSON: unknown ${what} '${value}'.`);
    }

    return value;
}
