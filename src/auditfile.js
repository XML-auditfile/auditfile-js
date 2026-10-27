import { normalizeOptions, ReadProgress } from './reading/read-options.js';
import { ReadSession } from './reading/read-session.js';
import { AuditfileSource } from './reading/source.js';
import { checkSink, ImportContext, NULL_SINK, SinkCapabilities } from './sinks/sink.js';
import { DialectRegistry, ViewRegistry } from './versioning/custom-definitions.js';

function checkSource(source) {
    if (!(source instanceof AuditfileSource)) {
        throw new TypeError('source must be an AuditfileSource.');
    }

    return source;
}

/**
 * Entry point. Read an audit file into a sink, validate it, scan it, or stream its rows yourself.
 * @example
 * const sink = new MemorySink();
 * const report = await Auditfile.read(AuditfileSource.fromFactory(() => fs.createReadStream('admin.xaf'), 'admin.xaf'), sink);
 */
export class Auditfile {
    /**
     * Dialects added at runtime, next to the built-in ones: `Auditfile.dialects.add('xaf/3.2', json)`.
     * Shared by every read in this process.
     * @type {DialectRegistry}
     */
    static dialects = new DialectRegistry();

    /**
     * Views added at runtime, next to the built-in ones: `Auditfile.views.add(json)`, then `version.findView(name)`.
     * Shared by every read in this process.
     * @type {ViewRegistry}
     */
    static views = new ViewRegistry();

    /**
     * Reads an audit file into a sink. Verified mode (default) validates against the XSD first and loads only a valid file.
     * @param {AuditfileSource} source
     * @param {import('./sinks/sink.js').Sink} sink
     * @param {import('./reading/read-options.js').ReadOptions} [options]
     * @returns {Promise<import('./diagnostics/report.js').AuditfileReport>}
     */
    static async read(source, sink, options = undefined) {
        checkSource(source);
        checkSink(sink);
        const settings = normalizeOptions(options);

        const session = new ReadSession(source, settings);
        if (!await session.prepare(((sink.capabilities ?? 0) & SinkCapabilities.NeedsRowCounts) !== 0)) {
            await session.dispose();
            return session.createReport(false);
        }

        const schema = session.schema;
        const batches = new Map();
        const total = schema.hasRowCounts ? schema.tables.reduce((sum, t) => sum + (t.rowCount ?? 0), 0) : null;
        let rows = 0;

        try {
            settings.signal?.throwIfAborted();
            await sink.begin(new ImportContext(schema, session.parts));
            for await (const row of session.load()) {
                let batch = batches.get(row.table);
                if (batch === undefined) {
                    batch = [];
                    batches.set(row.table, batch);
                }

                batch.push(row);
                rows++;
                if (batch.length >= settings.batchSize) {
                    settings.signal?.throwIfAborted();
                    batches.set(row.table, []);
                    await sink.write(row.table, batch);
                    settings.onProgress?.(new ReadProgress(rows, total));
                }
            }

            for (const [table, batch] of [...batches].sort(([a], [b]) => a.index - b.index)) {
                if (batch.length > 0) {
                    await sink.write(table, batch);
                }
            }

            settings.onProgress?.(new ReadProgress(rows, total));
        } catch (error) {
            await session.dispose();
            try {
                await sink.abort(session.createReport(false));
            } catch (abortError) {
                // A failing rollback must not hide why the import failed: the caller gets both.
                throw new AggregateError([error, abortError], 'The import failed, and aborting the sink failed too.');
            }

            throw error;
        }

        const failed = session.diagnostics.hasFatal || (session.validateDuringLoad && session.diagnostics.hasErrors);
        const report = session.createReport(!failed);
        if (failed) {
            await sink.abort(report);
        } else {
            await sink.complete(report);
        }

        return report;
    }

    /**
     * Validates an audit file (structure, keys, business rules) without storing anything.
     * In verified mode (the default) the XSD is checked first and the rest only for a valid file;
     * unverified mode skips the XSD and checks everything else, which is faster but reports fewer deviations
     * (e.g. XAF-S004 instead of XAF-D001 for an invalid value).
     * @param {AuditfileSource} source
     * @param {import('./reading/read-options.js').ReadOptions} [options]
     */
    static validate(source, options = undefined) {
        return Auditfile.read(source, NULL_SINK, options);
    }

    /**
     * The scan phase only: determines the version, validates against the XSD in verified mode,
     * and counts rows per table. The report's schema contains the row counts.
     * @param {AuditfileSource} source
     * @param {import('./reading/read-options.js').ReadOptions} [options]
     */
    static async scan(source, options = undefined) {
        const session = new ReadSession(checkSource(source), normalizeOptions(options));
        await session.prepare(true, true);
        await session.dispose();
        return session.createReport(false);
    }

    /**
     * Opens an audit file for reading rows yourself, without a sink.
     * @param {AuditfileSource} source
     * @param {import('./reading/read-options.js').ReadOptions} [options]
     */
    static async open(source, options = undefined) {
        const session = new ReadSession(checkSource(source), normalizeOptions(options));
        const ready = await session.prepare(false);
        if (!ready) {
            await session.dispose();
        }

        return new AuditfileReader(session, ready);
    }
}

/** Reads rows one by one. Check {@link AuditfileReader#schema} for null before reading: null means the file cannot be read. */
export class AuditfileReader {
    #session;
    #ready;
    #started = false;
    #report = null;

    /** @internal */
    constructor(session, ready) {
        this.#session = session;
        this.#ready = ready;
    }

    /** @type {import('./schema/schema.js').AuditfileSchema | null} The import schema, or null when the file cannot be read (see {@link AuditfileReader#report}). */
    get schema() {
        return this.#ready ? this.#session.schema : null;
    }

    /**
     * Rows in document order; a row is returned when its element closes. The rows are read while you iterate,
     * and can be iterated only once: collect them in an array when you need them twice.
     * @returns {AsyncGenerator<import('./reading/row.js').AuditfileRow>}
     * @throws {Error} The rows are iterated a second time.
     */
    async *readRows() {
        if (this.#started) {
            throw new Error('The rows of an audit file can be iterated only once; collect them in an array to use them twice.');
        }

        this.#started = true;
        if (this.#ready) {
            yield* this.#session.load();
        }
    }

    /**
     * The report; complete after {@link AuditfileReader#readRows} has been iterated to the end. Until then every call gives
     * the report so far; the complete report is made once and kept.
     */
    get report() {
        if (this.#report !== null) {
            return this.#report;
        }

        const report = this.#session.createReport(false);
        if (!this.#ready || this.#session.loaded) {
            this.#report = report;
        }

        return report;
    }
}
