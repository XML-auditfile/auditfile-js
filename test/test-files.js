import { createReadStream, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditfileSource } from '../src/index.js';

// The official XAF 3.2 test file from auditfile-spec, and variations of it written to a temporary folder.

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specRoot = resolve(root, process.env.SPEC_ROOT ?? 'spec');

export const OFFICIAL_NAMESPACE = 'http://www.auditfiles.nl/XAF/3.2';
export const official = join(specRoot, 'sources', 'xaf', 'XAF_3.2_20170904', 'XmlAuditfileFinancieel3.2_test.xml');
export const officialText = readFileSync(official, 'utf8').replaceAll('\r\n', '\n').replaceAll('\r', '\n');

export function write(name, content) {
    const path = join(mkdtempSync(join(tmpdir(), 'auditfile-js-tests-')), name);
    writeFileSync(path, content);
    return path;
}

/** A file on disk as a source; the reader itself never opens files. */
export function source(path) {
    return AuditfileSource.fromFactory(() => createReadStream(path), basename(path));
}

export function withNamespace(ns) {
    return write('namespace.xaf', officialText.replace(`xmlns="${OFFICIAL_NAMESPACE}"`, `xmlns="${ns}"`));
}

export function bytes(text) {
    return new TextEncoder().encode(text);
}
