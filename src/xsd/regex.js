// Translates an XSD pattern facet to a JavaScript regular expression.
// XSD patterns are always anchored and have no ^/$ anchors; unsupported constructs are refused, never approximated.

const SYNTAX = new Set(['\\', '|', '.', '-', '^', '?', '*', '+', '{', '}', '(', ')', '[', ']', '$']);
const CATEGORY = /^(?:[LMNPSZC][a-z]?)$/;

/**
 * @param {string} pattern
 * @returns {RegExp}
 * @throws {Error} The pattern uses a construct this validator does not support.
 */
export function translatePattern(pattern) {
    let out = '';
    let inClass = false;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '\\') {
            const n = pattern[++i];
            switch (n) {
                case 'd':
                    out += '\\p{Nd}';
                    break;
                case 'D':
                    out += '\\P{Nd}';
                    break;
                case 's':
                    out += inClass ? ' \\t\\n\\r' : '[ \\t\\n\\r]';
                    break;
                case 'S':
                    if (inClass) {
                        throw unsupported(pattern, '\\S inside a character class');
                    }

                    out += '[^ \\t\\n\\r]';
                    break;
                case 'n':
                case 'r':
                case 't':
                    out += `\\${n}`;
                    break;
                case 'p':
                case 'P': {
                    const end = pattern.indexOf('}', i);
                    const name = pattern[i + 1] === '{' && end > i ? pattern.slice(i + 2, end) : '';
                    if (!CATEGORY.test(name)) {
                        throw unsupported(pattern, `\\${n}{${name}}`);
                    }

                    out += `\\${n}{${name}}`;
                    i = end;
                    break;
                }

                default:
                    if (n === undefined || !SYNTAX.has(n)) {
                        throw unsupported(pattern, `\\${n ?? ''}`);
                    }

                    // In a JavaScript unicode pattern "\-" is valid only inside a class.
                    out += n === '-' && !inClass ? '-' : `\\${n}`;
            }

            continue;
        }

        if (inClass) {
            if (c === '[') {
                throw unsupported(pattern, 'character class subtraction');
            }

            if (c === ']') {
                inClass = false;
            }

            out += c;
            continue;
        }

        switch (c) {
            case '[':
                inClass = true;
                out += c;
                if (pattern[i + 1] === '^') {
                    out += '^';
                    i++;
                }

                break;
            case '^':
            case '$':
                out += `\\${c}`;
                break;
            case '.':
                out += '[^\\n\\r]';
                break;
            case '(':
                if (pattern[i + 1] === '?') {
                    throw unsupported(pattern, '(?');
                }

                out += c;
                break;
            default:
                out += c;
        }
    }

    if (inClass) {
        throw unsupported(pattern, 'an unclosed character class');
    }

    try {
        return new RegExp(`^(?:${out})$`, 'u');
    } catch (error) {
        throw new Error(`XSD pattern '${pattern}' is not valid: ${error.message}`);
    }
}

function unsupported(pattern, construct) {
    return new Error(`XSD pattern '${pattern}' uses ${construct}, which this validator does not support.`);
}
