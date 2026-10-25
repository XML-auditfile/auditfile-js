/** What a sink needs from the reader (bit flags). */
export const SinkCapabilities = Object.freeze({
    /** Nothing special. */
    None: 0,
    /** The sink wants row counts before the first row (e.g. to pre-allocate); the reader scans first. */
    NeedsRowCounts: 1,
});

/**
 * Receives an import: first the schema, then rows per table in batches, then completion or abort.
 * All validation, merging and reporting happens before the sink, so a custom sink gets the same result as a built-in one.
 * Every method may return a promise.
 *
 * @typedef {object} Sink
 * @property {number} [capabilities] What the sink needs, as {@link SinkCapabilities} flags.
 * @property {(context: ImportContext) => void | Promise<void>} begin Start of an import. The schema contains row counts when the reader scanned first.
 * @property {(table: import('../schema/schema.js').SchemaTable, rows: readonly import('../reading/row.js').AuditfileRow[]) => void | Promise<void>} write
 *   A batch of rows of one table. Child rows can arrive before their parent row; ids are already assigned.
 * @property {(report: import('../diagnostics/report.js').AuditfileReport) => void | Promise<void>} complete The import is complete; commit.
 * @property {(report: import('../diagnostics/report.js').AuditfileReport) => void | Promise<void>} abort The import failed; discard everything received since begin.
 */

/**
 * A stored import, e.g. in a database. Gives back the schema and the rows per table,
 * so code can work with an import regardless of where it is stored. Implemented by connectors.
 *
 * @typedef {object} AuditfileStore
 * @property {() => Promise<import('../schema/schema.js').AuditfileSchema>} getSchema The schema of the stored import.
 * @property {(table: string, onBatch: (rows: readonly import('../reading/row.js').AuditfileRow[]) => Promise<void>) => Promise<void>} readRows
 *   Reads the rows of one table in batches, in id order.
 */

/** Information at the start of an import. */
export class ImportContext {
    /** @internal */
    constructor(schema, parts) {
        /** @type {import('../schema/schema.js').AuditfileSchema} The import schema. */
        this.schema = schema;
        /** @type {readonly import('../reading/source.js').SourcePart[]} The source parts. */
        this.parts = parts;
        Object.freeze(this);
    }
}

/** Discards everything; used for validation. */
export const NULL_SINK = Object.freeze({
    capabilities: SinkCapabilities.None,
    begin() {},
    write() {},
    complete() {},
    abort() {},
});

/** @param {unknown} sink */
export function checkSink(sink) {
    for (const method of ['begin', 'write', 'complete', 'abort']) {
        if (typeof sink?.[method] !== 'function') {
            throw new TypeError(`sink must have a ${method} method.`);
        }
    }

    return sink;
}
