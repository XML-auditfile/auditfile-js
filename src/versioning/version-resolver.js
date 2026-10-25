import { Location } from '../diagnostics/collector.js';
import { VersionSource } from '../schema/schema.js';
import { AuditfileVersion } from './version.js';

/** The outcome of version resolution. */
export class Resolution {
    constructor(version, source, fileNamespace, dialect) {
        /** @type {AuditfileVersion} */
        this.version = version;
        this.source = source;
        this.fileNamespace = fileNamespace;
        /** @type {import('../definitions/dialect.js').Dialect | null} Set later when header/softwareDesc selects a dialect. */
        this.dialect = dialect;
    }

    get needsMapping() {
        return this.fileNamespace !== this.version.namespace;
    }
}

/**
 * Determines the version: forced by the caller, then the registry (official namespace, alias or dialect),
 * then optionally the resolver. Anything else is fatal.
 * @returns {Resolution | null}
 */
export function resolveVersion(rootName, fileNamespace, options, diagnostics) {
    const resolution = find(fileNamespace, options, diagnostics);
    if (resolution === null) {
        diagnostics.add('XAF-V001', Location.NONE, { namespace: fileNamespace });
        return null;
    }

    const version = resolution.version;
    if (rootName !== version.rootElement) {
        diagnostics.add('XAF-V005', Location.NONE, { element: rootName, expected: version.rootElement });
        return null;
    }

    if (!version.hasOfficialXsd) {
        diagnostics.add('XAF-V006', Location.NONE, { version: version.key });
    }

    const replace = resolution.dialect?.corrections.find((c) => c.action === 'replaceNamespace' && c.from === fileNamespace);
    if (replace !== undefined) {
        diagnostics.add(replace.code, Location.NONE, { from: fileNamespace, to: version.namespace });
    }

    return resolution;
}

function find(fileNamespace, options, diagnostics) {
    const forced = options.version;
    if (forced !== null) {
        if (fileNamespace !== forced.namespace) {
            diagnostics.add('XAF-V003', Location.NONE, { version: forced.key, namespace: fileNamespace });
        }

        return new Resolution(forced, VersionSource.Forced, fileNamespace, findDialect(forced, fileNamespace, options));
    }

    for (const version of AuditfileVersion.all) {
        if (version.namespace === fileNamespace) {
            return new Resolution(version, VersionSource.Official, fileNamespace, null);
        }
    }

    for (const version of AuditfileVersion.all) {
        const dialect = findDialect(version, fileNamespace, options);
        if (version.aliases.includes(fileNamespace) || dialect !== null) {
            diagnostics.add('XAF-V002', Location.NONE, { namespace: fileNamespace, version: version.key });
            return new Resolution(version, VersionSource.Alias, fileNamespace, dialect);
        }
    }

    if (options.useResolver) {
        const derived = derive(fileNamespace);
        if (derived !== null) {
            diagnostics.add('XAF-V004', Location.NONE, { version: derived.key, namespace: fileNamespace });
            return new Resolution(derived, VersionSource.Resolved, fileNamespace, null);
        }
    }

    return null;
}

function findDialect(version, fileNamespace, options) {
    return options.applyDialects ? version.dialects.find((d) => d.namespaces.includes(fileNamespace)) ?? null : null;
}

const digits = (value) => value.replace(/\D/g, '');

/**
 * Derives type and version from the namespace segments, e.g. ".../XAF/3.2/" or ".../xaf/3_2".
 * Returns a version only when exactly one matches.
 */
function derive(fileNamespace) {
    const segments = fileNamespace.toLowerCase().split(/[/:#]/).filter((s) => s.length > 0);
    const candidates = AuditfileVersion.all.filter((v) =>
        segments.includes(v.type)
        && segments.some((s) => digits(s).length > 0 && digits(s) === digits(v.version) && /^[\d._]+$/.test(s)));

    return candidates.length === 1 ? candidates[0] : null;
}
