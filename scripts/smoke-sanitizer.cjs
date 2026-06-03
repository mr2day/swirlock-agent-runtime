// Confirms the new regex character class behaves as designed:
// strips forbidden code points, keeps the legitimate-use ones.

function codePointToEscape(cp) {
  return '\\u' + cp.toString(16).padStart(4, '0');
}

const FORBIDDEN_BMP = (() => {
  const e = codePointToEscape;
  const cls = [
    e(0x0001) + '-' + e(0x0008),
    e(0x000B),
    e(0x000C),
    e(0x000E) + '-' + e(0x001F),
    e(0xD800) + '-' + e(0xDFFF),
    e(0xFDD0) + '-' + e(0xFDEF),
    e(0xFFFE) + e(0xFFFF),
    e(0x202A) + '-' + e(0x202E),
    e(0x2066) + '-' + e(0x2069),
  ].join('');
  return new RegExp('[' + cls + ']', 'g');
})();

const FORBIDDEN_SUPPLEMENTARY = (() => {
  const e = codePointToEscape;
  return new RegExp(
    '[' + e(0xD800) + '-' + e(0xDBFF) + ']' +
    '[' + e(0xDFFE) + e(0xDFFF) + ']',
    'g',
  );
})();

function sanitizeString(s) {
  if (!FORBIDDEN_BMP.test(s) && !FORBIDDEN_SUPPLEMENTARY.test(s)) return s;
  FORBIDDEN_BMP.lastIndex = 0;
  FORBIDDEN_SUPPLEMENTARY.lastIndex = 0;
  return s.replace(FORBIDDEN_BMP, '').replace(FORBIDDEN_SUPPLEMENTARY, '');
}

const cases = [
  ['plain text',           'hello world'],
  ['NUL between chars',    'a' + String.fromCharCode(0x0000) + 'b'],
  ['tab + newline (keep)', 'a' + String.fromCharCode(0x09, 0x0A, 0x0D) + 'b'],
  ['BiDi LRO override',    'a' + String.fromCharCode(0x202D) + 'b'],
  ['lone high surrogate',  'a' + String.fromCharCode(0xD800) + 'b'],
  ['BMP noncharacter',     'a' + String.fromCharCode(0xFFFE) + 'b'],
  ['Arabic noncharacter',  'a' + String.fromCharCode(0xFDD5) + 'b'],
  ['C1 control (keep)',    'a' + String.fromCharCode(0x0085) + 'b'],
  ['ZWJ (keep)',           'a' + String.fromCharCode(0x200D) + 'b'],
  ['BOM (keep)',           'a' + String.fromCharCode(0xFEFF) + 'b'],
  ['supplementary nonchar',
    'a' + String.fromCharCode(0xD83F, 0xDFFE) + 'b'], // U+1FFFE
];

let pass = 0;
let fail = 0;
for (const [label, input] of cases) {
  const out = sanitizeString(input);
  const before = [...input].map((c) => 'U+' + c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()).join(' ');
  const after = [...out].map((c) => 'U+' + c.codePointAt(0).toString(16).padStart(4, '0').toUpperCase()).join(' ');
  const shouldKeep = label.includes('keep');
  const wasUntouched = input === out;
  const ok = shouldKeep ? wasUntouched : !wasUntouched;
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label.padEnd(28) + '  ' + before + '   →   ' + after);
  if (ok) pass++; else fail++;
}
console.log('');
console.log(pass + ' pass / ' + fail + ' fail');
process.exit(fail === 0 ? 0 : 1);
