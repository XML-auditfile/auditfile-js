import { TextLanguage } from '../definitions/localized-text.js';
import { SinkCapabilities } from '../sinks/sink.js';

/** Keeps all rows in memory, per table. Useful for tests, small files and the browser. */
export class MemorySink {
    /** @type {Map<string, import('../reading/row.js').AuditfileRow[]>} */
    #tables = new Map();

    capabilities = SinkCapabilities.None;
    /** @type {import('../schema/schema.js').AuditfileSchema | null} The import schema, after begin. */
    schema = null;
    /** @type {import('../diagnostics/report.js').AuditfileReport | null} The report, after completion or abort. */
    report = null;
    /** True when the import was aborted; no rows are kept then. */
    isAborted = false;

    /**
     * Rows of a table; empty when the table has no rows.
     * @param {string} table
     * @returns {readonly import('../reading/row.js').AuditfileRow[]}
     */
    rows(table) {
        return this.#tables.get(table) ?? [];
    }

    /**
     * Runs a view, e.g. `sink.run(sink.schema.version.findView('trial_balance'))`, over the rows in memory.
     * @param {import('../definitions/view-definition.js').ViewDefinition} view
     * @param {Record<string, unknown> | Map<string, unknown> | null} [parameters]
     * @param {'nl' | 'en'} [language]
     * @throws {Error} Nothing has been read yet.
     */
    run(view, parameters = null, language = TextLanguage.Dutch) {
        if (this.schema === null) {
            throw new Error('Read an audit file into this sink first.');
        }

        return view.run(this.schema, (table) => this.rows(table), parameters, language);
    }

    begin(context) {
        this.#tables.clear();
        this.schema = context.schema;
        this.isAborted = false;
    }

    write(table, rows) {
        let list = this.#tables.get(table.name);
        if (list === undefined) {
            list = [];
            this.#tables.set(table.name, list);
        }

        for (const row of rows) {
            list.push(row);
        }
    }

    complete(report) {
        this.report = report;
    }

    abort(report) {
        this.#tables.clear();
        this.report = report;
        this.isAborted = true;
    }
}
