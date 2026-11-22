// main.ts — harness driver for the v8 WASM byte-domain CSV transducer.
// Reads /input/cases.json, runs one WASM call, writes /output/answers.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const wasmBytes = readFileSync(new URL('./parser.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(wasmBytes, {
  env: {
    abort: () => {
      throw new Error('wasm abort');
    },
  },
});
const ex = instance.exports as any;
const mem = ex.memory as WebAssembly.Memory;

const data = readFileSync('/input/cases.json');
const inPtr = ex.prepare(data.length) as number;
new Uint8Array(mem.buffer).set(data, inPtr);
const outLen = ex.process(data.length) as number;
// process() may have grown memory (detaching the old buffer): read fresh.
writeFileSync('/output/answers.json', new Uint8Array(mem.buffer, ex.getOutOff(), outLen));
