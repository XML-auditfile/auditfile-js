import { OPEN, PartInfo, SourceUsageError } from '../reading/source.js';
import { PartEncoding, PartEncodingError } from './encoding.js';
import { Sha256 } from './sha256.js';

const PREFIX_SIZE = 1024;

/** A part could not be opened or read; reported as XAF-X002, never thrown to the caller. */
export class SourceError extends Error {
    constructor(part, cause) {
        super(cause?.message ?? String(cause), { cause });
        this.name = 'SourceError';
        this.part = part;
    }
}

/** Runs a call into the caller's stream or factory; any failure becomes a SourceError for that part. */
async function guarded(part, call) {
    try {
        return await call();
    } catch (error) {
        throw error instanceof SourceError || error instanceof SourceUsageError ? error : new SourceError(part, error);
    }
}

/** @param {unknown} chunk */
function toBytes(chunk) {
    if (chunk instanceof Uint8Array) {
        return chunk;
    }

    if (chunk instanceof ArrayBuffer) {
        return new Uint8Array(chunk);
    }

    if (ArrayBuffer.isView(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }

    throw new TypeError('A stream must produce bytes (Uint8Array); text is refused because its encoding is unknown.');
}

async function* single(bytes) {
    yield bytes;
}

async function* fromReader(stream, keepOpen) {
    const reader = stream.getReader();
    let done = false;
    try {
        for (;;) {
            const result = await reader.read();
            if (result.done) {
                done = true;
                return;
            }

            yield result.value;
        }
    } finally {
        if (!done && !keepOpen) {
            await reader.cancel().catch(() => {});
        }

        reader.releaseLock();
    }
}

/**
 * An async iterator over the chunks of any supported stream.
 * With keepOpen the caller's stream is not destroyed when reading stops early.
 * @returns {AsyncIterator<unknown>}
 */
export function iterate(stream, keepOpen) {
    if (stream instanceof Uint8Array || stream instanceof ArrayBuffer || ArrayBuffer.isView(stream)) {
        return single(toBytes(stream));
    }

    if (typeof Blob !== 'undefined' && stream instanceof Blob) {
        return iterate(stream.stream(), false);
    }

    if (stream !== null && typeof stream === 'object') {
        // Node Readable: do not destroy a caller-owned stream.
        if (typeof stream.iterator === 'function' && typeof stream.pipe === 'function') {
            return stream.iterator({ destroyOnReturn: !keepOpen });
        }

        // Web ReadableStream.
        if (typeof stream.getReader === 'function') {
            return fromReader(stream, keepOpen);
        }

        if (typeof stream[Symbol.asyncIterator] === 'function') {
            return stream[Symbol.asyncIterator]();
        }

        if (typeof stream[Symbol.iterator] === 'function') {
            return (async function* () {
                yield* stream;
            })();
        }
    }

    throw new TypeError('Unsupported stream: pass a Readable, ReadableStream, Blob, Uint8Array or an iterable of Uint8Array.');
}

/**
 * Reads the parts of a source one after another as one document.
 * For continuation parts a leading byte order mark and XML declaration are skipped; a part in another encoding
 * than the first is refused (PartEncodingError), because it would be decoded with the encoding of the first part.
 * Collects size, SHA-256 and line count per part when collectStatistics is set.
 */
export class ConcatenatedStream {
    #parts;
    /** @type {PartInfo[]} Statistics of the parts read completely so far. */
    completed = [];
    /** Number (1-based) of the part the most recent chunk came from. */
    part = 0;
    /** Bytes handed out so far, over all parts. */
    position = 0;
    /** @type {PartEncoding | null} */
    #encoding = null;

    /**
     * @param {readonly import('../reading/source.js').SourcePart[]} parts
     * @param {boolean} collectStatistics
     */
    constructor(parts, collectStatistics) {
        this.#parts = parts;
        this.collectStatistics = collectStatistics;
    }

    /** @returns {AsyncGenerator<Uint8Array>} */
    async *chunks() {
        for (const part of this.#parts) {
            this.part = part.number;
            const { stream, keepOpen } = await guarded(part.name, () => part[OPEN]());
            const iterator = iterate(stream, keepOpen);
            const next = () => guarded(part.name, () => iterator.next());
            const statistics = this.collectStatistics ? { hash: Sha256.create(), size: 0, lines: 1, lastWasCarriageReturn: false } : null;
            const track = (bytes) => {
                if (statistics === null) {
                    return;
                }

                statistics.size += bytes.length;
                statistics.hash.update(bytes);
                for (const b of bytes) {
                    if (b === 0x0a) {
                        if (!statistics.lastWasCarriageReturn) {
                            statistics.lines++;
                        }

                        statistics.lastWasCarriageReturn = false;
                    } else if (b === 0x0d) {
                        statistics.lines++;
                        statistics.lastWasCarriageReturn = true;
                    } else {
                        statistics.lastWasCarriageReturn = false;
                    }
                }
            };

            try {
                const prefix = [];
                let prefixLength = 0;
                let done = false;
                while (prefixLength < PREFIX_SIZE) {
                    const result = await next();
                    if (result.done) {
                        done = true;
                        break;
                    }

                    const bytes = toBytes(result.value);
                    prefix.push(bytes);
                    prefixLength += bytes.length;
                }

                const first = concat(prefix, prefixLength);
                track(first);
                const encoding = PartEncoding.detect(first);
                if (part.number === 1) {
                    this.#encoding = encoding;
                } else if (!encoding.sameAs(this.#encoding)) {
                    throw new PartEncodingError(part.number, encoding, this.#encoding);
                }

                const rest = part.number === 1 ? first : first.subarray(encoding.skipDeclaration(first, Math.min(first.length, PREFIX_SIZE)));
                if (rest.length > 0) {
                    this.position += rest.length;
                    yield rest;
                }

                while (!done) {
                    const result = await next();
                    if (result.done) {
                        break;
                    }

                    const bytes = toBytes(result.value);
                    track(bytes);
                    if (bytes.length > 0) {
                        this.position += bytes.length;
                        yield bytes;
                    }
                }

                if (statistics !== null) {
                    this.completed.push(new PartInfo(part.number, part.name, statistics.size, statistics.hash.digestHex(), statistics.lines));
                }
            } finally {
                await iterator.return?.();
            }
        }
    }
}

function concat(chunks, length) {
    if (chunks.length === 1) {
        return chunks[0];
    }

    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
    }

    return bytes;
}
