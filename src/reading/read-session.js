import { DiagnosticCollector, Location } from '../diagnostics/collector.js';
import { AuditfileReport } from '../diagnostics/report.js';
import { Sha256 } from '../internal/sha256.js';
import { ConcatenatedStream, iterate, SourceError } from '../internal/streams.js';
import { END, START, TEXT, XmlEncodingError, XmlReader, XmlSyntaxError } from '../internal/xml-reader.js';
import { AuditfileSchema } from '../schema/schema.js';
import { ReferenceChecker } from '../validation/reference-checker.js';
import { XAF, XafRules } from '../validation/xaf-rules.js';
import { resolveVersion } from '../versioning/version-resolver.js';
import { SchemaSet } from '../xsd/schema-set.js';
import { XsdValidator } from '../xsd/validator.js';
import { MappingPlan } from './mapping-plan.js';
import { CANCELLATION_INTERVAL, ReadMode } from './read-options.js';
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
    #loadStarted = false;
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

    /** The load phase as a stream of rows. Diagnostics are collected along the way. Can be iterated once. */
    async *load() {
        // A second iteration would read the file again and add to the same counts and diagnostics.
        if (this.#loadStarted) {
            throw new Error('The rows of an audit file can be iterated only once; collect them in an array to use them twice.');
        }

        this.#loadStarted = true;
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
            if (validate === undefined) {
                return;
            }

            const observers = [new ReferenceChecker(this.schema, this.diagnostics)];
            if (this.resolution.version.type === XAF) {
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

        // Without a scan phase a dialect recognized by the software description is only known now; the report names it.
        const r = this.resolution;
        if ((r.dialect?.name ?? null) !== this.schema.dialect) {
            this.schema = AuditfileSchema.create(r.version, r.fileNamespace, r.source, r.dialect?.name ?? null,
                this.schema.hasRowCounts ? this.#rowCountsFromSchema() : null);
        }

        this.#loaded = true;
    }

    /** True when the load phase has read the whole file. */
    get loaded() {
        return this.#loaded;
    }

    createReport(loaded) {
        return new AuditfileReport(this.schema, this.#parts, this.diagnostics.items, this.diagnostics.counts, this.diagnostics.isTruncated,
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
            if (feed === undefined) {
                return;
            }

            let counts;
            try {
                counts = await this.#countRows(reader, feed);
                if (counts === null) {
                    return;
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

    /**
     * Walks the document (feeding the XSD validator, when validating) and counts the rows per table.
     * Recognizes a dialect by the software description on the way. Returns null after XAF-X003.
     */
    async #countRows(reader, feed) {
        const r = this.resolution;
        const plan = new MappingPlan(AuditfileSchema.create(r.version, r.fileNamespace, r.source, null, null));
        const softwareNode = plan.root.children.get(r.version.rootElement)?.children.get('header')?.children.get('softwareDesc');
        const counts = new Map(r.version.manifest.tables.map((t) => [t.name, 0]));
        const namespace = r.version.namespace;
        const signal = this.#options.signal;
        const nodes = [];
        let software = null;
        let softwareDepth = -1;
        let events = 0;

        for (let event = await reader.next(); event !== null; event = reader.poll() ?? await reader.next()) {
            if (events++ % CANCELLATION_INTERVAL === 0) {
                signal?.throwIfAborted();
            }

            feed?.(event);

            // The dialect is recognized here already, so the schema handed to the sink names it.
            if (software !== null) {
                if (event.kind === TEXT && software.length <= this.#options.maxValueLength) {
                    software += event.text;
                } else if (event.kind === END && event.depth === softwareDepth) {
                    r.useSoftware(software, this.#options.applyDialects);
                    software = null;
                }
            }

            if (event.kind !== START) {
                continue;
            }

            const depth = event.depth;
            if (depth >= this.#options.maxDepth) {
                this.diagnostics.add('XAF-X003', new Location(event.part, event.line, event.column, null), { max: this.#options.maxDepth });
                return null;
            }

            const parent = depth === 0 ? plan.root : nodes[depth - 1];
            const node = parent != null && event.ns === namespace ? parent.children.get(event.local) ?? null : null;
            nodes[depth] = node;
            if (node?.table != null) {
                const name = node.table.table.name;
                counts.set(name, counts.get(name) + 1);
            } else if (node !== null && node === softwareNode && r.dialect === null) {
                software = '';
                softwareDepth = depth;
            }
        }

        return counts;
    }

    /** Reports a well-formedness, encoding or source error; returns false for anything else. */
    #xmlError(error) {
        if (error instanceof SourceError) {
            this.diagnostics.add('XAF-X002', Location.NONE, { part: error.part, detail: error.message });
            return true;
        }

        if (error instanceof XmlSyntaxError) {
            this.diagnostics.add('XAF-X001', new Location(error.part, error.line, error.column, null), { detail: error.message });
            return true;
        }

        if (error instanceof XmlEncodingError) {
            this.diagnostics.add('XAF-X004', new Location(error.part, null, null, null), { encoding: error.encoding });
            return true;
        }

        return false;
    }

    /**
     * Opens the document and reads up to the root element, resolving the version on first use.
     * Returns the reader positioned before the root element, or null when the file cannot be read.
     */
    async #open(stream) {
        const reader = new XmlReader(stream, { maxCharacters: this.#options.maxCharactersInDocument });
        let root = null;
        try {
            for (let event = await reader.next(); event !== null; event = await reader.next()) {
                if (event.kind === START) {
                    root = reader.rootOffset >= PEEK_LIMIT ? null : event;
                    break;
                }

                // Only while the root has not been parsed yet: a source may hand over the whole file at once.
                if (reader.position > PEEK_LIMIT && reader.rootOffset === null) {
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
            // A source that cannot be read is a finding (X002); a wrong argument is the caller's error.
            if (!this.#xmlError(error)) {
                await reader.close();
                throw error;
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

    /**
     * The XSD validator as an event consumer that reports XAF-D001.
     * Returns undefined (after XAF-X002) when a custom XSD cannot be read or compiled.
     */
    async #validator(stream) {
        const version = this.resolution.version;
        let set;
        if (this.#options.xsd === null) {
            set = version.createSchemaSet();
        } else {
            try {
                const bytes = await readAll(this.#options.xsd());
                if (Sha256.hex(bytes) !== version.manifest.xsdSha256) {
                    this.diagnostics.add('XAF-D002', Location.NONE, { version: version.key });
                }

                const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
                set = SchemaSet.compile('custom.xsd', (name) => (name === 'custom.xsd' ? text : undefined));
            } catch (error) {
                this.diagnostics.add('XAF-X002', Location.NONE, { part: 'XSD', detail: error?.message ?? String(error) });
                return undefined;
            }
        }

        // Keys and references are checked by the ReferenceChecker (XAF-R003, XAF-R004) from the manifest, which holds every
        // constraint of the XSD. The XSD's own identity constraints use XPaths without a namespace prefix, so in a namespaced
        // document they never match; evaluating them only costs time.
        let part = stream.part;
        const validator = new XsdValidator(set, (message, line, column) => {
            this.diagnostics.add('XAF-D001', new Location(part, line, column, null), { detail: message });
        }, this.#options.maxValueLength, false);

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
