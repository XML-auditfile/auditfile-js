import { SEPARATOR } from '../internal/composite-key.js';
import { Decimal } from '../internal/decimal.js';
import { digitsOf, normalizeWhiteSpace } from './datatypes.js';
import { qualified } from './schema-set.js';

const XSI = 'http://www.w3.org/2001/XMLSchema-instance';
const XMLNS = 'http://www.w3.org/2000/xmlns/';
const MAX_PENDING_REFERENCES = 100_000;
const MAX_SHOWN = 100;
const NONE = Object.freeze([]);

/** Shortens a value for a message; values come from the file and can be long. */
function shown(value) {
    return value.length > MAX_SHOWN ? `${value.slice(0, MAX_SHOWN)}…` : value;
}

function lengthOf(value) {
    let length = 0;
    for (const _ of value) {
        length++;
    }

    return length;
}

/**
 * Validates a simple value against a compiled simple type.
 * @returns {{ value: string } | { error: string }}
 */
export function validateSimple(type, raw) {
    const text = normalizeWhiteSpace(raw, type.whiteSpace);
    const parsed = type.builtin.parse(text);
    if (parsed === null) {
        return { error: `'${shown(text)}' is not a valid value of the atomic type '${type.name}'.` };
    }

    const steps = [];
    for (let step = type; step !== null; step = step.base) {
        if (step.facets !== null) {
            steps.unshift(step);
        }
    }

    for (const { facets } of steps) {
        const error = checkFacets(facets, text, parsed);
        if (error !== null) {
            return { error };
        }
    }

    return { value: text };
}

function checkFacets(facets, text, parsed) {
    const numeric = parsed instanceof Decimal;
    if (facets.enumeration !== null
        && !facets.enumeration.some((option) => (numeric && option instanceof Decimal ? option.equals(parsed) : option === text))) {
        return `[facet 'enumeration'] The value '${shown(text)}' is not an element of the set of allowed values.`;
    }

    if (facets.patterns.length > 0 && !facets.patterns.some((p) => p.regex.test(text))) {
        return `[facet 'pattern'] The value '${shown(text)}' is not accepted by the pattern '${facets.patterns.map((p) => p.source).join("' | '")}'.`;
    }

    if (!numeric && (facets.length !== null || facets.minLength !== null || facets.maxLength !== null)) {
        const length = lengthOf(text);
        if (facets.length !== null && length !== facets.length) {
            return `[facet 'length'] The value '${shown(text)}' has a length of '${length}'; this differs from the allowed length of '${facets.length}'.`;
        }

        if (facets.minLength !== null && length < facets.minLength) {
            return `[facet 'minLength'] The value '${shown(text)}' has a length of '${length}'; this underruns the allowed minimum length of '${facets.minLength}'.`;
        }

        if (facets.maxLength !== null && length > facets.maxLength) {
            return `[facet 'maxLength'] The value '${shown(text)}' has a length of '${length}'; this exceeds the allowed maximum length of '${facets.maxLength}'.`;
        }
    }

    if (numeric) {
        const digits = digitsOf(parsed);
        if (facets.totalDigits !== null && digits.total > facets.totalDigits) {
            return `[facet 'totalDigits'] The value '${shown(text)}' has more digits than are allowed ('${facets.totalDigits}').`;
        }

        if (facets.fractionDigits !== null && digits.fraction > facets.fractionDigits) {
            return `[facet 'fractionDigits'] The value '${shown(text)}' has more fractional digits than are allowed ('${facets.fractionDigits}').`;
        }

        if (facets.minInclusive !== null && parsed.compareTo(facets.minInclusive) < 0) {
            return `[facet 'minInclusive'] The value '${shown(text)}' is less than the minimum value allowed ('${facets.minInclusive}').`;
        }

        if (facets.maxInclusive !== null && parsed.compareTo(facets.maxInclusive) > 0) {
            return `[facet 'maxInclusive'] The value '${shown(text)}' is greater than the maximum value allowed ('${facets.maxInclusive}').`;
        }

        if (facets.minExclusive !== null && parsed.compareTo(facets.minExclusive) <= 0) {
            return `[facet 'minExclusive'] The value '${shown(text)}' must be greater than '${facets.minExclusive}'.`;
        }

        if (facets.maxExclusive !== null && parsed.compareTo(facets.maxExclusive) >= 0) {
            return `[facet 'maxExclusive'] The value '${shown(text)}' must be less than '${facets.maxExclusive}'.`;
        }
    }

    return null;
}

/** The value used to compare key fields: numbers by value, everything else as normalized text. */
function keyValue(type, value) {
    if (type?.builtin?.numeric) {
        const parsed = type.builtin.parse(value);
        if (parsed instanceof Decimal) {
            return parsed.normalize().toString();
        }
    }

    return value;
}

/**
 * Streaming validator for a compiled {@link SchemaSet}. Feed it the element events of a document in order;
 * it reports every violation through `report(message, line, column)` and never stops on its own.
 */
export class XsdValidator {
    #set;
    #report;
    /** @type {object[]} */
    #stack = [];
    #ids = new Set();

    /**
     * @param {import('./schema-set.js').SchemaSet} set
     * @param {(message: string, line: number | null, column: number | null) => void} report
     */
    #maxValueLength;
    #identityConstraints;

    /**
     * @param {number} [maxValueLength] Longer values are not kept and not checked; the reader reports them (XAF-S008).
     * @param {boolean} [identityConstraints] Evaluate key, unique and keyref; off when another check does that work.
     */
    constructor(set, report, maxValueLength = Infinity, identityConstraints = true) {
        this.#maxValueLength = maxValueLength;
        this.#identityConstraints = identityConstraints;
        this.#set = set;
        this.#report = report;
    }

    /** @param {{ ns: string, local: string, attributes: { ns: string, local: string, value: string }[], line: number, column: number, depth: number }} event */
    start(event) {
        const parent = this.#stack.at(-1);
        let declaration = null;
        if (parent === undefined) {
            declaration = this.#set.elements.get(qualified(event.ns, event.local)) ?? null;
            if (declaration === null) {
                this.#error(event, `Element '${event.local}': No matching global declaration available for the validation root.`);
            }
        } else if (!parent.skip) {
            declaration = this.#child(parent, event);
        }

        const frame = declaration === null
            ? { skip: true, depth: event.depth, scopes: NONE, notified: NONE, active: NONE }
            : this.#open(declaration, event);
        // Only constraints that can still select or capture something below the parent see this element.
        if (parent !== undefined && parent.active.length > 0) {
            frame.notified = parent.active;
            frame.active = parent.active.filter((scope) => scope.start(event));
        }

        if (declaration !== null && declaration.constraints.length > 0 && this.#identityConstraints) {
            frame.scopes = declaration.constraints.map((constraint) => new IdentityScope(constraint, event.depth));
            for (const scope of frame.scopes) {
                if (scope.constraint.kind === 'keyref') {
                    scope.lookup = () => this.#findTable(scope.constraint.refer, frame);
                }
            }

            frame.active = [...frame.active, ...frame.scopes];
        }

        this.#stack.push(frame);
    }

    /** @param {{ text: string, line: number, column: number }} event */
    text(event) {
        const frame = this.#stack.at(-1);
        if (frame === undefined || frame.skip) {
            return;
        }

        if (frame.type.kind === 'simple') {
            if (frame.text !== null && frame.text.length + event.text.length <= this.#maxValueLength) {
                frame.text += event.text;
            } else {
                frame.text = null;
            }
        } else if (frame.type.kind === 'complex' && !frame.textReported && /[^ \t\r\n]/.test(event.text)) {
            frame.textReported = true;
            this.#error(event, `Element '${frame.local}': Character content other than whitespace is not allowed because the content type is 'element-only'.`);
        }
    }

    /** @param {{ ns: string, local: string, line: number, column: number, depth: number }} event */
    end(event) {
        const frame = this.#stack.pop();
        if (frame === undefined) {
            return;
        }

        let value = null;
        if (!frame.skip) {
            if (frame.type.kind === 'simple') {
                const result = frame.text === null ? { value: null } : validateSimple(frame.type, frame.text);
                if ('error' in result) {
                    this.#error(event, `Element '${frame.local}': ${result.error}`);
                } else if (result.value !== null) {
                    value = keyValue(frame.type, result.value);
                    if (frame.type.builtin.id) {
                        this.#id(event, result.value);
                    }
                }
            } else if (frame.type.kind === 'complex' && !frame.broken) {
                const missing = frame.type.particles.slice(frame.index).find((p, i) => (i === 0 ? frame.count : 0) < p.min);
                if (missing !== undefined) {
                    this.#error(event, `Element '${frame.local}': Missing child element(s). Expected is ( ${missing.local} ).`);
                }
            }
        }

        for (const scope of frame.notified) {
            scope.end(event, value, this);
        }

        if (frame.scopes.length > 0) {
            for (const scope of frame.scopes) {
                if (scope.constraint.kind === 'keyref') {
                    scope.checkReferences(this.#findTable(scope.constraint.refer, frame), this);
                }
            }
        }
    }

    /** @internal Reports an identity-constraint violation. */
    error(line, column, message) {
        this.#report(message, line, column);
    }

    #error(event, message) {
        this.#report(message, event.line ?? null, event.column ?? null);
    }

    #open(declaration, event) {
        const type = declaration.type;
        const frame = {
            skip: type.kind === 'any', local: event.local, type, index: 0, count: 0, broken: false, text: '', textReported: false,
            scopes: NONE, notified: NONE, active: NONE, depth: event.depth,
        };
        if (type.kind !== 'any') {
            this.#attributes(type, event);
        }

        return frame;
    }

    #child(parent, event) {
        if (parent.type.kind === 'simple') {
            if (!parent.broken) {
                parent.broken = true;
                this.#error(event, `Element '${parent.local}': Element content is not allowed, because the type definition is simple.`);
            }

            return null;
        }

        const particles = parent.type.particles;
        if (parent.broken) {
            return null;
        }

        while (parent.index < particles.length) {
            const particle = particles[parent.index];
            if (particle.ns === event.ns && particle.local === event.local) {
                if (parent.count < particle.max) {
                    parent.count++;
                    return particle;
                }
            } else if (parent.count < particle.min) {
                break;
            }

            parent.index++;
            parent.count = 0;
        }

        parent.broken = true;
        const expected = particles.slice(parent.index).filter((p, i) => i === 0 || p.min > 0).slice(0, 1).map((p) => p.local);
        this.#error(event, expected.length > 0
            ? `Element '${event.local}': This element is not expected. Expected is ( ${expected[0]} ).`
            : `Element '${event.local}': This element is not expected.`);
        return null;
    }

    #attributes(type, event) {
        const seen = new Set();
        for (const attribute of event.attributes) {
            if (attribute.ns === XMLNS || attribute.ns === XSI || (attribute.ns === '' && attribute.local === 'xmlns')) {
                continue;
            }

            const key = qualified(attribute.ns, attribute.local);
            const declared = type.kind === 'complex' ? type.attributes.get(key) : undefined;
            if (declared === undefined) {
                this.#error(event, `Element '${event.local}', attribute '${attribute.local}': The attribute '${attribute.local}' is not allowed.`);
                continue;
            }

            seen.add(key);
            const result = validateSimple(declared.type, attribute.value);
            if ('error' in result) {
                this.#error(event, `Element '${event.local}', attribute '${attribute.local}': ${result.error}`);
            } else if (declared.type.builtin.id) {
                this.#id(event, result.value);
            }
        }

        if (type.kind === 'complex') {
            for (const [key, declared] of type.attributes) {
                if (declared.required && !seen.has(key)) {
                    this.#error(event, `Element '${event.local}': The attribute '${declared.local}' is required but missing.`);
                }
            }
        }
    }

    #id(event, value) {
        if (this.#ids.has(value)) {
            this.#error(event, `ID '${shown(value)}' is already defined.`);
        } else {
            this.#ids.add(value);
        }
    }

    /** The key table a keyref refers to: declared on the same element or on an ancestor. */
    #findTable(refer, frame) {
        for (const candidate of [frame, ...this.#stack.toReversed()]) {
            const scope = candidate.scopes?.find((s) => s.constraint.name === refer && s.constraint.kind !== 'keyref');
            if (scope !== undefined) {
                return scope.table;
            }
        }

        return null;
    }
}

/** Tracks one key, unique or keyref below the element that declares it. */
class IdentityScope {
    /** @type {Set<string>} Key values (key, unique). */
    table = new Set();
    /** @type {{ value: string, line: number | null, column: number | null }[]} Unresolved references (keyref). */
    pending = [];
    /** @type {(() => Set<string> | null) | null} The referenced key table (keyref). */
    lookup = null;
    /** Whether the element at each relative depth matches the selector so far, per alternative. */
    #matches = [];
    /** @type {{ depth: number, values: (string | undefined)[], fieldMatches: boolean[][], line: number, column: number }[]} */
    #selected = [];

    #maxSteps;

    constructor(constraint, depth) {
        this.constraint = constraint;
        this.depth = depth;
        this.#maxSteps = Math.max(...constraint.selector.map((path) => path.steps.length));
    }

    /** Sees the start of an element below the declaring element. Returns whether its descendants matter. */
    start(event) {
        const relative = event.depth - this.depth;
        if (relative > this.#maxSteps && this.#selected.length === 0) {
            return false;
        }

        const name = qualified(event.ns, event.local);
        const matches = this.constraint.selector.map((path, i) => {
            const step = path.steps[relative - 1];
            return relative <= path.steps.length && (relative === 1 || this.#matches[relative - 1]?.[i] === true)
                && (step === null || step === name);
        });
        this.#matches[relative] = matches;
        if (matches.some((match, i) => match && relative === this.constraint.selector[i].steps.length)) {
            this.#selected.push({ depth: event.depth, values: this.constraint.fields.map(() => undefined), fieldMatches: [], line: event.line, column: event.column });
        }

        for (const node of this.#selected) {
            const below = event.depth - node.depth;
            node.fieldMatches[below] = this.constraint.fields.map((field, i) => {
                if (below === 0) {
                    return true;
                }

                const step = field.steps[below - 1];
                return below <= field.steps.length && node.fieldMatches[below - 1]?.[i] === true && (step === null || step === name);
            });

            this.constraint.fields.forEach((field, i) => {
                if (field.attribute !== null && below === field.steps.length && node.fieldMatches[below][i]) {
                    const attribute = event.attributes.find((a) => qualified(a.ns, a.local) === field.attribute);
                    if (attribute !== undefined) {
                        node.values[i] = attribute.value;
                    }
                }
            });
        }

        return this.#selected.length > 0
            || matches.some((match, i) => match && relative < this.constraint.selector[i].steps.length);
    }

    end(event, value, validator) {
        for (const node of this.#selected) {
            const below = event.depth - node.depth;
            this.constraint.fields.forEach((field, i) => {
                if (field.attribute === null && below === field.steps.length && node.fieldMatches[below]?.[i] && value !== null) {
                    node.values[i] = value;
                }
            });
        }

        const node = this.#selected.at(-1);
        if (node !== undefined && node.depth === event.depth) {
            this.#selected.pop();
            this.#complete(node, validator);
        }
    }

    #complete(node, validator) {
        const { kind, displayName } = this.constraint;
        if (node.values.some((v) => v === undefined)) {
            if (kind === 'key') {
                validator.error(node.line, node.column, `Element: Not all fields of key identity-constraint '${displayName}' evaluate to a node.`);
            }

            return;
        }

        const value = node.values.join(SEPARATOR);
        if (kind === 'keyref') {
            // Key tables only grow, so a value found now is found at the end too; only the rest waits.
            if (this.lookup?.()?.has(value)) {
                return;
            }

            if (this.pending.length < MAX_PENDING_REFERENCES) {
                this.pending.push({ value, line: node.line, column: node.column });
            }

            return;
        }

        if (this.table.has(value)) {
            validator.error(node.line, node.column, `Duplicate key-sequence ['${shown(node.values.join("', '"))}'] in ${kind} identity-constraint '${displayName}'.`);
        } else {
            this.table.add(value);
        }
    }

    checkReferences(table, validator) {
        if (table === null) {
            validator.error(null, null, `The keyref '${this.constraint.displayName}' refers to a key that is not in scope.`);
            return;
        }

        for (const reference of this.pending) {
            if (!table.has(reference.value)) {
                validator.error(reference.line, reference.column,
                    `No match found for key-sequence ['${shown(reference.value.split(SEPARATOR).join("', '"))}'] of keyref '${this.constraint.displayName}'.`);
            }
        }
    }
}
