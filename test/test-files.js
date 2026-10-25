import { createReadStream, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditfileSource } from '../src/index.js';

// The XAF 3.2 sample of this repository (test/data), with two intended findings (XAF-R001, XAF-R003),
// and variations of it written to a temporary folder.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const OFFICIAL_NAMESPACE = 'http://www.auditfiles.nl/XAF/3.2';
export const sample = join(root, 'test', 'data', 'xaf-3.2-sample.xaf');
export const sampleText = readFileSync(sample, 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n');

/** One folder per test file, removed when it ends. */
let runFolder = null;

export function write(name, content) {
    if (runFolder === null) {
        runFolder = mkdtempSync(join(tmpdir(), 'xmlauditfile-js-tests-'));
        process.on('exit', () => rmSync(runFolder, { recursive: true, force: true }));
    }

    const path = join(mkdtempSync(join(runFolder, 'f-')), name);
    writeFileSync(path, content);
    return path;
}

/** A file on disk as a source; the reader itself never opens files. */
export function source(path) {
    return AuditfileSource.fromFactory(() => createReadStream(path), basename(path));
}

export function withNamespace(ns) {
    return write('namespace.xaf', sampleText.replace(`xmlns="${OFFICIAL_NAMESPACE}"`, `xmlns="${ns}"`));
}

export function bytes(text) {
    return new TextEncoder().encode(text);
}
