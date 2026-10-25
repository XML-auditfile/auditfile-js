import { DiagnosticSeverity } from './diagnostic.js';

/** Outcome of a scan, validation or read. */
export class AuditfileReport {
    /** @internal */
    constructor(schema, parts, diagnostics, rowCounts, loaded, duration) {
        /** @type {import('../schema/schema.js').AuditfileSchema | null} The import schema, or null when the version could not be determined. */
        this.schema = schema;
        /** @type {readonly import('../reading/source.js').PartInfo[]} Source parts with size and SHA-256 (empty when a part was not read completely). */
        this.parts = Object.freeze([...parts]);
        /** @type {readonly import('./diagnostic.js').Diagnostic[]} All diagnostics, in the order they were found. */
        this.diagnostics = Object.freeze([...diagnostics]);
        /** @type {ReadonlyMap<string, number>} Rows per table. */
        this.rowCounts = new Map(rowCounts);
        /** True when rows were handed to the sink and completed. */
        this.loaded = loaded;
        /** Time taken, in milliseconds. */
        this.duration = duration;
        Object.freeze(this);
    }

    /** True when there are no errors and no fatal diagnostics. */
    get isValid() {
        return !this.diagnostics.some((d) => d.severity === DiagnosticSeverity.Error || d.severity === DiagnosticSeverity.Fatal);
    }

    /**
     * Number of diagnostics with the given severity.
     * @param {string} severity
     */
    count(severity) {
        return this.diagnostics.filter((d) => d.severity === severity).length;
    }
}
