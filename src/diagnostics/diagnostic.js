/** Severity of a diagnostic, from least to most severe. */
export const DiagnosticSeverity = Object.freeze({
    /** Information only. */
    Info: 'info',
    /** Something to look at; the result is still usable. */
    Warning: 'warning',
    /** The file does not meet the standard. */
    Error: 'error',
    /** Reading stopped. */
    Fatal: 'fatal',
});

const RANK = new Map([['info', 0], ['warning', 1], ['error', 2], ['fatal', 3]]);

/**
 * Orders severities: negative when `a` is less severe than `b`.
 * @param {string} a
 * @param {string} b
 */
export function compareSeverity(a, b) {
    return RANK.get(a) - RANK.get(b);
}

/** A finding about an audit file, with a stable code from auditfile-spec. */
export class Diagnostic {
    /** @internal */
    constructor(code, layer, severity, message, part, line, position, path) {
        /** Code, e.g. "XAF-R001". */
        this.code = code;
        /** "xml", "version", "structure", "xsd", "rules", "dialect" or "view". */
        this.layer = layer;
        /** Severity, one of {@link DiagnosticSeverity}. */
        this.severity = severity;
        /** Message in the requested language. */
        this.message = message;
        /** Source part (1-based), when known; otherwise null. */
        this.part = part;
        /** Line number, when known; otherwise null. */
        this.line = line;
        /** Position on the line, when known; otherwise null. */
        this.position = position;
        /** XML path, when known; otherwise null. */
        this.path = path;
        Object.freeze(this);
    }

    toString() {
        const severity = this.severity[0].toUpperCase() + this.severity.slice(1);
        return this.line === null
            ? `${this.code} ${severity}: ${this.message}`
            : `${this.code} ${severity} (line ${this.line}): ${this.message}`;
    }
}
