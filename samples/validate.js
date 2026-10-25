// Validates an audit file: XSD, structure, keys and business rules.
// Usage: node samples/validate.js <file.xaf> [--en] [--unverified] [--force xaf/3.2]
// Exit code: 0 valid, 1 not valid, 2 usage error.

import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Auditfile, AuditfileSource, DiagnosticSeverity, ReadMode, TextLanguage } from '../src/index.js';

const args = process.argv.slice(2);
const forceIndex = args.indexOf('--force');
const files = args.filter((a, i) => !a.startsWith('--') && (forceIndex < 0 || i !== forceIndex + 1));
if (files.length === 0) {
    console.error('Usage: node samples/validate.js <file.xaf> [--en] [--unverified] [--force xaf/3.2]');
    process.exit(2);
}

const options = {
    language: args.includes('--en') ? TextLanguage.English : TextLanguage.Dutch,
    mode: args.includes('--unverified') ? ReadMode.Unverified : ReadMode.Verified,
    version: forceIndex >= 0 && forceIndex + 1 < args.length ? args[forceIndex + 1] : null,
};

// The reader never opens files itself: hand it a stream factory per part.
const source = AuditfileSource.fromFactories(...files.map((path) => [basename(path), () => createReadStream(path)]));

let report;
if (options.mode === ReadMode.Verified) {
    report = await Auditfile.validate(source, options);
} else {
    // Unverified: stream through all rows so every check runs, without keeping anything.
    const reader = await Auditfile.open(source, options);
    for await (const _ of reader.readRows()) {
        // Nothing to keep.
    }

    report = reader.report;
}

for (const diagnostic of report.diagnostics) {
    console.log(String(diagnostic));
}

const errors = report.count(DiagnosticSeverity.Error) + report.count(DiagnosticSeverity.Fatal);
console.log(`${errors} errors, ${report.count(DiagnosticSeverity.Warning)} warnings`);
process.exitCode = report.isValid ? 0 : 1;
