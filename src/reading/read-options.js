import { TextLanguage } from '../definitions/localized-text.js';
import { AuditfileVersion } from '../versioning/version.js';

/** How the reader treats the file. */
export const ReadMode = Object.freeze({
    /** Validate against the XSD first; load only a valid file. */
    Verified: 'verified',
    /** Load directly with the manifest; elements outside the manifest are reported and skipped. */
    Unverified: 'unverified',
});

/** XML events between two checks of the abort signal. @internal */
export const CANCELLATION_INTERVAL = 10_000;

/** Progress of a read. */
export class ReadProgress {
    /** @internal */
    constructor(rowsRead, totalRows) {
        /** Rows read so far. */
        this.rowsRead = rowsRead;
        /** Total rows, when known from the scan phase; otherwise null. */
        this.totalRows = totalRows;
        Object.freeze(this);
    }
}

/**
 * @typedef {object} ReadOptions Options for reading. The defaults suit most uses.
 * @property {AuditfileVersion | string | null} [version] Force a version, e.g. `AuditfileVersion.Financial.V3_2` or "xaf/3.2". Null: determine from the namespace.
 * @property {'verified' | 'unverified'} [mode] Verified (default) or unverified.
 * @property {boolean} [useResolver] Derive the version from an unknown namespace, e.g. ".../XAF/3.2/". Off by default.
 * @property {(() => unknown) | null} [xsd] Own XSD instead of the built-in one, as a factory of bytes or a stream. Null: use the built-in XSD.
 * @property {boolean} [applyDialects] Apply known dialect corrections. On by default.
 * @property {number} [batchSize] Rows per table handed to the sink at once (default 1000).
 * @property {'nl' | 'en'} [language] Language of diagnostic messages (default Dutch).
 * @property {number} [maxDiagnostics] Maximum number of diagnostics; the rest is summarized (default 1000).
 * @property {number} [maxDepth] Maximum element nesting; deeper files are refused (default 64).
 * @property {number} [maxCharactersInDocument] Maximum characters in the whole document, all parts together; a larger file stops with XAF-X001 (default 4 Gi; 0 is no limit).
 * @property {number} [maxValueLength] Maximum characters of one value; a longer value is skipped with XAF-S008 and never held in memory as a whole (default 65536; the longest value an XSD allows is 999).
 * @property {((progress: ReadProgress) => void) | null} [onProgress] Receives progress after every batch.
 * @property {AbortSignal | null} [signal] Cancels reading, in the scan phase as well as the load phase; the call then rejects with the signal's reason.
 */

const DEFAULTS = Object.freeze({
    version: null,
    mode: ReadMode.Verified,
    useResolver: false,
    xsd: null,
    applyDialects: true,
    batchSize: 1000,
    language: TextLanguage.Dutch,
    maxDiagnostics: 1000,
    maxDepth: 64,
    maxCharactersInDocument: 4 * 1024 ** 3,
    maxValueLength: 65_536,
    onProgress: null,
    signal: null,
});

function positiveInteger(name, value) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new RangeError(`${name} must be a positive integer.`);
    }

    return value;
}

function oneOf(name, value, allowed) {
    if (!Object.values(allowed).includes(value)) {
        throw new RangeError(`${name} must be one of ${Object.values(allowed).map((v) => `'${v}'`).join(', ')}.`);
    }

    return value;
}

function optionalFunction(name, value) {
    if (value !== null && typeof value !== 'function') {
        throw new TypeError(`${name} must be a function.`);
    }

    return value;
}

/**
 * Checks and completes options; unknown names are refused so a typo never goes unnoticed.
 * @param {ReadOptions | null | undefined} options
 * @returns {Required<ReadOptions> & { version: AuditfileVersion | null }}
 * @internal
 */
export function normalizeOptions(options) {
    if (options === null || options === undefined) {
        return DEFAULTS;
    }

    if (typeof options !== 'object') {
        throw new TypeError('options must be an object.');
    }

    for (const name of Object.keys(options)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
            throw new TypeError(`Unknown read option '${name}'.`);
        }
    }

    const merged = { ...DEFAULTS };
    for (const name of Object.keys(DEFAULTS)) {
        if (options[name] !== undefined) {
            merged[name] = options[name];
        }
    }

    if (typeof merged.version === 'string') {
        merged.version = AuditfileVersion.parse(merged.version);
    } else if (merged.version !== null && !(merged.version instanceof AuditfileVersion)) {
        throw new TypeError('version must be an AuditfileVersion or a key such as "xaf/3.2".');
    }

    oneOf('mode', merged.mode, ReadMode);
    oneOf('language', merged.language, TextLanguage);
    positiveInteger('batchSize', merged.batchSize);
    positiveInteger('maxDiagnostics', merged.maxDiagnostics);
    positiveInteger('maxDepth', merged.maxDepth);
    positiveInteger('maxValueLength', merged.maxValueLength);
    if (!Number.isSafeInteger(merged.maxCharactersInDocument) || merged.maxCharactersInDocument < 0) {
        throw new RangeError('maxCharactersInDocument must be a non-negative integer.');
    }
    optionalFunction('xsd', merged.xsd);
    optionalFunction('onProgress', merged.onProgress);
    merged.useResolver = merged.useResolver === true;
    merged.applyDialects = merged.applyDialects !== false;
    if (merged.signal !== null && typeof merged.signal?.throwIfAborted !== 'function') {
        throw new TypeError('signal must be an AbortSignal.');
    }

    return Object.freeze(merged);
}
