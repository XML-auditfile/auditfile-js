import { Location } from '../diagnostics/collector.js';
import { ColumnType } from '../definitions/manifest.js';
import { DialectAction } from '../definitions/names.js';
import { SourceError } from '../internal/streams.js';
import { END, START, TEXT, XmlEncodingError, XmlSyntaxError } from '../internal/xml-reader.js';
import { MappingPlan } from './mapping-plan.js';
import { AuditfileRow } from './row.js';
import { CANCELLATION_INTERVAL, ReadMode } from './read-options.js';
import { tryConvert } from './value-converter.js';

const XMLNS = 'http://www.w3.org/2000/xmlns/';
const XSI = 'http://www.w3.org/2001/XMLSchema-instance';

/** An open table element. */
class Frame {
    #ordinals = null;

    constructor(plan, id, parentId, ordinal, part, node) {
        this.plan = plan;
        this.id = id;
        this.parentId = parentId;
        this.ordinal = ordinal;
        this.part = part;
        /** @type {import('./mapping-plan.js').PathNode} */
        this.node = node;
        this.values = new Array(plan.table.columns.length).fill(null);
        /** Columns that occurred, also when their value was invalid. */
        this.present = new Array(plan.table.columns.length).fill(false);
        /** @type {Set<import('./mapping-plan.js').PathNode>} Groups that occurred within this row. */
        this.groups = new Set();
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
    /** @type {import('./mapping-plan.js').PathNode[]} The open elements. */
    #nodes = [];
    #frames = [];
    #ready = [];
    #reported = new Set();
    #corrections = new Map();
    #nextId = 0;
    #skipDepth = null;
    #capture = null;
    #event = null;
    #checkRequired;

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
        // Without the XSD nobody else notices a missing required field; with it, XAF-D001 already does.
        this.#checkRequired = options.mode === ReadMode.Unverified;
    }

    /** @returns {AsyncGenerator<AuditfileRow>} Rows in document order of their closing tags. */
    async *rows() {
        const signal = this.#options.signal;
        let events = 0;
        for (;;) {
            if (events++ % CANCELLATION_INTERVAL === 0) {
                signal?.throwIfAborted();
            }

            let event;
            try {
                event = this.#reader.poll() ?? await this.#reader.next();
            } catch (error) {
                if (error instanceof XmlSyntaxError) {
                    this.#diagnostics.add('XAF-X001', new Location(error.part, error.line, error.column, this.#currentPath), { detail: error.message });
                } else if (error instanceof XmlEncodingError) {
                    this.#diagnostics.add('XAF-X004', new Location(error.part, null, null, this.#currentPath), { encoding: error.encoding });
                } else if (error instanceof SourceError) {
                    this.#diagnostics.add('XAF-X002', new Location(null, null, null, this.#currentPath), { part: error.part, detail: error.message });
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
                        // Beyond the maximum the value is only counted, never kept.
                        this.#capture.length += event.text.length;
                        if (this.#capture.length <= this.#options.maxValueLength) {
                            this.#capture.text += event.text;
                        }
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
        return this.#nodes.at(-1)?.path ?? null;
    }

    /** The open element, or the node above the root element before it opens. */
    get #current() {
        return this.#nodes.at(-1) ?? this.#plan.root;
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

        const node = event.ns === this.#namespace ? this.#current.children.get(event.local) : undefined;
        if (node === undefined) {
            this.#skip(this.#current.childPath(event.local), event);
            return;
        }

        const owner = this.#top;
        if (node.table !== null) {
            this.#startTable(node, node.table, event);
        } else if (node.column !== null && owner !== null && owner.plan === node.column.table) {
            this.#capture = { frame: owner, column: node.column.column, path: node.path, text: '', length: 0, emit: false };
        } else if (node.isGroup) {
            if (owner !== null) {
                owner.groups.add(node);
                this.#readAttributes(node, owner, event);
            }

            this.#nodes.push(node);
        } else {
            this.#skip(node.path, event);
        }
    }

    #startTable(node, table, event) {
        const parent = this.#top;
        const frame = new Frame(table, ++this.#nextId, parent?.id ?? null, parent?.nextOrdinal(table) ?? 1, event.part, node);
        this.#readAttributes(node, frame, event);
        if (table.isValueTable) {
            this.#capture = { frame, column: table.table.columns[0], path: node.path, text: '', length: 0, emit: true };
            return;
        }

        this.#frames.push(frame);
        this.#nodes.push(node);
    }

    #end(event) {
        if (this.#skipDepth !== null) {
            if (event.depth === this.#skipDepth) {
                this.#skipDepth = null;
            }

            return;
        }

        if (this.#capture !== null) {
            const { frame, column, path, text, length, emit } = this.#capture;
            this.#capture = null;
            if (length > this.#options.maxValueLength) {
                frame.present[column.index] = true;
                this.#diagnostics.add('XAF-S008', this.#here(path),
                    { table: frame.plan.table.name, column: column.name, length, max: this.#options.maxValueLength });
            } else {
                this.#setValue(frame, column, text, path);
            }
            if (emit) {
                this.#emit(frame);
            }

            return;
        }

        const node = this.#nodes.pop();
        if (node !== undefined && this.#top?.node === node) {
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

    #readAttributes(element, frame, event) {
        for (const attribute of event.attributes) {
            if (attribute.ns === XMLNS || attribute.ns === XSI || attribute.local === 'xmlns' || attribute.prefix === 'xmlns') {
                continue;
            }

            const target = element.attributes.get(attribute.local);
            if (target?.column != null && target.column.table === frame.plan) {
                this.#setValue(frame, target.column.column, attribute.value, target.path);
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

        frame.present[column.index] = true;
        if (path === this.#softwarePath && typeof value === 'string' && this.#resolution.useSoftware(value, this.#options.applyDialects)) {
            this.#useDialect(this.#resolution.dialect);
        }
    }

    #correct(raw, corrections, column, path) {
        for (const correction of corrections) {
            let corrected = raw;
            if (correction.action === DialectAction.DecimalComma && raw.includes(',') && !raw.includes('.')) {
                corrected = raw.replaceAll(',', '.');
            } else if (correction.action === DialectAction.DateFromDateTime && column.type === ColumnType.Date && raw.trim().length > 10) {
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
            if (correction.action === DialectAction.ReplaceNamespace) {
                continue;
            }

            for (const path of correction.paths) {
                const list = this.#corrections.get(path) ?? [];
                list.push(correction);
                this.#corrections.set(path, list);
            }
        }
    }

    /**
     * XAF-S006 for each required column the row lacks. minOccurs is relative to the column's XML parent:
     * a column inside an optional group is only required when that group occurs.
     */
    #checkRequiredColumns(frame) {
        for (const { column, group } of frame.plan.required) {
            if (!frame.present[column.index] && (group === null || frame.groups.has(group))) {
                this.#diagnostics.add('XAF-S006', this.#here(frame.node.path), { column: column.name, table: frame.plan.table.name });
            }
        }
    }

    #emit(frame) {
        if (this.#checkRequired) {
            this.#checkRequiredColumns(frame);
        }

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
