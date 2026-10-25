// Reads an audit file into memory and prints what was found.
// Usage: node samples/read-to-memory.js <file.xaf> [continuation files...]

import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
import { Auditfile, AuditfileSource, Decimal, MemorySink, TextLanguage } from '../src/index.js';

const files = process.argv.slice(2);
if (files.length === 0) {
    console.log('Usage: node samples/read-to-memory.js <file.xaf> [continuation files...]');
    process.exit(2);
}

const sink = new MemorySink();
// The reader never opens files itself: hand it a stream factory per part.
const source = AuditfileSource.fromFactories(...files.map((path) => [basename(path), () => createReadStream(path)]));
const report = await Auditfile.read(source, sink);

console.log(`Version  : ${report.schema?.versionKey ?? '-'} (${report.schema?.source ?? '-'})`);
for (const part of report.parts) {
    console.log(`Part ${part.number}   : ${part.name}, ${part.size} bytes, sha256 ${part.sha256.slice(0, 12)}…`);
}

console.log(`Loaded   : ${report.loaded} in ${report.duration.toFixed(0)} ms`);
console.log();
for (const table of report.schema?.tables ?? []) {
    const count = report.rowCounts.get(table.name);
    if (count !== undefined) {
        console.log(`  ${table.name.padEnd(40)} ${String(count).padStart(8)}`);
    }
}

const line = sink.rows('tr_line')[0];
if (line !== undefined) {
    console.log();
    console.log('First transaction line:');
    for (const column of line.table.columns.filter((c) => line.values[c.index] !== null)) {
        const label = column.definition?.label?.get(TextLanguage.English) ?? column.name;
        console.log(`  ${column.name.padEnd(20)} ${format(line.values[column.index]).padEnd(14)} ${label}`);
    }
}

// Views are reports defined by auditfile-spec, e.g. the trial balance; they run over the rows in memory.
for (const view of report.loaded ? report.schema?.version?.views ?? [] : []) {
    const result = sink.run(view, null, TextLanguage.English);
    console.log();
    console.log(`${view.label?.get(TextLanguage.English) ?? view.name} (${result.rows.length} rows)`);
    for (const diagnostic of result.diagnostics) {
        console.log(`  ${diagnostic}`);
    }

    printTable(result, 10);
}

console.log();
for (const diagnostic of report.diagnostics) {
    console.log(String(diagnostic));
}

console.log(report.isValid ? 'Valid.' : 'Not valid.');
process.exitCode = report.isValid ? 0 : 1;

function format(value) {
    if (value === null) {
        return '';
    }

    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
}

function printTable(result, maxRows) {
    const maxWidth = 30;
    const header = result.columns.map((c) => c.label?.get(TextLanguage.English) ?? c.name);
    const cells = result.rows.slice(0, maxRows).map((row) => row.map(format));
    const widths = header.map((h, i) => Math.min(maxWidth, Math.max(h.length, ...cells.map((r) => r[i].length))));
    const numeric = result.columns.map((_, i) => result.rows.some((r) => r[i] instanceof Decimal || typeof r[i] === 'number'));
    const line = (values) => `  ${values.map((v, i) => {
        const cut = v.length > widths[i] ? `${v.slice(0, widths[i] - 1)}…` : v;
        return numeric[i] ? cut.padStart(widths[i]) : cut.padEnd(widths[i]);
    }).join('  ')}`;

    console.log(line(header));
    for (const row of cells) {
        console.log(line(row));
    }

    if (result.rows.length > maxRows) {
        console.log(`  … ${result.rows.length - maxRows} more`);
    }
}
