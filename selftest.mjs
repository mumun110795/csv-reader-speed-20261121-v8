// selftest.mjs — spot-check solve.js run() against answers produced by the
// kit's baseline driver (csv-reader 1.0.0 semantics) for 8 pinned cases.
// Run: node selftest.mjs  →  prints "selftest: 8/8 ok" and exits 0.
import { run } from './solve.js';

const CASES = [
  [{ text: 'a,b\n1,2', header: true }, { columns: ['a', 'b'], rows: [['1', '2']], errors: [] }],
  [{ text: 'a,b\n1', header: true }, { columns: ['a', 'b'], rows: [['1', '']], errors: [{ code: 'short_row', line: 2, row: 0, fields: 1 }] }],
  [{ text: '"x\ny",z', header: false }, { columns: null, rows: [['x\ny', 'z']], errors: [] }],
  [{ text: 'a\rb', header: false }, { columns: null, rows: [['ab']], errors: [{ code: 'stray_cr', line: 1, row: 0 }] }],
  [{ text: '"ab"cd,e', header: false }, { columns: null, rows: [['abcd', 'e']], errors: [{ code: 'quote_junk', line: 1, row: 0 }] }],
  [{ text: '"abc', header: false }, { columns: null, rows: [['"abc']], errors: [{ code: 'unterminated_quote', line: 1, row: 0 }] }],
  [{ text: '﻿a,b', header: true }, { columns: ['a', 'b'], rows: [], errors: [] }],
  [{ text: 'a,b,c\n1,2,3,4', header: true }, { columns: ['a', 'b', 'c'], rows: [['1', '2', '3']], errors: [{ code: 'long_row', line: 2, row: 0, extra: ['4'] }] }],
];

let ok = 0;
for (const [input, want] of CASES) {
  const got = run(input);
  if (JSON.stringify(got) === JSON.stringify(want)) ok++;
  else console.error('MISMATCH', JSON.stringify(input), '\n got :', JSON.stringify(got), '\n want:', JSON.stringify(want));
}
console.log(`selftest: ${ok}/${CASES.length} ok`);
process.exit(ok === CASES.length ? 0 : 1);
