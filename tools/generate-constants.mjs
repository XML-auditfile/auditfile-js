// Writes the version constants in src/versioning/version.js from the registry of auditfile-spec.
// Run after tools/fetch-spec.ps1, whenever spec.lock.json changes; the auditfile-spec update workflow does this too.
// Only the part between the "<generated>" markers is replaced. With --check nothing is written: the exit code is 1
// when the constants differ from the registry. Override the location of the spec with SPEC_ROOT=<path>.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specRoot = resolve(root, process.env.SPEC_ROOT ?? 'spec');
const registryPath = join(specRoot, 'generated', 'registry.json');
const target = join(root, 'src', 'versioning', 'version.js');
const targetName = relative(root, target).split('\\').join('/');

try {
    statSync(registryPath);
} catch {
    console.error(`auditfile-spec not found in '${specRoot}'. Run: pwsh tools/fetch-spec.ps1`);
    process.exit(1);
}

// The registry has no display names; a type that is not here gets its code.
const typeNames = {
    xaf: 'Auditfile Financieel',
    xaa: 'Auditfile Afrekensystemen',
    xab: 'Auditfile Boordcomputer Taxi',
    xar: 'Auditfile Ritregistratie',
    xas: 'Auditfile Salaris',
};

function compareVersions(a, b) {
    const pa = a.split(/[._-]/);
    const pb = b.split(/[._-]/);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const x = pa[i] ?? '0';
        const y = pb[i] ?? '0';
        const diff = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
        if (diff !== 0) {
            return diff;
        }
    }

    return 0;
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));

// Per type, in registry order, the versions in order.
const byType = new Map();
for (const standard of registry.standards) {
    if (!byType.has(standard.type)) {
        byType.set(standard.type, []);
    }

    byType.get(standard.type).push(standard);
}

const groups = [...byType].map(([code, standards]) => ({
    code,
    name: standards[0].typeName[0].toUpperCase() + standards[0].typeName.slice(1),
    standards: standards.sort((a, b) => compareVersions(a.version, b.version)),
}));

const lines = [];
for (const { code, name, standards } of groups) {
    lines.push(`/** ${typeNames[code] ?? 'Auditfile'} (${code.toUpperCase()}). */`);
    lines.push(`AuditfileVersion.${name} = Object.freeze(Object.defineProperties({}, {`);
    for (const standard of standards) {
        const published = standard.origin?.published ? ` (published ${standard.origin.published})` : '';
        lines.push(`    /** ${code.toUpperCase()} ${standard.version}${published}. */`);
        lines.push(`    V${standard.version.replace(/[^0-9A-Za-z]/g, '_')}: constant('${standard.key}'),`);
    }

    lines.push('}));', '');
}

lines.push('/** The groups of version constants, for the test that compares them with the registry. */');
lines.push(`export const VERSION_GROUPS = Object.freeze([${groups.map((g) => `'${g.name}'`).join(', ')}]);`);

const current = readFileSync(target, 'utf8');
const pattern = /(^\/\/ <generated: constants>\n)[\s\S]*?(^\/\/ <\/generated: constants>$)/m;
if (!pattern.test(current)) {
    console.error(`${targetName} has no '<generated: constants>' markers.`);
    process.exit(1);
}

const text = current.replace(pattern, (_, start, end) => start + lines.join('\n') + '\n' + end);

if (process.argv.includes('--check')) {
    if (text !== current) {
        console.error(`The version constants in ${targetName} differ from the registry. Run: node tools/generate-constants.mjs`);
        process.exit(1);
    }

    console.log('The version constants match the registry.');
} else if (text !== current) {
    writeFileSync(target, text);
    console.log(`Updated the version constants in ${targetName}.`);
} else {
    console.log('The version constants are up to date.');
}
