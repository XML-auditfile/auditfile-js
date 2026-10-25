import { int, object, objects, optionalInt, optionalString, string, strings } from '../internal/json.js';

/** Logical type of a column; the values are the type names of auditfile-spec. */
export const ColumnType = Object.freeze({
    /** Text (`string`). */
    String: 'string',
    /** Exact decimal number (`Decimal`). */
    Decimal: 'decimal',
    /** Whole number (`number`, always a safe integer). */
    Integer: 'integer',
    /** Date without time (`Date` at midnight UTC). */
    Date: 'date',
    /** Date and time (`Date`; a value without time zone is taken as UTC). */
    DateTime: 'datetime',
    /** Time of day (`string` "HH:MM:SS"). */
    Time: 'time',
    /** True or false (`boolean`). */
    Boolean: 'boolean',
});

const COLUMN_TYPES = new Set(Object.values(ColumnType));

/** @param {string} type */
export function parseColumnType(type) {
    if (!COLUMN_TYPES.has(type)) {
        throw new SyntaxError(`Unknown column type '${type}'.`);
    }

    return type;
}

/** The structure of one audit file version, from manifest.json. */
export class AuditfileManifest {
    #byName;

    /** @internal */
    constructor(json) {
        /** Format version of manifest.json. */
        this.formatVersion = int(json, 'formatVersion');
        if (this.formatVersion !== 1) {
            throw new Error(`Manifest format version ${this.formatVersion} is not supported by this reader.`);
        }

        /** Audit file type, e.g. "xaf". */
        this.standard = string(json, 'standard');
        /** Version, e.g. "3.2". */
        this.version = string(json, 'version');
        /** Official namespace. */
        this.namespace = string(json, 'namespace');
        /** Name of the root element. */
        this.rootElement = string(json, 'rootElement');
        /** SHA-256 of the official XSD. */
        this.xsdSha256 = optionalString(object(json, 'xsd') ?? {}, 'sha256') ?? '';
        /** Tables required by the XSD. */
        this.requiredTables = Object.freeze(strings(json, 'requiredTables'));
        /** Tables optional in the XSD but expected in practice. */
        this.expectedTables = Object.freeze(strings(json, 'expectedTables'));
        /** All tables in document order. */
        this.tables = Object.freeze(objects(json, 'tables').map((t, i) => new ManifestTable(t, i)));
        this.#byName = new Map(this.tables.map((t) => [t.name, t]));
        Object.freeze(this);
    }

    /**
     * Finds a table by name, or returns null.
     * @param {string} name
     */
    findTable(name) {
        return this.#byName.get(name) ?? null;
    }
}

/** A table of the manifest. */
export class ManifestTable {
    /** @internal */
    constructor(json, index) {
        /** Position in the manifest. */
        this.index = index;
        /** Table name, e.g. "tr_line". */
        this.name = string(json, 'name');
        /** Element name, e.g. "trLine". */
        this.xmlName = string(json, 'xmlName');
        /** Full XML path, e.g. "auditfile/company/transactions/journal/transaction/trLine". */
        this.path = string(json, 'path');
        /** Name of the parent table, or null for the root. */
        this.parent = optionalString(json, 'parent');
        /** Minimum occurrences relative to the XML parent element. */
        this.minOccurs = int(json, 'minOccurs');
        /** Maximum occurrences relative to the XML parent element; null means unbounded. */
        this.maxOccurs = optionalInt(json, 'maxOccurs');
        /** Natural keys. */
        this.keys = Object.freeze(objects(json, 'keys').map((k) => new ManifestKey(string(k, 'name'), strings(k, 'columns'))));
        /** References to keys of other tables. */
        this.references = Object.freeze(objects(json, 'references').map((r) =>
            new ManifestReference(string(r, 'name'), strings(r, 'columns'), string(r, 'table'), string(r, 'key'))));
        /** Columns in XSD order. */
        this.columns = Object.freeze(objects(json, 'columns').map((c, i) => new ManifestColumn(c, i)));
        Object.freeze(this);
    }
}

/** A column of a manifest table. */
export class ManifestColumn {
    /** @internal */
    constructor(json, index) {
        /** Position within the table. */
        this.index = index;
        /** Column name, e.g. "amnt". */
        this.name = string(json, 'name');
        /** Element or attribute name. */
        this.xmlName = string(json, 'xmlName');
        /** Path relative to the table element: "amnt", "currency/curCode", "@attr" or ".". */
        this.path = string(json, 'path');
        /** "element" or "attribute". */
        this.kind = string(json, 'kind');
        /** Logical type, one of {@link ColumnType}. */
        this.type = parseColumnType(string(json, 'type'));
        /** Name of the XSD type. */
        this.xsdType = string(json, 'xsdType');
        /** Minimum occurrences relative to the XML parent element. */
        this.minOccurs = int(json, 'minOccurs');
        Object.freeze(this);
    }
}

/** A natural key: the column values are unique within an import. */
export class ManifestKey {
    /**
     * @param {string} name
     * @param {string[]} columns
     */
    constructor(name, columns) {
        /** Key name from the XSD. */
        this.name = name;
        /** Key columns. */
        this.columns = Object.freeze([...columns]);
        Object.freeze(this);
    }
}

/** A reference from columns of one table to a key of another table. */
export class ManifestReference {
    /**
     * @param {string} name
     * @param {string[]} columns
     * @param {string} table
     * @param {string} key
     */
    constructor(name, columns, table, key) {
        /** Reference name from the XSD. */
        this.name = name;
        /** Referencing columns. */
        this.columns = Object.freeze([...columns]);
        /** Referenced table. */
        this.table = table;
        /** Referenced key. */
        this.key = key;
        Object.freeze(this);
    }
}
