import { DiagnosticSeverity } from './diagnostic.js';

/** Outcome of a scan, validation or read. */
export class AuditfileReport {
    #counts;

    /** @internal */
    constructor(schema, parts, diagnostics, counts, truncated, rowCounts, loaded, duration) {
        /** @type {import('../schema/schema.js').AuditfileSchema | null} The import schema, or null when the version could not be determined. */
        this.schema = schema;
        /** @type {readonly import('../reading/source.js').PartInfo[]} Source parts with size and SHA-256 (empty when a part was not read completely). */
        this.parts = Object.freeze([...parts]);
        /**
         * @type {readonly import('./diagnostic.js').Diagnostic[]} The diagnostics, in the order they were found, at most `maxDiagnostics`
         * plus XAF-X900 when more were found. A full list makes room for errors by leaving out infos and warnings; fatal diagnostics are always included.
         */
        this.diagnostics = Object.freeze([...diagnostics]);
        /** True when diagnostics were left out of {@link AuditfileReport#diagnostics}; {@link AuditfileReport#count} still counts them. */
        this.isTruncated = truncated;
        /** @type {ReadonlyMap<string, number>} Rows per table. */
        this.rowCounts = new Map(rowCounts);
        /** True when rows were handed to the sink and completed. */
        this.loaded = loaded;
        /** Time taken, in milliseconds. */
        this.duration = duration;
        this.#counts = Object.freeze({ ...counts });
        Object.freeze(this);
    }

    /** True when a fatal diagnostic was found: reading stopped. */
    get hasFatal() {
        return this.#counts.fatal > 0;
    }

    /** True when an error or fatal diagnostic was found, also when it is not in a truncated {@link AuditfileReport#diagnostics}. */
    get hasErrors() {
        return this.hasFatal || this.#counts.error > 0;
    }

    /** True when there are no errors and no fatal diagnostics. */
    get isValid() {
        return !this.hasErrors;
    }

    /**
     * Number of diagnostics with the given severity, including the ones left out of a truncated {@link AuditfileReport#diagnostics}.
     * @param {string} severity One of {@link DiagnosticSeverity}.
     */
    count(severity) {
        if (!Object.values(DiagnosticSeverity).includes(severity)) {
            throw new RangeError(`Unknown severity '${severity}'.`);
        }

        return this.#counts[severity];
    }
}
