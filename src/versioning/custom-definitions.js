import { Dialect } from '../definitions/dialect.js';
import { readJson } from '../definitions/resources.js';
import { ViewDefinition } from '../definitions/view-definition.js';
import { isObject, objects, optionalInt, parseObject, string } from '../internal/json.js';
import { AuditfileVersion } from './version.js';

// Dialects and views added at runtime, next to the built-in ones of auditfile-spec. The lists are replaced on every
// change, never modified, so a read that already took a list keeps a consistent one.

/** @type {Map<string, readonly Dialect[]>} By version key. */
const dialectsByVersion = new Map();
/** @type {Map<string, readonly ViewDefinition[]>} By audit file type. */
const viewsByType = new Map();

/** @type {Set<string> | null} */
let dialectCodes = null;

/** @internal Custom dialects of a version, after the built-in ones. */
export function customDialects(key) {
    return dialectsByVersion.get(key) ?? [];
}

/** @internal Custom views of an audit file type, after the built-in ones. */
export function customViews(type) {
    return viewsByType.get(type) ?? [];
}

/** The JSON as an object: text is parsed, an object is used as it is. */
function parse(json, what) {
    const parsed = typeof json === 'string' ? parseObject(json, what) : json;
    if (!isObject(parsed)) {
        throw new TypeError(`${what} must be JSON text or a parsed JSON object.`);
    }

    const format = optionalInt(parsed, 'formatVersion');
    if (format !== null && format !== 1) {
        throw new SyntaxError(`${what}: formatVersion ${format} is not supported; this reader reads format 1.`);
    }

    return parsed;
}

function toVersion(version) {
    if (typeof version === 'string') {
        return AuditfileVersion.parse(version);
    }

    if (!(version instanceof AuditfileVersion)) {
        throw new TypeError('version must be an AuditfileVersion or a key such as "xaf/3.2".');
    }

    return version;
}

/** Throws when a name is used twice in the new definitions or is already taken. */
function checkNames(added, existing, what, owner) {
    const names = new Set(existing.map((d) => d.name));
    for (const definition of added) {
        if (names.has(definition.name)) {
            throw new RangeError(`${what} '${definition.name}' already exists for ${owner}.`);
        }

        names.add(definition.name);
    }
}

function checkCodes(dialect) {
    dialectCodes ??= new Set(objects(readJson('diagnostics.json'), 'codes')
        .filter((c) => string(c, 'layer') === 'dialect').map((c) => string(c, 'code')));
    for (const correction of dialect.corrections) {
        if (!dialectCodes.has(correction.code)) {
            throw new SyntaxError(`Dialect '${dialect.name}': ${correction.code} is not a dialect diagnostic (${[...dialectCodes].join(', ')}).`);
        }
    }
}

/**
 * Dialects added at runtime, available as {@link Auditfile.dialects}. They are used like the built-in dialects of
 * the version: recognized by namespace or header/softwareDesc, unless the read option `applyDialects` is false.
 */
export class DialectRegistry {
    /**
     * Adds the dialects of a file in the format of dialects.json of auditfile-spec: `{ "formatVersion": 1, "dialects": [...] }`.
     * The whole file is refused when any dialect is invalid or has a name the version already knows.
     * @param {AuditfileVersion | string} version The version the dialects are for, e.g. `AuditfileVersion.Financial.V3_2` or "xaf/3.2".
     * @param {string | object} json JSON text, or the parsed object.
     * @returns {readonly Dialect[]} The added dialects.
     * @throws {SyntaxError} The JSON is invalid.
     * @throws {RangeError} The version is unknown or a dialect name is taken.
     */
    add(version, json) {
        const target = toVersion(version);
        const added = objects(parse(json, 'Dialects'), 'dialects').map((d) => new Dialect(d));
        added.forEach(checkCodes);
        checkNames(added, target.dialects, 'Dialect', target.key);
        dialectsByVersion.set(target.key, Object.freeze([...customDialects(target.key), ...added]));
        return Object.freeze(added);
    }

    /**
     * Removes an added dialect. Built-in dialects cannot be removed.
     * @param {AuditfileVersion | string} version
     * @param {string} name
     * @returns {boolean} True when the dialect was found and removed.
     */
    remove(version, name) {
        const key = toVersion(version).key;
        const list = customDialects(key);
        const kept = list.filter((d) => d.name !== name);
        if (kept.length === list.length) {
            return false;
        }

        dialectsByVersion.set(key, Object.freeze(kept));
        return true;
    }

    /** Removes all added dialects, of every version. */
    clear() {
        dialectsByVersion.clear();
    }
}

/**
 * Views added at runtime, available as {@link Auditfile.views}. They appear in `AuditfileVersion.views` and
 * `findView` of every version of their type, after the built-in views.
 */
export class ViewRegistry {
    /**
     * Adds the views of a file in the format of views/&lt;type&gt;.json of auditfile-spec:
     * `{ "formatVersion": 1, "type": "xaf", "views": [...] }`. The whole file is refused when any view is invalid
     * or has a name the type already knows. Whether a view fits a version is decided when it runs (XAF-Q001).
     * @param {string | object} json JSON text, or the parsed object.
     * @returns {readonly ViewDefinition[]} The added views.
     * @throws {SyntaxError} The JSON is invalid.
     * @throws {RangeError} The type is unknown or a view name is taken.
     */
    add(json) {
        const parsed = parse(json, 'Views');
        const type = string(parsed, 'type');
        const version = AuditfileVersion.all.find((v) => v.type === type);
        if (version === undefined) {
            throw new RangeError(`Unknown audit file type '${type}'.`);
        }

        const added = objects(parsed, 'views').map((v) => new ViewDefinition(v));
        checkNames(added, version.views, 'View', type);
        viewsByType.set(type, Object.freeze([...customViews(type), ...added]));
        return Object.freeze(added);
    }

    /**
     * Removes an added view. Built-in views cannot be removed.
     * @param {string} type Audit file type, e.g. "xaf".
     * @param {string} name
     * @returns {boolean} True when the view was found and removed.
     */
    remove(type, name) {
        const list = customViews(type);
        const kept = list.filter((v) => v.name !== name);
        if (kept.length === list.length) {
            return false;
        }

        viewsByType.set(type, Object.freeze(kept));
        return true;
    }

    /** Removes all added views, of every type. */
    clear() {
        viewsByType.clear();
    }
}
