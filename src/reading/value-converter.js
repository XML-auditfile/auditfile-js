import { ColumnType } from '../definitions/manifest.js';
import { Decimal } from '../internal/decimal.js';

/** Converts XML text to typed values, always in XSD notation and independent of locale. */

const INTEGER = /^[+-]?\d+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_ZONE = /^(?:|Z|[+-]\d{2}:\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/;
const TIME = /^(\d{2}):(\d{2}):(\d{2})$/;

// The range of .NET long, so every implementation accepts the same integers; JavaScript numbers must also be safe.
const MIN_INTEGER = -(2n ** 63n);
const MAX_INTEGER = 2n ** 63n - 1n;

/** A converted value, or failure. */
const FAILED = Object.freeze({ ok: false, value: null });

function ok(value) {
    return { ok: true, value };
}

/** A UTC date, or null when the parts do not form a real date. */
function utcDate(year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0) {
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond));
    date.setUTCFullYear(year);
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
        && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second
        ? date
        : null;
}

/**
 * Empty text becomes null. Returns `{ ok: false }` when the text is not valid for the type.
 * @param {string} raw
 * @param {string} type One of {@link ColumnType}.
 * @returns {{ ok: boolean, value: unknown }}
 */
export function tryConvert(raw, type) {
    if (type === ColumnType.String) {
        return ok(raw);
    }

    const text = raw.trim();
    if (text.length === 0) {
        return ok(null);
    }

    switch (type) {
        case ColumnType.Decimal: {
            const value = Decimal.parse(text);
            return value === null ? FAILED : ok(value);
        }

        case ColumnType.Integer: {
            if (!INTEGER.test(text) || text.length > 21) {
                return FAILED;
            }

            const value = BigInt(text);
            return value < MIN_INTEGER || value > MAX_INTEGER || value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)
                ? FAILED
                : ok(Number(value));
        }

        case ColumnType.Date: {
            // The date as written; an optional time zone (Z, +hh:mm, -hh:mm) is ignored, never converted.
            const match = DATE.exec(text.slice(0, 10));
            if (match === null || !TIME_ZONE.test(text.slice(10))) {
                return FAILED;
            }

            const date = utcDate(Number(match[1]), Number(match[2]), Number(match[3]));
            return date === null ? FAILED : ok(date);
        }

        case ColumnType.DateTime: {
            const match = DATE_TIME.exec(text);
            if (match === null) {
                return FAILED;
            }

            const [, year, month, day, hour, minute, second, fraction = '', zone] = match;
            const local = utcDate(Number(year), Number(month), Number(day), Number(hour), Number(minute), Number(second),
                Math.floor(Number(`0.${fraction || '0'}`) * 1000));
            if (local === null) {
                return FAILED;
            }

            if (zone === undefined || zone === 'Z') {
                return ok(local);
            }

            const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6))) * (zone[0] === '-' ? -1 : 1);
            return ok(new Date(local.getTime() - offset * 60000));
        }

        case ColumnType.Time: {
            const match = TIME.exec(text.length >= 8 ? text.slice(0, 8) : text);
            if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3]) > 59) {
                return FAILED;
            }

            return ok(match[0]);
        }

        case ColumnType.Boolean:
            if (text === 'true' || text === '1') {
                return ok(true);
            }

            return text === 'false' || text === '0' ? ok(false) : FAILED;

        default:
            return ok(raw);
    }
}

/**
 * Text form of a value for keys and messages: dates as yyyy-mm-dd, decimals as written.
 * @param {unknown} value
 */
export function toText(value) {
    if (value === null || value === undefined) {
        return '';
    }

    if (value instanceof Date) {
        const iso = value.toISOString();
        return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso;
    }

    return String(value);
}
