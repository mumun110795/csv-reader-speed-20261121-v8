// solve.js — kit contract: run(input) returns csv-reader 1.0.0's answer
// for {text, header}. The work is done by the same WASM byte-domain
// transducer as main.ts: the single case is wrapped in a one-element
// cases file (JSON.stringify spells lone surrogates and control
// characters as escapes, which the module's decode path handles), run
// through the module, and the one answer is parsed back.
import { readFileSync } from 'node:fs';

const wasmBytes = readFileSync(new URL('./parser.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: {
    abort: () => {
      throw new Error('wasm abort');
    },
  },
});
const ex = instance.exports;
const mem = ex.memory;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function run(input) {
  const file = JSON.stringify([
    { id: 'case', input: { text: input.text, header: input.header } },
  ]);
  const bytes = encoder.encode(file);
  const inPtr = ex.prepare(bytes.length);
  new Uint8Array(mem.buffer).set(bytes, inPtr);
  const outLen = ex.process(bytes.length);
  const out = new Uint8Array(mem.buffer, ex.getOutOff(), outLen);
  return JSON.parse(decoder.decode(out))[0];
}
