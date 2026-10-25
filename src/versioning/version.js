import { Dialect } from '../definitions/dialect.js';
import { ElementDefinition } from '../definitions/element-definition.js';
import { AuditfileManifest } from '../definitions/manifest.js';
import { exists, readBytes, readJson, readText } from '../definitions/resources.js';
import { ViewDefinition } from '../definitions/view-definition.js';
import { objects, string } from '../internal/json.js';
import { Sha256 } from '../internal/sha256.js';
import { SchemaSet } from '../xsd/schema-set.js';

/** @type {AuditfileVersion[] | null} */
let registry = null;

function lazy(factory) {
    let value;
    let created = false;
    return () => {
        if (!created) {
            value = factory();
            created = true;
        }

        return value;
    };
}

/**
 * One audit file type and version, with its manifest, XSD, definitions and dialects.
 * Use the constants, e.g. `AuditfileVersion.Financial.V3_2`, or {@link AuditfileVersion.parse} with "xaf/3.2".
 */
export class AuditfileVersion {
    #manifest;
    #definitions;
    #dialects;
    #views;
    #schemaSet;

    /** @internal */
    constructor(json) {
        /** Registry key, e.g. "xaf/3.2". */
        this.key = string(json, 'key');
        /** Audit file type, e.g. "xaf". */
        this.type = string(json, 'type');
        /** Type name used for version objects, e.g. "financial". */
        this.typeName = string(json, 'typeName');
        /** Version, e.g. "3.2". */
        this.version = string(json, 'version');
        /** Folder of the definitions, e.g. "standards/xaf/3_2". */
        this.folder = string(json, 'folder');
        /** Name of the root element. */
        this.rootElement = string(json, 'rootElement');
        /** "official" or "reconstructed". */
        this.provenance = string(json, 'provenance');

        const namespaces = objects(json, 'namespaces');
        const official = namespaces.find((n) => string(n, 'kind') === 'official');
        if (official === undefined) {
            throw new SyntaxError(`registry.json: ${this.key} has no official namespace.`);
        }

        /** The official namespace. */
        this.namespace = string(official, 'uri');
        /** @type {readonly string[]} Other namespaces known to be used for this version. */
        this.aliases = Object.freeze(namespaces.filter((n) => string(n, 'kind') === 'alias').map((n) => string(n, 'uri')));

        const folder = this.folder;
        this.#manifest = lazy(() => new AuditfileManifest(readJson(`${folder}/manifest.json`)));
        this.#definitions = lazy(() => new Map(objects(readJson(`${folder}/definition.json`), 'entries')
            .map((e) => new ElementDefinition(e)).map((d) => [d.key, d])));
        this.#dialects = lazy(() => Object.freeze(objects(readJson(`${folder}/dialects.json`), 'dialects').map((d) => new Dialect(d))));
        this.#views = lazy(() => ViewDefinition.load(this.type));
        this.#schemaSet = lazy(() => AuditfileVersion.compileSchemaSet(`${folder}/auditfile.xsd`, (name) => (exists(name) ? readText(name) : undefined)));
        Object.freeze(this);
    }

    /** @type {readonly AuditfileVersion[]} All versions this reader knows, in registry order. */
    static get all() {
        registry ??= Object.freeze(objects(readJson('registry.json'), 'standards').map((s) => new AuditfileVersion(s)));
        return registry;
    }

    /** True when the XSD is the official one published by the Belastingdienst. */
    get hasOfficialXsd() {
        return this.provenance === 'official';
    }

    /** @type {AuditfileManifest} Structure: tables and columns. */
    get manifest() {
        return this.#manifest();
    }

    /** @type {ReadonlyMap<string, ElementDefinition>} Definitions by key ("tr_line", "tr_line.amnt"). */
    get definitions() {
        return this.#definitions();
    }

    /** @type {readonly Dialect[]} Known dialects of this version. */
    get dialects() {
        return this.#dialects();
    }

    /** @type {readonly ViewDefinition[]} Views of this audit file type, e.g. the trial balance. Shared by all versions of the type. */
    get views() {
        return this.#views();
    }

    /**
     * Finds a view by name, or returns null.
     * @param {string} name
     */
    findView(name) {
        return this.views.find((v) => v.name === name) ?? null;
    }

    /**
     * Finds a version by key, e.g. "xaf/3.2" (case-insensitive). Returns null when unknown.
     * @param {string} key
     */
    static find(key) {
        const lower = String(key).toLowerCase();
        return AuditfileVersion.all.find((v) => v.key.toLowerCase() === lower) ?? null;
    }

    /**
     * Returns the version for a key such as "xaf/3.2".
     * @param {string} key
     * @throws {RangeError} The key is unknown.
     */
    static parse(key) {
        if (typeof key !== 'string') {
            throw new TypeError('key must be a string.');
        }

        const version = AuditfileVersion.find(key);
        if (version === null) {
            throw new RangeError(`Unknown audit file version '${key}'.`);
        }

        return version;
    }

    /** The bytes of the XSD of this version. */
    openXsd() {
        return readBytes(`${this.folder}/auditfile.xsd`);
    }

    /** The compiled XSD of this version, ready for validation. Compiled once and shared; it is immutable. */
    createSchemaSet() {
        return this.#schemaSet();
    }

    toString() {
        return this.key;
    }

    /**
     * @internal
     * Compiles an XSD. Includes and imports are resolved only through `load`, never from disk or network.
     * @param {string} name
     * @param {(name: string) => string | undefined} load
     */
    static compileSchemaSet(name, load) {
        return SchemaSet.compile(name, load);
    }

    /** @internal */
    static sha256(bytes) {
        return Sha256.hex(bytes);
    }
}

function constant(key) {
    return { enumerable: true, get: () => AuditfileVersion.parse(key) };
}

// The version constants. A test checks that every registry entry has a constant here and vice versa.
// Names follow the registry: version with underscores, e.g. V3_2 for 3.2.

/** Auditfile Financieel (XAF). */
AuditfileVersion.Financial = Object.freeze(Object.defineProperties({}, {
    /** XAF 3.2 (2014, supplemented in 2017). */
    V3_2: constant('xaf/3.2'),
    /** XAF 4.0.3. */
    V4_0_3: constant('xaf/4.0.3'),
}));

/** Auditfile Afrekensystemen (XAA). */
AuditfileVersion.CashRegister = Object.freeze(Object.defineProperties({}, {
    V3_2: constant('xaa/3.2'),
}));

/** Auditfile Boordcomputer Taxi (XAB). */
AuditfileVersion.TaxiOnboardComputer = Object.freeze(Object.defineProperties({}, {
    V1_0: constant('xab/1.0'),
}));

/** Auditfile Ritregistratie (XAR). */
AuditfileVersion.TripRegistration = Object.freeze(Object.defineProperties({}, {
    V1_2: constant('xar/1.2'),
    V2_3_6_1: constant('xar/2.3.6.1'),
}));

/** Auditfile Salaris (XAS). */
AuditfileVersion.Payroll = Object.freeze(Object.defineProperties({}, {
    V2018_1_0: constant('xas/2018.1.0'),
    V2019_1_0: constant('xas/2019.1.0'),
    V2020_1_0: constant('xas/2020.1.0'),
    V2021_1_1: constant('xas/2021.1.1'),
    V2022_1_1: constant('xas/2022.1.1'),
    V2023_1_0: constant('xas/2023.1.0'),
    V2024_1_0: constant('xas/2024.1.0'),
    V2025_1_0: constant('xas/2025.1.0'),
    V2026_1_0: constant('xas/2026.1.0'),
    V2027_1_0: constant('xas/2027.1.0'),
}));

/** The groups of version constants, for the test that compares them with the registry. */
export const VERSION_GROUPS = Object.freeze(['Financial', 'CashRegister', 'TaxiOnboardComputer', 'TripRegistration', 'Payroll']);
