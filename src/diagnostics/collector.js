import { LocalizedText } from '../definitions/localized-text.js';
import { readJson } from '../definitions/resources.js';
import { Decimal } from '../internal/decimal.js';
import { object, objects, string } from '../internal/json.js';
import { toText } from '../reading/value-converter.js';
import { Diagnostic, DiagnosticSeverity } from './diagnostic.js';

/** Where a diagnostic applies. */
export class Location {
    constructor(part = null, line = null, position = null, path = null) {
        this.part = part;
        this.line = line;
        this.position = position;
        this.path = path;
        Object.freeze(this);
    }

    static NONE = new Location();
}

const SEVERITIES = new Set(Object.values(DiagnosticSeverity));

/** @type {Map<string, object> | null} */
let catalog = null;

function entry(code) {
    catalog ??= new Map(objects(readJson('diagnostics.json'), 'codes').map((c) => [string(c, 'code'), c]));
    const found = catalog.get(code);
    if (found === undefined) {
        throw new Error(`Diagnostic code ${code} is not defined in diagnostics.json.`);
    }

    return found;
}

function severityOf(json) {
    const severity = string(json, 'severity');
    return SEVERITIES.has(severity) ? severity : DiagnosticSeverity.Fatal;
}

function format(value) {
    return value instanceof Decimal ? value.toString() : toText(value);
}
/**
 * Collects diagnostics, formats messages from diagnostics.json and caps the list.
 * The counts per severity cover every diagnostic, also the ones left out of a full list,
 * and a full list makes room for an error by dropping an info or warning, so errors are never hidden behind them.
 */
export class DiagnosticCollector {
    #language;
    #maximum;
    /** @type {Diagnostic | null} */
    #capped = null;
    /** @type {Diagnostic[]} */
    #items = [];
    /** Number of diagnostics per severity, including the ones left out. */
    counts = { info: 0, warning: 0, error: 0, fatal: 0 };

    constructor(language, maximum) {
        this.#language = language;
        this.#maximum = maximum;
    }

    /** @type {Diagnostic[]} The kept diagnostics, followed by XAF-X900 when some were left out. */
    get items() {
        return this.#capped === null ? this.#items : [...this.#items, this.#capped];
    }

    get hasFatal() {
        return this.counts.fatal > 0;
    }

    get hasErrors() {
        return this.hasFatal || this.counts.error > 0;
    }

    /** True when diagnostics were left out of {@link DiagnosticCollector#items}. */
    get isTruncated() {
        return this.#capped !== null;
    }

    /**
     * @param {string} code
     * @param {Location} location
     * @param {Record<string, unknown>} [args]
     */
    add(code, location, args = {}) {
        const json = entry(code);
        const severity = severityOf(json);
        this.counts[severity]++;

        if (this.#items.length >= this.#maximum && !this.#makeRoomFor(severity)) {
            this.#capped ??= this.#create('XAF-X900', Location.NONE, { max: this.#maximum });
            return;
        }

        this.#items.push(this.#create(code, location, args));
    }

    /**
     * A fatal diagnostic is always kept. An error replaces the last info or warning in the list;
     * a dropped diagnostic still counts, and the list is marked as truncated.
     */
    #makeRoomFor(severity) {
        if (severity === DiagnosticSeverity.Fatal) {
            return true;
        }

        if (severity !== DiagnosticSeverity.Error) {
            return false;
        }

        let index = this.#items.findLastIndex((d) => d.severity === DiagnosticSeverity.Info);
        if (index < 0) {
            index = this.#items.findLastIndex((d) => d.severity === DiagnosticSeverity.Warning);
        }

        if (index < 0) {
            return false;
        }

        this.#items.splice(index, 1);
        this.#capped ??= this.#create('XAF-X900', Location.NONE, { max: this.#maximum });
        return true;
    }

    #create(code, location, args) {
        const json = entry(code);
        let message = LocalizedText.from(object(json, 'message'))?.get(this.#language) ?? code;
        for (const [name, value] of Object.entries(args)) {
            // A replacer function: values come from the file and must never be read as replacement patterns ($&, $1).
            const text = format(value);
            message = message.replaceAll(`{${name}}`, () => text);
        }

        return new Diagnostic(code, string(json, 'layer'), severityOf(json), message,
            location.part, location.line, location.position, location.path);
    }
}
