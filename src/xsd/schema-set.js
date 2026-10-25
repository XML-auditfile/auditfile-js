import { SaxesParser } from 'saxes';
import { Decimal } from '../internal/decimal.js';
import { BUILTINS } from './datatypes.js';
import { translatePattern } from './regex.js';

// Compiles the XSD subset used by auditfile-spec: global and local elements, sequences, attributes,
// simple types restricted by facets, and key/keyref/unique. Anything else is refused with a clear error,
// so a custom XSD is never validated half.

export const XS = 'http://www.w3.org/2001/XMLSchema';

/** @param {string} ns @param {string} local */
export const qualified = (ns, local) => `{${ns}}${local}`;

/** Accepts any content; used for elements without a type. */
export const ANY_TYPE = Object.freeze({ kind: 'any' });

/** A light element tree of an XSD document. */
function parseTree(text, name) {
    const parser = new SaxesParser({ xmlns: true, position: true, forceXMLVersion: true, defaultXMLVersion: '1.0' });
    const stack = [];
    let root = null;
    parser.on('doctype', () => {
        throw new Error(`${name}: a DTD is not allowed.`);
    });
    parser.on('error', (error) => {
        throw new Error(`${name}: ${error.message}`);
    });
    parser.on('opentag', (tag) => {
        const parent = stack.at(-1);
        const bindings = new Map(parent?.bindings ?? [['xml', 'http://www.w3.org/XML/1998/namespace']]);
        for (const [prefix, uri] of Object.entries(tag.ns ?? {})) {
            bindings.set(prefix, uri);
        }

        const attributes = new Map();
        for (const attribute of Object.values(tag.attributes)) {
            if (attribute.uri === '') {
                attributes.set(attribute.local, attribute.value);
            }
        }

        const node = { ns: tag.uri, local: tag.local, attributes, bindings, children: [], line: parser.line };
        if (parent === undefined) {
            root = node;
        } else {
            parent.children.push(node);
        }

        stack.push(node);
    });
    parser.on('closetag', () => {
        stack.pop();
    });
    parser.write(text).close();
    return root;
}

/** One XSD document: its tree, target namespace and form defaults. */
class SchemaDocument {
    constructor(name, root) {
        if (root === null || root.ns !== XS || root.local !== 'schema') {
            throw new Error(`${name} is not an XSD schema.`);
        }

        this.name = name;
        this.root = root;
        this.targetNamespace = root.attributes.get('targetNamespace') ?? '';
        this.elementQualified = root.attributes.get('elementFormDefault') === 'qualified';
        this.attributeQualified = root.attributes.get('attributeFormDefault') === 'qualified';
    }
}

function fail(document, node, message) {
    return new Error(`${document.name} (line ${node.line}): ${message}`);
}

/** XS children of a node, without annotations. */
function children(document, node) {
    return node.children.filter((child) => {
        if (child.ns !== XS) {
            throw fail(document, child, `unexpected element {${child.ns}}${child.local}.`);
        }

        return child.local !== 'annotation';
    });
}

function allow(document, node, names) {
    for (const name of node.attributes.keys()) {
        if (!names.includes(name)) {
            throw fail(document, node, `attribute '${name}' on xs:${node.local} is not supported by this validator.`);
        }
    }
}

function resolveQName(document, node, value) {
    const colon = value.indexOf(':');
    const prefix = colon < 0 ? '' : value.slice(0, colon);
    const local = colon < 0 ? value : value.slice(colon + 1);
    const ns = node.bindings.get(prefix);
    if (ns === undefined) {
        if (prefix === '') {
            return { ns: '', local };
        }

        throw fail(document, node, `prefix '${prefix}' is not declared.`);
    }

    return { ns, local };
}

function occurs(document, node, name, fallback) {
    const value = node.attributes.get(name);
    if (value === undefined) {
        return fallback;
    }

    if (value === 'unbounded' && name === 'maxOccurs') {
        return Infinity;
    }

    if (!/^\d+$/.test(value)) {
        throw fail(document, node, `${name}="${value}" is not valid.`);
    }

    return Number(value);
}

/** Normalizes "a/./b/../c" style names relative to the including document. */
function resolveLocation(base, location) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(location) || location.startsWith('/')) {
        throw new Error(`${base}: schemaLocation '${location}' must be relative; only embedded definitions are allowed.`);
    }

    const segments = base.split('/').slice(0, -1);
    for (const segment of location.split('/')) {
        if (segment === '..') {
            if (segments.length === 0) {
                throw new Error(`${base}: schemaLocation '${location}' points outside the definitions.`);
            }

            segments.pop();
        } else if (segment !== '.' && segment !== '') {
            segments.push(segment);
        }
    }

    return segments.join('/');
}

/** A compiled XSD: the global element declarations of all its documents. */
export class SchemaSet {
    /** @type {Map<string, object>} Global element declarations by "{ns}local". */
    elements = new Map();
    /** @type {Map<string, { document: SchemaDocument, node: object }>} */
    #simpleTypes = new Map();
    /** @type {Map<string, { document: SchemaDocument, node: object }>} */
    #complexTypes = new Map();
    /** @type {Map<string, object>} */
    #compiled = new Map();
    /** Number of schema documents. */
    count = 0;

    /**
     * @param {string} mainName
     * @param {(name: string) => string | undefined} load Returns the text of a schema document, or undefined.
     */
    static compile(mainName, load) {
        const set = new SchemaSet();
        const documents = [];
        const loaded = new Set();
        const queue = [mainName];
        while (queue.length > 0) {
            const name = queue.shift();
            if (loaded.has(name)) {
                continue;
            }

            loaded.add(name);
            const text = load(name);
            if (text === undefined) {
                throw new Error(`Refused to resolve '${name}': only embedded definitions are allowed.`);
            }

            const document = new SchemaDocument(name, parseTree(text, name));
            documents.push(document);
            for (const node of children(document, document.root)) {
                if (node.local === 'import' || node.local === 'include') {
                    const location = node.attributes.get('schemaLocation');
                    if (location === undefined) {
                        throw fail(document, node, `xs:${node.local} without schemaLocation is not supported.`);
                    }

                    queue.push(resolveLocation(name, location));
                }
            }
        }

        for (const document of documents) {
            for (const node of children(document, document.root)) {
                const key = qualified(document.targetNamespace, node.attributes.get('name') ?? '');
                switch (node.local) {
                    case 'simpleType':
                        set.#simpleTypes.set(key, { document, node });
                        break;
                    case 'complexType':
                        set.#complexTypes.set(key, { document, node });
                        break;
                    case 'element':
                    case 'import':
                    case 'include':
                        break;
                    default:
                        throw fail(document, node, `xs:${node.local} is not supported by this validator.`);
                }
            }
        }

        for (const document of documents) {
            for (const node of children(document, document.root)) {
                if (node.local === 'element') {
                    const element = set.#element(document, node, true);
                    set.elements.set(qualified(element.ns, element.local), element);
                }
            }
        }

        set.count = documents.length;
        return Object.freeze(set);
    }

    #element(document, node, global) {
        allow(document, node, global ? ['name', 'type', 'id'] : ['name', 'type', 'minOccurs', 'maxOccurs', 'form', 'id']);
        const local = node.attributes.get('name');
        if (local === undefined) {
            throw fail(document, node, 'xs:element without a name (ref) is not supported by this validator.');
        }

        const form = node.attributes.get('form');
        const ns = global || (form === undefined ? document.elementQualified : form === 'qualified') ? document.targetNamespace : '';
        const element = {
            ns,
            local,
            min: global ? 1 : occurs(document, node, 'minOccurs', 1),
            max: global ? 1 : occurs(document, node, 'maxOccurs', 1),
            type: ANY_TYPE,
            constraints: [],
        };

        const typeName = node.attributes.get('type');
        let anonymous = null;
        for (const child of children(document, node)) {
            switch (child.local) {
                case 'simpleType':
                case 'complexType':
                    anonymous = child;
                    break;
                case 'key':
                case 'keyref':
                case 'unique':
                    element.constraints.push(this.#constraint(document, child));
                    break;
                default:
                    throw fail(document, child, `xs:${child.local} in xs:element is not supported by this validator.`);
            }
        }

        if (typeName !== undefined) {
            element.type = this.#typeByName(document, node, typeName);
        } else if (anonymous !== null) {
            element.type = anonymous.local === 'simpleType'
                ? this.#simpleType(document, anonymous)
                : this.#complexType(document, anonymous);
        }

        return element;
    }

    #typeByName(document, node, value) {
        const { ns, local } = resolveQName(document, node, value);
        if (ns === XS) {
            if (local === 'anyType') {
                return ANY_TYPE;
            }

            return this.#builtin(document, node, local);
        }

        const key = qualified(ns, local);
        if (this.#compiled.has(key)) {
            const compiled = this.#compiled.get(key);
            if (compiled === null) {
                throw fail(document, node, `type '${value}' is defined in terms of itself.`);
            }

            return compiled;
        }

        const simple = this.#simpleTypes.get(key);
        const complex = this.#complexTypes.get(key);
        if (simple === undefined && complex === undefined) {
            throw fail(document, node, `type '${value}' is not defined.`);
        }

        this.#compiled.set(key, null);
        const type = simple !== undefined
            ? this.#simpleType(simple.document, simple.node, local)
            : this.#complexType(complex.document, complex.node);
        this.#compiled.set(key, type);
        return type;
    }

    #builtin(document, node, local) {
        const builtin = BUILTINS.get(local);
        if (builtin === undefined) {
            throw fail(document, node, `built-in type xs:${local} is not supported by this validator.`);
        }

        return { kind: 'simple', name: `xs:${local}`, builtin, base: null, whiteSpace: builtin.whiteSpace, facets: null };
    }

    #simpleType(document, node, name = null) {
        allow(document, node, ['name', 'id']);
        const parts = children(document, node);
        if (parts.length !== 1 || parts[0].local !== 'restriction') {
            throw fail(document, node, 'only xs:simpleType with xs:restriction is supported by this validator.');
        }

        const restriction = parts[0];
        allow(document, restriction, ['base', 'id']);
        let base;
        const facetNodes = [];
        for (const child of children(document, restriction)) {
            if (child.local === 'simpleType') {
                base = this.#simpleType(document, child);
            } else {
                facetNodes.push(child);
            }
        }

        const baseName = restriction.attributes.get('base');
        if (baseName !== undefined) {
            base = this.#typeByName(document, restriction, baseName);
        }

        if (base === undefined || base.kind !== 'simple') {
            throw fail(document, restriction, 'xs:restriction needs a simple base type.');
        }

        const facets = { enumeration: null, patterns: [], length: null, minLength: null, maxLength: null, totalDigits: null,
            fractionDigits: null, minInclusive: null, maxInclusive: null, minExclusive: null, maxExclusive: null };
        let whiteSpace = base.whiteSpace;
        for (const facet of facetNodes) {
            allow(document, facet, ['value', 'fixed', 'id']);
            const value = facet.attributes.get('value');
            if (value === undefined) {
                throw fail(document, facet, `xs:${facet.local} needs a value.`);
            }

            switch (facet.local) {
                case 'enumeration':
                    (facets.enumeration ??= []).push(value);
                    break;
                case 'pattern':
                    try {
                        facets.patterns.push({ source: value, regex: translatePattern(value) });
                    } catch (error) {
                        throw fail(document, facet, error.message);
                    }

                    break;
                case 'length':
                case 'minLength':
                case 'maxLength':
                case 'totalDigits':
                case 'fractionDigits':
                    if (!/^\d+$/.test(value)) {
                        throw fail(document, facet, `xs:${facet.local} value '${value}' is not a non-negative integer.`);
                    }

                    facets[facet.local] = Number(value);
                    break;
                case 'minInclusive':
                case 'maxInclusive':
                case 'minExclusive':
                case 'maxExclusive': {
                    const bound = base.builtin.numeric ? base.builtin.parse(value.trim()) : null;
                    if (!(bound instanceof Decimal)) {
                        throw fail(document, facet, `xs:${facet.local} is supported on numeric types only.`);
                    }

                    facets[facet.local] = bound;
                    break;
                }

                case 'whiteSpace':
                    if (!['preserve', 'replace', 'collapse'].includes(value)) {
                        throw fail(document, facet, `xs:whiteSpace value '${value}' is not valid.`);
                    }

                    whiteSpace = value;
                    break;
                default:
                    throw fail(document, facet, `facet xs:${facet.local} is not supported by this validator.`);
            }
        }

        if (facets.enumeration !== null && base.builtin.numeric) {
            facets.enumeration = facets.enumeration.map((value) => base.builtin.parse(value.trim()) ?? value);
        }

        return { kind: 'simple', name: name ?? base.name, builtin: base.builtin, base, whiteSpace, facets };
    }

    #complexType(document, node) {
        allow(document, node, ['name', 'mixed', 'id']);
        if (node.attributes.has('mixed') && node.attributes.get('mixed') !== 'false') {
            throw fail(document, node, 'mixed content is not supported by this validator.');
        }

        const type = { kind: 'complex', particles: [], attributes: new Map() };
        let sequences = 0;
        for (const child of children(document, node)) {
            switch (child.local) {
                case 'sequence':
                    if (++sequences > 1) {
                        throw fail(document, child, 'more than one xs:sequence.');
                    }

                    allow(document, child, ['id']);
                    for (const particle of children(document, child)) {
                        if (particle.local !== 'element') {
                            throw fail(document, particle, `xs:${particle.local} in xs:sequence is not supported by this validator.`);
                        }

                        type.particles.push(this.#element(document, particle, false));
                    }

                    break;
                case 'attribute': {
                    allow(document, child, ['name', 'type', 'use', 'form', 'id']);
                    const local = child.attributes.get('name');
                    if (local === undefined) {
                        throw fail(document, child, 'xs:attribute without a name (ref) is not supported by this validator.');
                    }

                    const form = child.attributes.get('form');
                    const ns = (form === undefined ? document.attributeQualified : form === 'qualified') ? document.targetNamespace : '';
                    const use = child.attributes.get('use') ?? 'optional';
                    const inner = children(document, child).find((c) => c.local === 'simpleType');
                    const typeName = child.attributes.get('type');
                    const attributeType = typeName !== undefined
                        ? this.#typeByName(document, child, typeName)
                        : inner !== undefined ? this.#simpleType(document, inner) : this.#builtin(document, child, 'anySimpleType');
                    if (attributeType.kind !== 'simple') {
                        throw fail(document, child, 'an attribute needs a simple type.');
                    }

                    if (use !== 'prohibited') {
                        type.attributes.set(qualified(ns, local), { local, type: attributeType, required: use === 'required' });
                    }

                    break;
                }

                default:
                    throw fail(document, child, `xs:${child.local} in xs:complexType is not supported by this validator.`);
            }
        }

        return type;
    }

    #constraint(document, node) {
        allow(document, node, ['name', 'refer', 'id']);
        const kind = node.local;
        const name = node.attributes.get('name');
        let selector = null;
        const fields = [];
        for (const child of children(document, node)) {
            allow(document, child, ['xpath', 'id']);
            const xpath = child.attributes.get('xpath');
            if (xpath === undefined || (child.local !== 'selector' && child.local !== 'field')) {
                throw fail(document, child, `xs:${child.local} in xs:${kind} is not supported by this validator.`);
            }

            if (child.local === 'selector') {
                selector = xpath.split('|').map((path) => this.#path(document, child, path, false));
            } else {
                fields.push(this.#path(document, child, xpath, true));
            }
        }

        if (name === undefined || selector === null || fields.length === 0) {
            throw fail(document, node, `xs:${kind} needs a name, a selector and at least one field.`);
        }

        let refer = null;
        if (kind === 'keyref') {
            const value = node.attributes.get('refer');
            if (value === undefined) {
                throw fail(document, node, 'xs:keyref needs refer.');
            }

            const { ns, local } = resolveQName(document, node, value);
            refer = qualified(ns, local);
        }

        return { kind, name: qualified(document.targetNamespace, name), displayName: name, selector, fields, refer };
    }

    /** Parses a restricted XPath: "./a/b", "a/b", "@x", "a/@x" or ".". Steps match {ns}local or *. */
    #path(document, node, xpath, field) {
        const steps = [];
        let attribute = null;
        const parts = xpath.trim().split('/').map((p) => p.trim());
        parts.forEach((part, i) => {
            if (part === '.' && i === 0) {
                return;
            }

            if (part === '' || part.includes('::') || part.includes('[') || part === '..' || part === '.') {
                throw fail(document, node, `XPath '${xpath}' is not supported by this validator.`);
            }

            if (part.startsWith('@')) {
                if (!field || i !== parts.length - 1) {
                    throw fail(document, node, `XPath '${xpath}' is not supported by this validator.`);
                }

                attribute = this.#nameTest(document, node, part.slice(1));
                return;
            }

            steps.push(this.#nameTest(document, node, part));
        });

        return { steps, attribute };
    }

    #nameTest(document, node, test) {
        if (test === '*') {
            return null;
        }

        // XPath 1.0: an unprefixed name has no namespace; the default namespace does not apply.
        if (!test.includes(':')) {
            return qualified('', test);
        }

        const { ns, local } = resolveQName(document, node, test);
        return qualified(ns, local);
    }
}
