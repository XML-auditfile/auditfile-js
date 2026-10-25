import { DiagnosticCollector, Location } from '../diagnostics/collector.js';
import { AuditfileReport } from '../diagnostics/report.js';
import { Sha256 } from '../internal/sha256.js';
import { ConcatenatedStream, iterate } from '../internal/streams.js';
import { END, START, TEXT, XmlEncodingError, XmlReader, XmlSyntaxError } from '../internal/xml-reader.js';
import { AuditfileSchema } from '../schema/schema.js';
import { ReferenceChecker } from '../validation/reference-checker.js';
import { XafRules } from '../validation/xaf-rules.js';
import { resolveVersion } from '../versioning/version-resolver.js';
import { SchemaSet } from '../xsd/schema-set.js';
import { XsdValidator } from '../xsd/validator.js';
import { ReadMode } from './read-options.js';
import { RowLoader } from './row-loader.js';

const PEEK_LIMIT = 1024 * 1024;
const MAX_XSD_SIZE = 16 * 1024 * 1024;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * One read of one source: resolve the version, optionally scan (validate and count),
 * then load (stream rows). Holds the diagnostics and the part statistics.
 */
export class ReadSession {
    #source;
    #options;
    #started = now();
    #rowCounts = new Map();
    #parts = [];
    #loaded = false;
    // A single-use source is opened once: the document used for version detection is kept for loading.
    #pending = null;

    /** @type {import('../versioning/version-resolver.js').Resolution | null} */
    resolution = null;
    /** @type {AuditfileSchema | null} */
    schema = null;
    /** True when the load phase must validate against the XSD itself (single-use source). */
    validateDuringLoad = false;

    constructor(source, options) {
        this.#source = source;
        this.#options = options;
        this.diagnostics = new DiagnosticCollector(options.language, options.maxDiagnostics);
    }

    get parts() {
        return this.#source.parts;
    }

    /** Resolves the version and runs the scan phase when useful. Returns false when loading must not start. */
    async prepare(sinkNeedsRowCounts, scanOnly = false) {
        const verified = this.#options.mode === ReadMode.Verified;
        const wantScan = scanOnly || verified || sinkNeedsRowCounts || this.#source.parts.length > 1;

        if (wantScan && this.#source.canReadTwice) {
            await this.#scan(verified);
            if (this.diagnostics.hasFatal || (verified && this.diagnostics.hasErrors)) {
                return false;
            }

            return !scanOnly;
        }

        if (wantScan) {
            this.diagnostics.add('XAF-S005', Location.NONE);
        }

        this.validateDuringLoad = verified;
        if (!await this.#resolveFromPeek()) {
            return false;
        }

        const r = this.resolution;
        this.schema = AuditfileSchema.create(r.version, r.fileNamespace, r.source, r.dialect?.name ?? null, null);
        return !scanOnly;
    }

    /** The load phase as a stream of rows. Diagnostics are collected along the way. */
    async *load() {
        if (this.schema === null) {
            return;
        }

        let document = this.#pending;
        this.#pending = null;
        if (document === null) {
            const stream = new ConcatenatedStream(this.#source.parts, this.#parts.length === 0);
            document = await this.#open(stream);
            if (document === null) {
                return;
            }
        }

        const { stream, reader } = document;
        try {
            const validate = this.validateDuringLoad ? await this.#validator(stream) : null;
            const observers = [new ReferenceChecker(this.schema, this.diagnostics)];
            if (this.resolution.version.type === 'xaf') {
                observers.push(new XafRules(this.schema, this.diagnostics));
            }

            const loader = new RowLoader(reader, this.schema, this.resolution, this.#options, this.diagnostics, observers, validate);
            for await (const row of loader.rows()) {
                this.#rowCounts.set(row.table.name, (this.#rowCounts.get(row.table.name) ?? 0) + 1);
                yield row;
            }

            if (!loader.stopped) {
                for (const observer of observers) {
                    observer.onEnd();
                }

                this.#checkTables(this.#rowCounts);
            }
        } finally {
            await reader.close();
        }

        if (this.#parts.length === 0) {
            this.#parts = stream.completed;
        }

        this.#loaded = true;
    }

    createReport(loaded) {
        return new AuditfileReport(this.schema, this.#parts, this.diagnostics.items,
            this.#loaded ? this.#rowCounts : this.#rowCountsFromSchema(), loaded, now() - this.#started);
    }

    /** Releases a document kept for loading that will not be loaded after all. */
    async dispose() {
        const pending = this.#pending;
        this.#pending = null;
        await pending?.reader.close();
    }

    #rowCountsFromSchema() {
        return new Map((this.schema?.tables ?? []).filter((t) => t.rowCount > 0).map((t) => [t.name, t.rowCount]));
    }

    async #scan(validate) {
        const stream = new ConcatenatedStream(this.#source.parts, true);
        const document = await this.#open(stream);
        if (document === null) {
            return;
        }

        const { reader } = document;
        try {
            const feed = validate ? await this.#validator(stream) : null;
            const manifest = this.resolution.version.manifest;
            const tablesByPath = new Map(manifest.tables.map((t) => [t.path, t.name]));
            const counts = new Map(manifest.tables.map((t) => [t.name, 0]));
            const paths = [];

            try {
                for (let event = await reader.next(); event !== null; event = reader.poll() ?? await reader.next()) {
                    feed?.(event);
                    if (event.kind !== START) {
                        continue;
                    }

                    const depth = event.depth;
                    if (depth >= this.#options.maxDepth) {
                        this.diagnostics.add('XAF-X003', new Location(event.part, event.line, event.column, null), { max: this.#options.maxDepth });
                        return;
                    }

                    const parent = depth === 0 ? null : paths[depth - 1];
                    const path = event.ns === manifest.namespace && (depth === 0 || parent !== null)
                        ? (depth === 0 ? event.local : `${parent}/${event.local}`)
                        : null;
                    paths[depth] = path;
                    const table = path === null ? undefined : tablesByPath.get(path);
                    if (table !== undefined) {
                        counts.set(table, counts.get(table) + 1);
                    }
                }
            } catch (error) {
                if (this.#xmlError(error)) {
                    return;
                }

                throw error;
            }

            this.#parts = stream.completed;
            this.#checkTables(counts);
            const r = this.resolution;
            this.schema = AuditfileSchema.create(r.version, r.fileNamespace, r.source, r.dialect?.name ?? null, counts);
        } finally {
            await reader.close();
        }
    }

    /** Reports a well-formedness or encoding error; returns false for anything else. */
    #xmlError(error) {
        if (error instanceof XmlSyntaxError) {
            this.diagnostics.add('XAF-X001', new Location(error.part, error.line, error.column, null), { detail: error.message });
            return true;
        }

        if (error instanceof XmlEncodingError) {
            this.diagnostics.add('XAF-X004', Location.NONE, { encoding: error.encoding });
            return true;
        }

        return false;
    }

    /**
     * Opens the document and reads up to the root element, resolving the version on first use.
     * Returns the reader positioned before the root element, or null when the file cannot be read.
     */
    async #open(stream) {
        const reader = new XmlReader(stream);
        let root = null;
        try {
            for (let event = await reader.next(); event !== null; event = await reader.next()) {
                if (event.kind === START) {
                    root = event;
                    break;
                }

                if (reader.position > PEEK_LIMIT) {
                    break;
                }
            }

            if (root === null) {
                if (reader.position > PEEK_LIMIT) {
                    this.diagnostics.add('XAF-X002', Location.NONE, { part: this.#source.parts[0].name, detail: 'The root element was not found within the first megabyte.' });
                } else {
                    this.diagnostics.add('XAF-X001', new Location(1, null, null, null), { detail: 'Root element is missing.' });
                }
            }
        } catch (error) {
            if (!this.#xmlError(error)) {
                // A source that cannot be read is a finding (X002); a wrong argument or a later failure is the caller's error.
                if (this.resolution !== null || error instanceof TypeError) {
                    await reader.close();
                    throw error;
                }

                this.diagnostics.add('XAF-X002', Location.NONE, { part: this.#source.parts[0].name, detail: error?.message ?? String(error) });
            }
        }

        if (root === null) {
            await reader.close();
            return null;
        }

        if (this.resolution === null) {
            this.resolution = resolveVersion(root.local, root.ns, this.#options, this.diagnostics);
            if (this.resolution === null) {
                await reader.close();
                return null;
            }
        }

        if (this.resolution.needsMapping) {
            reader.mapNamespace(this.resolution.fileNamespace, this.resolution.version.namespace);
        }

        reader.pushBack(root);
        return { stream, reader };
    }

    async #resolveFromPeek() {
        if (this.resolution !== null) {
            return true;
        }

        const stream = new ConcatenatedStream(this.#source.parts, !this.#source.canReadTwice);
        const document = await this.#open(stream);
        if (document === null || this.#source.canReadTwice) {
            await document?.reader.close();
            return this.resolution !== null;
        }

        this.#pending = document;
        return true;
    }

    /** The XSD validator as an event consumer that reports XAF-D001. */
    async #validator(stream) {
        const version = this.resolution.version;
        let set;
        if (this.#options.xsd === null) {
            set = version.createSchemaSet();
        } else {
            const bytes = await readAll(this.#options.xsd());
            if (Sha256.hex(bytes) !== version.manifest.xsdSha256) {
                this.diagnostics.add('XAF-D002', Location.NONE, { version: version.key });
            }

            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            set = SchemaSet.compile('custom.xsd', (name) => (name === 'custom.xsd' ? text : undefined));
        }

        let part = stream.part;
        const validator = new XsdValidator(set, (message, line, column) => {
            this.diagnostics.add('XAF-D001', new Location(part, line, column, null), { detail: message });
        });

        return (event) => {
            part = event.part;
            switch (event.kind) {
                case START:
                    validator.start(event);
                    break;
                case END:
                    validator.end(event);
                    break;
                case TEXT:
                    validator.text(event);
                    break;
            }
        };
    }

    #checkTables(counts) {
        const manifest = this.resolution.version.manifest;
        for (const table of manifest.requiredTables.filter((t) => !(counts.get(t) > 0))) {
            this.diagnostics.add('XAF-S001', Location.NONE, { table });
        }

        for (const table of manifest.expectedTables.filter((t) => !(counts.get(t) > 0))) {
            this.diagnostics.add('XAF-S002', Location.NONE, { table });
        }
    }
}

/** Reads a custom XSD completely, refusing absurd sizes. */
async function readAll(stream) {
    const source = await stream;
    if (typeof source === 'string') {
        return new TextEncoder().encode(source);
    }

    const iterator = iterate(source, false);
    const chunks = [];
    let length = 0;
    try {
        for (let result = await iterator.next(); !result.done; result = await iterator.next()) {
            const chunk = new Uint8Array(result.value);
            length += chunk.length;
            if (length > MAX_XSD_SIZE) {
                throw new RangeError('The XSD is larger than 16 MB.');
            }

            chunks.push(chunk);
        }
    } finally {
        await iterator.return?.();
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }

    return bytes;
}
