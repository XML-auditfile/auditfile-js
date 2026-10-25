/** Opens a part; internal so callers cannot bypass the single-use check. */
export const OPEN = Symbol('open');

/**
 * Where an audit file comes from: one stream, or several streams for the parts of a split audit file.
 * The reader never opens files itself; the caller supplies the streams, so the same code runs on a server and in the browser.
 * A factory can be read twice (scan, then load); a plain stream only once.
 *
 * A stream is a Node Readable, a web ReadableStream, a Blob, a Uint8Array, an ArrayBuffer,
 * or any (async) iterable of Uint8Array chunks.
 */
export class AuditfileSource {
    /** @param {SourcePart[]} parts */
    constructor(parts) {
        if (parts.length === 0) {
            throw new RangeError('A source needs at least one part.');
        }

        /** @type {readonly SourcePart[]} The parts in reading order. */
        this.parts = Object.freeze(parts);
        Object.freeze(this);
    }

    /** True when every part can be opened again, so the reader can scan before loading. */
    get canReadTwice() {
        return this.parts.every((p) => p.reopenable);
    }

    /**
     * A stream that can be read only once. The reader does not close or destroy it.
     * @param {unknown} stream
     * @param {string} [name]
     */
    static fromStream(stream, name = 'stream') {
        return AuditfileSource.fromStreams([name, stream]);
    }

    /**
     * A split audit file as streams that can be read only once: the first part followed by its continuation parts, in order.
     * The reader does not close or destroy the streams.
     * @param {...[string, unknown]} parts
     */
    static fromStreams(...parts) {
        return new AuditfileSource(parts.map((part, i) => {
            const [name, stream] = pair(part, 'stream');
            if (stream === null || stream === undefined) {
                throw new TypeError(`Part ${i + 1} has no stream.`);
            }

            let used = false;
            return new SourcePart(i + 1, name, () => {
                if (used) {
                    throw new Error('This stream source can only be read once.');
                }

                used = true;
                return { stream, keepOpen: true };
            }, false);
        }));
    }

    /**
     * A stream factory that returns a fresh stream (or a promise of one) on every call, so the source can be read twice.
     * The reader closes the streams it gets.
     * @example
     * AuditfileSource.fromFactory(() => fs.createReadStream('admin.xaf'), 'admin.xaf');
     * AuditfileSource.fromFactory(() => bytes);
     * @param {() => unknown} open
     * @param {string} [name]
     */
    static fromFactory(open, name = 'stream') {
        return AuditfileSource.fromFactories([name, open]);
    }

    /**
     * A split audit file as stream factories: the first part followed by its continuation parts, in order.
     * Every factory returns a fresh stream on every call, so the source can be read twice. The reader closes the streams it gets.
     * @param {...[string, () => unknown]} parts
     */
    static fromFactories(...parts) {
        return new AuditfileSource(parts.map((part, i) => {
            const [name, open] = pair(part, 'factory');
            if (typeof open !== 'function') {
                throw new TypeError(`Part ${i + 1} needs a factory function.`);
            }

            return new SourcePart(i + 1, name, async () => ({ stream: await open(), keepOpen: false }), true);
        }));
    }
}

function pair(part, what) {
    if (!Array.isArray(part) || part.length !== 2 || typeof part[0] !== 'string') {
        throw new TypeError(`Every part must be a [name, ${what}] pair.`);
    }

    return part;
}

/** One part of a source. */
export class SourcePart {
    #open;

    /** @internal */
    constructor(number, name, open, reopenable) {
        /** Part number (1-based). */
        this.number = number;
        /** File or stream name. */
        this.name = name;
        /** True when the part can be opened more than once. */
        this.reopenable = reopenable;
        this.#open = open;
        Object.freeze(this);
    }

    /** @internal @returns {Promise<{ stream: unknown, keepOpen: boolean }>} */
    async [OPEN]() {
        return this.#open();
    }
}

/** Size, checksum and line count of a source part, known after it has been read once. */
export class PartInfo {
    /** @internal */
    constructor(number, name, size, sha256, lines) {
        /** Part number (1-based). */
        this.number = number;
        /** File or stream name. */
        this.name = name;
        /** Size in bytes. */
        this.size = size;
        /** SHA-256 of the bytes as read, lowercase hex. */
        this.sha256 = sha256;
        /** Number of lines. */
        this.lines = lines;
        Object.freeze(this);
    }
}
