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

/** Collects diagnostics, formats messages from diagnostics.json and caps the total. */
export class DiagnosticCollector {
    #language;
    #maximum;
    #capped = false;
    /** @type {Diagnostic[]} */
    items = [];
    hasFatal = false;
    hasErrors = false;

    constructor(language, maximum) {
        this.#language = language;
        this.#maximum = maximum;
    }

    /**
     * @param {string} code
     * @param {Location} location
     * @param {Record<string, unknown>} [args]
     */
    add(code, location, args = {}) {
        const json = entry(code);
        const severity = severityOf(json);
        this.hasFatal ||= severity === DiagnosticSeverity.Fatal;
        this.hasErrors ||= severity === DiagnosticSeverity.Error || severity === DiagnosticSeverity.Fatal;

        if (this.items.length >= this.#maximum && severity !== DiagnosticSeverity.Fatal) {
            if (!this.#capped) {
                this.#capped = true;
                this.items.push(this.#create('XAF-X900', Location.NONE, { max: this.#maximum }));
            }

            return;
        }

        this.items.push(this.#create(code, location, args));
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
