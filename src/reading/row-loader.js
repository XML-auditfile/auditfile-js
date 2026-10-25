import { Location } from '../diagnostics/collector.js';
import { ColumnType } from '../definitions/manifest.js';
import { END, START, TEXT, XmlEncodingError, XmlSyntaxError } from '../internal/xml-reader.js';
import { MappingPlan } from './mapping-plan.js';
import { AuditfileRow } from './row.js';
import { tryConvert } from './value-converter.js';

const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

/** An open table element. */
class Frame {
    #ordinals = null;

    constructor(plan, id, parentId, ordinal, part, path) {
        this.plan = plan;
        this.id = id;
        this.parentId = parentId;
        this.ordinal = ordinal;
        this.part = part;
        this.path = path;
        this.values = new Array(plan.table.columns.length).fill(null);
    }

    nextOrdinal(child) {
        this.#ordinals ??= new Map();
        const next = (this.#ordinals.get(child) ?? 0) + 1;
        this.#ordinals.set(child, next);
        return next;
    }
}

/**
 * The load phase: walks the XML once and turns elements into rows using the mapping plan.
 * A row is emitted when its element closes, so all its columns are known; ids are assigned when it opens,
 * so they follow document order. Only the open elements are kept in memory.
 */
export class RowLoader {
    #reader;
    #plan;
    #resolution;
    #options;
    #diagnostics;
    #observers;
    #validate;
    #namespace;
    #softwarePath;
    #paths = [];
    #frames = [];
    #ready = [];
    #reported = new Set();
    #corrections = new Map();
    #nextId = 0;
    #skipDepth = null;
    #capture = null;
    #event = null;

    /** True when reading stopped on a fatal error. */
    stopped = false;

    /**
     * @param {import('../internal/xml-reader.js').XmlReader} reader
     * @param {((event: object) => void) | null} validate Feeds the XSD validator, when validating during load.
     */
    constructor(reader, schema, resolution, options, diagnostics, observers, validate) {
        this.#reader = reader;
        this.#plan = new MappingPlan(schema);
        this.#resolution = resolution;
        this.#options = options;
        this.#diagnostics = diagnostics;
        this.#observers = observers;
        this.#validate = validate;
        this.#namespace = resolution.version.namespace;
        this.#softwarePath = `${resolution.version.rootElement}/header/softwareDesc`;
        this.#useDialect(resolution.dialect);
    }

    /** @returns {AsyncGenerator<AuditfileRow>} Rows in document order of their closing tags. */
    async *rows() {
        for (;;) {
            let event;
            try {
                event = this.#reader.poll() ?? await this.#reader.next();
            } catch (error) {
                if (error instanceof XmlSyntaxError) {
                    this.#diagnostics.add('XAF-X001', new Location(error.part, error.line, error.column, this.#currentPath), { detail: error.message });
                } else if (error instanceof XmlEncodingError) {
                    this.#diagnostics.add('XAF-X004', Location.NONE, { encoding: error.encoding });
                } else {
                    throw error;
                }

                this.stopped = true;
                return;
            }

            if (event === null) {
                return;
            }

            this.#event = event;
            this.#validate?.(event);
            switch (event.kind) {
                case START:
                    this.#start(event);
                    break;
                case END:
                    this.#end(event);
                    break;
                case TEXT:
                    if (this.#capture !== null) {
                        this.#capture.text += event.text;
                    }

                    break;
            }

            if (this.#ready.length > 0) {
                for (const row of this.#ready) {
                    yield row;
                }

                this.#ready.length = 0;
            }

            if (this.stopped) {
                return;
            }
        }
    }

    get #currentPath() {
        return this.#paths.at(-1) ?? null;
    }

    get #top() {
        return this.#frames.at(-1) ?? null;
    }

    #start(event) {
        if (this.#skipDepth !== null) {
            return;
        }

        if (this.#capture !== null) {
            this.#diagnostics.add('XAF-X001', this.#here(this.#capture.path),
                { detail: `Element '${event.local}' is not allowed inside '${this.#capture.path}', which holds a value.` });
            this.stopped = true;
            return;
        }

        if (event.depth >= this.#options.maxDepth) {
            this.#diagnostics.add('XAF-X003', this.#here(this.#currentPath), { max: this.#options.maxDepth });
            this.stopped = true;
            return;
        }

        const current = this.#currentPath;
        const path = current === null ? event.local : `${current}/${event.local}`;
        if (event.ns !== this.#namespace) {
            this.#skip(path, event);
            return;
        }

        const table = this.#plan.tables.get(path);
        if (table !== undefined) {
            const parent = this.#top;
            const frame = new Frame(table, ++this.#nextId, parent?.id ?? null, parent?.nextOrdinal(table) ?? 1, event.part, path);
            this.#readAttributes(path, frame, event);
            if (table.isValueTable) {
                this.#capture = { frame, column: table.table.columns[0], path, text: '', emit: true };
                return;
            }

            this.#frames.push(frame);
            this.#paths.push(path);
            return;
        }

        const target = this.#plan.columns.get(path);
        const owner = this.#top;
        if (target !== undefined && owner !== null && owner.plan === target.table) {
            this.#capture = { frame: owner, column: target.column, path, text: '', emit: false };
            return;
        }

        if (this.#plan.groups.has(path)) {
            if (owner !== null) {
                this.#readAttributes(path, owner, event);
            }

            this.#paths.push(path);
            return;
        }

        this.#skip(path, event);
    }

    #end(event) {
        if (this.#skipDepth !== null) {
            if (event.depth === this.#skipDepth) {
                this.#skipDepth = null;
            }

            return;
        }

        if (this.#capture !== null) {
            const { frame, column, path, text, emit } = this.#capture;
            this.#capture = null;
            this.#setValue(frame, column, text, path);
            if (emit) {
                this.#emit(frame);
            }

            return;
        }

        const path = this.#paths.pop();
        if (path !== undefined && this.#top?.path === path) {
            this.#emit(this.#frames.pop());
        }
    }

    #skip(path, event) {
        const key = `S003:${path}`;
        if (!this.#reported.has(key)) {
            this.#reported.add(key);
            this.#diagnostics.add('XAF-S003', this.#here(path), { path });
        }

        this.#skipDepth = event.depth;
    }

    #readAttributes(elementPath, frame, event) {
        for (const attribute of event.attributes) {
            if (attribute.ns === XMLNS || attribute.ns === XSI || attribute.local === 'xmlns' || attribute.prefix === 'xmlns') {
                continue;
            }

            const path = `${elementPath}/@${attribute.local}`;
            const target = this.#plan.columns.get(path);
            if (target !== undefined && target.table === frame.plan) {
                this.#setValue(frame, target.column, attribute.value, path);
            }
        }
    }

    #setValue(frame, column, raw, path) {
        const corrections = this.#corrections.get(path);
        if (corrections !== undefined) {
            raw = this.#correct(raw, corrections, column, path);
        }

        const { ok, value } = tryConvert(raw, column.type);
        if (ok) {
            frame.values[column.index] = value;
        } else {
            this.#diagnostics.add('XAF-S004', this.#here(path), { value: raw, column: `${frame.plan.table.name}.${column.name}`, type: column.type });
        }

        if (path === this.#softwarePath && this.#resolution.dialect === null && this.#options.applyDialects && typeof value === 'string') {
            const dialect = this.#resolution.version.dialects.find((d) => d.softwareDescription === value);
            if (dialect !== undefined) {
                this.#resolution.dialect = dialect;
                this.#useDialect(dialect);
            }
        }
    }

    #correct(raw, corrections, column, path) {
        for (const correction of corrections) {
            let corrected = raw;
            if (correction.action === 'decimalComma' && raw.includes(',') && !raw.includes('.')) {
                corrected = raw.replaceAll(',', '.');
            } else if (correction.action === 'dateFromDateTime' && column.type === ColumnType.Date && raw.trim().length > 10) {
                corrected = raw.trim().slice(0, 10);
            }

            const key = `${correction.code}:${path}`;
            if (corrected !== raw && !this.#reported.has(key)) {
                this.#reported.add(key);
                this.#diagnostics.add(correction.code, this.#here(path), { path });
            }

            raw = corrected;
        }

        return raw;
    }

    #useDialect(dialect) {
        this.#corrections = new Map();
        for (const correction of dialect?.corrections ?? []) {
            if (correction.action === 'replaceNamespace') {
                continue;
            }

            for (const path of correction.paths) {
                const list = this.#corrections.get(path) ?? [];
                list.push(correction);
                this.#corrections.set(path, list);
            }
        }
    }

    #emit(frame) {
        const row = new AuditfileRow(frame.plan.table, frame.id, frame.parentId, frame.ordinal, frame.part, frame.values);
        for (const observer of this.#observers) {
            observer.onRow(row);
        }

        this.#ready.push(row);
    }

    #here(path) {
        const event = this.#event;
        return new Location(event?.part ?? null, event?.line ?? null, event?.column ?? null, path);
    }
}
