// The XSD built-in simple types this validator supports, with their lexical rules.
// A type that is not listed is refused when the schema is compiled.

import { Decimal } from '../internal/decimal.js';

const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER = /^[+-]?\d+$/;
const FLOAT = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const ZONE = '(?:Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))?';
const DATE = new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})${ZONE}$`);
const DATE_TIME = new RegExp(`^(-?\\d{4,})-(\\d{2})-(\\d{2})T(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?${ZONE}$`);
const TIME = new RegExp(`^(\\d{2}):(\\d{2}):(\\d{2})(?:\\.\\d+)?${ZONE}$`);
const G_YEAR = new RegExp(`^-?\\d{4,}${ZONE}$`);
const G_YEAR_MONTH = new RegExp(`^-?\\d{4,}-(0[1-9]|1[0-2])${ZONE}$`);
const NAME_START = 'A-Za-z_\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD';
const NAME_CHAR = `${NAME_START}\\-.0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const NC_NAME = new RegExp(`^[${NAME_START}][${NAME_CHAR}]*$`);
const NAME = new RegExp(`^[${NAME_START}:][${NAME_CHAR}:]*$`);
const NMTOKEN = new RegExp(`^[${NAME_CHAR}:]+$`);
const LANGUAGE = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;

function daysInMonth(year, month) {
    return month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function validDate(year, month, day) {
    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(year), month);
}

function validTime(hour, minute, second, text) {
    return (hour < 24 && minute < 60 && second < 60) || (hour === 24 && minute === 0 && second === 0 && !/\.\d*[1-9]/.test(text));
}

const string = (pattern) => (value) => (pattern === null || pattern.test(value) ? value : null);

function decimal(value) {
    return DECIMAL.test(value) ? Decimal.parse(value) ?? bigDecimal(value) : null;
}

/** A decimal outside the range of Decimal.parse (more than 29 digits) is still lexically valid XSD. */
function bigDecimal(value) {
    const [whole, fraction = ''] = value.replace(/^[+-]/, '').split('.');
    const negative = value.startsWith('-');
    const coefficient = BigInt((whole || '0') + fraction);
    return new Decimal(negative ? -coefficient : coefficient, fraction.length);
}

const integer = (min, max) => (value) => {
    if (!INTEGER.test(value)) {
        return null;
    }

    const parsed = BigInt(value);
    return (min !== null && parsed < min) || (max !== null && parsed > max) ? null : new Decimal(parsed, 0);
};

const range = (bits, signed) => signed
    ? integer(-(2n ** BigInt(bits - 1)), 2n ** BigInt(bits - 1) - 1n)
    : integer(0n, 2n ** BigInt(bits) - 1n);

/**
 * Built-in types: whitespace handling, whether the value space is numeric (for numeric facets),
 * and a parser that returns the value or null when the text is not valid.
 */
export const BUILTINS = new Map([
    ['anySimpleType', { whiteSpace: 'preserve', numeric: false, parse: string(null) }],
    ['string', { whiteSpace: 'preserve', numeric: false, parse: string(null) }],
    ['normalizedString', { whiteSpace: 'replace', numeric: false, parse: string(null) }],
    ['token', { whiteSpace: 'collapse', numeric: false, parse: string(null) }],
    ['language', { whiteSpace: 'collapse', numeric: false, parse: string(LANGUAGE) }],
    ['Name', { whiteSpace: 'collapse', numeric: false, parse: string(NAME) }],
    ['NCName', { whiteSpace: 'collapse', numeric: false, parse: string(NC_NAME) }],
    ['ID', { whiteSpace: 'collapse', numeric: false, parse: string(NC_NAME), id: true }],
    ['IDREF', { whiteSpace: 'collapse', numeric: false, parse: string(NC_NAME) }],
    ['NMTOKEN', { whiteSpace: 'collapse', numeric: false, parse: string(NMTOKEN) }],
    ['anyURI', { whiteSpace: 'collapse', numeric: false, parse: string(null) }],
    ['boolean', { whiteSpace: 'collapse', numeric: false, parse: string(/^(?:true|false|1|0)$/) }],
    ['float', { whiteSpace: 'collapse', numeric: false, parse: string(FLOAT) }],
    ['double', { whiteSpace: 'collapse', numeric: false, parse: string(FLOAT) }],
    ['decimal', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: decimal }],
    ['integer', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: integer(null, null) }],
    ['nonNegativeInteger', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: integer(0n, null) }],
    ['positiveInteger', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: integer(1n, null) }],
    ['nonPositiveInteger', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: integer(null, 0n) }],
    ['negativeInteger', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: integer(null, -1n) }],
    ['long', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(64, true) }],
    ['int', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(32, true) }],
    ['short', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(16, true) }],
    ['byte', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(8, true) }],
    ['unsignedLong', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(64, false) }],
    ['unsignedInt', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(32, false) }],
    ['unsignedShort', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(16, false) }],
    ['unsignedByte', { whiteSpace: 'collapse', numeric: true, decimal: true, parse: range(8, false) }],
    ['date', {
        whiteSpace: 'collapse', numeric: false,
        parse: (v) => {
            const m = DATE.exec(v);
            return m !== null && validDate(m[1], Number(m[2]), Number(m[3])) ? v : null;
        },
    }],
    ['dateTime', {
        whiteSpace: 'collapse', numeric: false,
        parse: (v) => {
            const m = DATE_TIME.exec(v);
            return m !== null && validDate(m[1], Number(m[2]), Number(m[3])) && validTime(Number(m[4]), Number(m[5]), Number(m[6]), v) ? v : null;
        },
    }],
    ['time', {
        whiteSpace: 'collapse', numeric: false,
        parse: (v) => {
            const m = TIME.exec(v);
            return m !== null && validTime(Number(m[1]), Number(m[2]), Number(m[3]), v) ? v : null;
        },
    }],
    ['gYear', { whiteSpace: 'collapse', numeric: false, parse: string(G_YEAR) }],
    ['gYearMonth', { whiteSpace: 'collapse', numeric: false, parse: string(G_YEAR_MONTH) }],
]);

/**
 * Applies a whiteSpace facet value.
 * @param {string} value
 * @param {'preserve' | 'replace' | 'collapse'} mode
 */
export function normalizeWhiteSpace(value, mode) {
    if (mode === 'preserve') {
        return value;
    }

    const replaced = value.replace(/[\t\n\r]/g, ' ');
    return mode === 'replace' ? replaced : replaced.replace(/ {2,}/g, ' ').replace(/^ | $/g, '');
}

/**
 * Total and fraction digits of a decimal, as the XSD facets count them.
 * @param {Decimal} value
 */
export function digitsOf(value) {
    const normalized = value.normalize();
    const digits = (normalized.coefficient < 0n ? -normalized.coefficient : normalized.coefficient).toString().replace(/^0+/, '');
    return { total: Math.max(digits.length, normalized.scale, 1), fraction: normalized.scale };
}
