import { ManifestKey, ManifestReference, parseColumnType } from '../definitions/manifest.js';
import { bool, int, objects, optionalInt, optionalString, parseObject, string, strings } from '../internal/json.js';
import { AuditfileVersion } from '../versioning/version.js';

/** How the version of an import was determined. */
export const VersionSource = Object.freeze({
    /** The file uses the official namespace. */
    Official: 'official',
    /** The file uses a known alias namespace. */
    Alias: 'alias',
    /** The caller forced the version. */
    Forced: 'forced',
    /** The resolver derived the version from the namespace. */
    Resolved: 'resolved',
});

const SOURCES = new Set(Object.values(VersionSource));

/** Format version written by toJson; fromJson refuses any other. */
const FORMAT_VERSION = 1;

/**
 * The schema of one import: tables, columns, types, keys, references, row counts and origin.
 * This is the contract everything after the reader builds on, regardless of where the data is stored.
 * Converts to and from JSON without loss (definitions are re-attached from the version when known).
 */
export class AuditfileSchema {
    #byName;

    /** @internal */
    constructor(versionKey, fileNamespace, source, dialect, hasRowCounts, tables) {
        /** Version key, e.g. "xaf/3.2". */
        this.versionKey = versionKey;
        /** @type {AuditfileVersion | null} The version, or null when this reader does not know it (schema loaded from JSON). */
        this.version = AuditfileVersion.find(versionKey);
        /** Namespace as found in the file. */
        this.namespace = fileNamespace;
        /** How the version was determined, one of {@link VersionSource}. */
        this.source = source;
        /** Name of the applied dialect, or null. */
        this.dialect = dialect;
        /** True when the row count is known for every table. */
        this.hasRowCounts = hasRowCounts;
        /** @type {readonly SchemaTable[]} All tables in document order. */
        this.tables = Object.freeze([...tables]);
        this.#byName = new Map(this.tables.map((t) => [t.name, t]));
        Object.freeze(this);
    }

    /**
     * Finds a table by name, or returns null.
     * @param {string} name
     * @returns {SchemaTable | null}
     */
    findTable(name) {
        return this.#byName.get(name) ?? null;
    }

    /**
     * Returns a table by name.
     * @param {string} name
     * @throws {RangeError} The table does not exist.
     */
    table(name) {
        const table = this.findTable(name);
        if (table === null) {
            throw new RangeError(`Table '${name}' does not exist.`);
        }

        return table;
    }

    /** Serializes the schema to compact JSON, e.g. for storage in a database. */
    toJson() {
        return JSON.stringify({
            formatVersion: FORMAT_VERSION,
            version: this.versionKey,
            namespace: this.namespace,
            source: this.source,
            dialect: this.dialect,
            hasRowCounts: this.hasRowCounts,
            tables: this.tables.map((table) => ({
                name: table.name,
                xmlName: table.xmlName,
                path: table.path,
                parent: table.parent,
                minOccurs: table.minOccurs,
                maxOccurs: table.maxOccurs,
                required: table.isRequired,
                expected: table.isExpected,
                rowCount: table.rowCount,
                keys: table.keys.map((key) => ({ name: key.name, columns: key.columns })),
                references: table.references.map((reference) => ({
                    name: reference.name, columns: reference.columns, table: reference.table, key: reference.key,
                })),
                columns: table.columns.map((column) => ({
                    name: column.name,
                    xmlName: column.xmlName,
                    path: column.path,
                    kind: column.kind,
                    type: column.type,
                    xsdType: column.xsdType,
                    minOccurs: column.minOccurs,
                })),
            })),
        });
    }

    /**
     * Reads a schema written by {@link AuditfileSchema#toJson}.
     * @param {string} json
     * @throws {SyntaxError} The JSON is not a valid schema, or uses a format version, column type or version source this reader does not know.
     */
    static fromJson(json) {
        if (typeof json !== 'string') {
            throw new TypeError('json must be a string.');
        }

        const root = parseObject(json, 'Schema JSON');
        if (root.formatVersion !== FORMAT_VERSION) {
            throw new SyntaxError(`Schema JSON format version ${root.formatVersion ?? '(missing)'} is not supported; this reader reads format version ${FORMAT_VERSION}.`);
        }

        const versionKey = string(root, 'version');
        const definitions = AuditfileVersion.find(versionKey)?.definitions ?? null;
        const lookup = (key) => definitions?.get(key) ?? null;

        const tables = objects(root, 'tables').map((t, index) => {
            const name = string(t, 'name');
            const columns = objects(t, 'columns').map((c, i) => new SchemaColumn(
                string(c, 'name'), string(c, 'xmlName'), string(c, 'path'), string(c, 'kind'),
                parseColumnType(string(c, 'type')), string(c, 'xsdType'), int(c, 'minOccurs'), i,
                lookup(`${name}.${string(c, 'name')}`)));

            return new SchemaTable(
                name, string(t, 'xmlName'), string(t, 'path'), optionalString(t, 'parent'),
                int(t, 'minOccurs'), optionalInt(t, 'maxOccurs'), bool(t, 'required'), bool(t, 'expected'),
                optionalInt(t, 'rowCount'), index, columns,
                objects(t, 'keys').map((k) => new ManifestKey(string(k, 'name'), strings(k, 'columns'))),
                objects(t, 'references').map((r) => new ManifestReference(string(r, 'name'), strings(r, 'columns'), string(r, 'table'), string(r, 'key'))),
                lookup(name));
        });

        const source = string(root, 'source');
        if (!SOURCES.has(source)) {
            throw new SyntaxError(`Unknown version source '${source}' in schema JSON.`);
        }

        return new AuditfileSchema(versionKey, string(root, 'namespace'), source,
            optionalString(root, 'dialect'), bool(root, 'hasRowCounts'), tables);
    }

    /**
     * @internal
     * @param {AuditfileVersion} version
     * @param {Map<string, number> | null} rowCounts
     */
    static create(version, fileNamespace, source, dialect, rowCounts) {
        const manifest = version.manifest;
        const definitions = version.definitions;
        const required = new Set(manifest.requiredTables);
        const expected = new Set(manifest.expectedTables);

        const tables = manifest.tables.map((t) => new SchemaTable(
            t.name, t.xmlName, t.path, t.parent, t.minOccurs, t.maxOccurs, required.has(t.name), expected.has(t.name),
            rowCounts === null ? null : rowCounts.get(t.name) ?? 0,
            t.index,
            t.columns.map((c) => new SchemaColumn(c.name, c.xmlName, c.path, c.kind, c.type, c.xsdType, c.minOccurs, c.index,
                definitions.get(`${t.name}.${c.name}`) ?? null)),
            t.keys, t.references, definitions.get(t.name) ?? null));

        return new AuditfileSchema(version.key, fileNamespace, source, dialect, rowCounts !== null, tables);
    }
}

/** A table of an import. */
export class SchemaTable {
    #byName;

    /** @internal */
    constructor(name, xmlName, path, parent, minOccurs, maxOccurs, isRequired, isExpected, rowCount, index, columns, keys, references, definition) {
        /** Table name, e.g. "tr_line". */
        this.name = name;
        /** Element name, e.g. "trLine". */
        this.xmlName = xmlName;
        /** Full XML path. */
        this.path = path;
        /** Parent table name, or null for the root. */
        this.parent = parent;
        /** Minimum occurrences relative to the XML parent element. */
        this.minOccurs = minOccurs;
        /** Maximum occurrences relative to the XML parent element; null means unbounded. */
        this.maxOccurs = maxOccurs;
        /** Required by the standard. */
        this.isRequired = isRequired;
        /** Expected in practice. */
        this.isExpected = isExpected;
        /** Number of rows, when known from the scan phase; otherwise null. */
        this.rowCount = rowCount;
        /** Position in the schema. */
        this.index = index;
        /** @type {readonly SchemaColumn[]} Columns; {@link AuditfileRow#values} uses the same order. */
        this.columns = Object.freeze([...columns]);
        /** @type {readonly ManifestKey[]} Natural keys. */
        this.keys = Object.freeze([...keys]);
        /** @type {readonly ManifestReference[]} References to keys of other tables. */
        this.references = Object.freeze([...references]);
        /** @type {import('../definitions/element-definition.js').ElementDefinition | null} Documentation, when available. */
        this.definition = definition;
        this.#byName = new Map(this.columns.map((c) => [c.name, c]));
        Object.freeze(this);
    }

    /**
     * Finds a column by name, or returns null.
     * @param {string} name
     * @returns {SchemaColumn | null}
     */
    findColumn(name) {
        return this.#byName.get(name) ?? null;
    }

    toString() {
        return this.name;
    }
}

/** A column of an import table. */
export class SchemaColumn {
    /** @internal */
    constructor(name, xmlName, path, kind, type, xsdType, minOccurs, index, definition) {
        /** Column name. */
        this.name = name;
        /** Element or attribute name. */
        this.xmlName = xmlName;
        /** Path relative to the table element. */
        this.path = path;
        /** "element" or "attribute". */
        this.kind = kind;
        /** Logical type, one of {@link ColumnType}; determines the JavaScript type of the value. */
        this.type = type;
        /** XSD type name. */
        this.xsdType = xsdType;
        /** Minimum occurrences relative to the XML parent element. */
        this.minOccurs = minOccurs;
        /** Position in {@link AuditfileRow#values}. */
        this.index = index;
        /** @type {import('../definitions/element-definition.js').ElementDefinition | null} Documentation, when available. */
        this.definition = definition;
        Object.freeze(this);
    }

    toString() {
        return this.name;
    }
}
