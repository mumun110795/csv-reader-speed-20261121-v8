// parser.ts — CSV reader v8: a whole-pipeline WebAssembly transducer that
// works in the UTF-8 byte domain end to end.
//
//   cases.json bytes in -> answers.json bytes out (one exported call).
//
// The JSON walk locates each case's raw "text" span. A case whose span
// contains only canonical JSON escapes (\", \\, \n, \r, \t, \b, \f) is
// parsed directly on the raw bytes with logical-byte semantics: an escape
// counts as the one character it spells, delimiter bytes in the raw span
// are unambiguous (a raw '"' is always an escaped quote character, a raw
// ',' always a comma), and a field that needs no transformation is copied
// verbatim — its raw bytes already are the canonical JSON spelling of its
// value. A case whose span holds a \u or \/ escape is first decoded and
// re-encoded into a canonical span (lone surrogates and unspellable C0
// controls stay as \uXXXX, which the parser reads as non-delimiter
// content and copies verbatim — again the canonical spelling), then goes
// through the same byte parser. There is no UTF-16 stage anywhere.
//
// CSV semantics are csv-reader 1.0.0's, pinned black-box (see NOTES.md).
//
// Memory layout (byte offsets, all set by prepare()):
//   [0, IN_OFF)        statics
//   [IN_OFF, inEnd)    input bytes (written by the host)
//   case region        re-encode buffer | error descriptors | extras blobs
//   record region      field segments | field table | transform scratch
//   output region      answers bytes (grows geometrically at the very end)

// ---------------------------------------------------------------- constants
const IN_OFF: i32 = 1048576;
const BS: i32 = 0x5c;   // backslash
const QUOT: i32 = 0x22; // "
const COMMA: i32 = 0x2c;

const E_STRAY: i32 = 0;
const E_JUNK: i32 = 1;
const E_UNTERM: i32 = 2;
const E_SHORT: i32 = 3;
const E_LONG: i32 = 4;

const T_COMMA: i32 = 0;
const T_EOL: i32 = 1;
const T_EOF: i32 = 2;

// ------------------------------------------------------------------- layout
// [IN_OFF, inEnd) input | case table (16 B per case) | key buffer |
// case region (re-encode | error descriptors | extras) | record region
// (segments | field table | scratch) | output (last, grows at the end).
// The arenas reset per case / per record, so prepare() only reserves the
// input + table + key buffer; process() first measures the walk (filling
// the table), then sizes the arenas from the LARGEST case span — a true
// bound for every arena (see NOTES.md) — and grows memory once more.
let inEnd: i32 = 0;
let tableOff: i32 = 0;
let tableCnt: i32 = 0;
let maxSpan: i32 = 0;
let kbOff: i32 = 0; // decoded-key scratch (512 B)
let rebOff: i32 = 0; // case region: re-encoded span
let errOff: i32 = 0; // case region: error descriptors, 16 B each
let extOff: i32 = 0; // case region: long_row extras blobs
let extPtr: i32 = 0;
let segOff: i32 = 0; // record region: segment entries [ptr,len], 8 B each
let fldOff: i32 = 0; // record region: field entries [segIdx,segCnt]
let scrOff: i32 = 0; // record region: transform scratch
let outOff: i32 = 0;
let outEnd: i32 = 0;
let outPtr: i32 = 0;

// ------------------------------------------------------------------- walker
let wp: i32 = 0; // walk cursor
let strS: i32 = 0; // string content span found by scanStr
let strE: i32 = 0;
let scanFb: bool = false; // span contained a \u or \/ escape
let caseTs: i32 = 0;
let caseTe: i32 = 0;
let caseFallback: bool = false;
let caseHeader: bool = false;
let kbLen: i32 = 0; // decoded key bytes at caseOff (512 B reserved)
let kbBad: bool = false;

// ------------------------------------------------------------------- parser
let sp: i32 = 0; // cursor in the span being parsed
let spanEnd: i32 = 0;
let physLine: i32 = 1;
let recStartLine: i32 = 1;
let begun: bool = false;
let headerMode: bool = false;
let width: i32 = -1;
let recordsDone: i32 = 0;
let rowsOut: i32 = 0;
let rowsOpen: bool = false;
let errCnt: i32 = 0;
let segCnt: i32 = 0;
let fldCnt: i32 = 0;
let scrPtr: i32 = 0;
let fTerm: i32 = T_EOF;
let fHad: bool = false;
let fSegStart: i32 = 0;
let fSegCnt: i32 = 0;

// -------------------------------------------------------------------- stats
let statFbCases: i32 = 0;
let statFbBytes: i32 = 0;
let statErrHW: i32 = 0;
let statExtHW: i32 = 0;
let statSegHW: i32 = 0;
let mode: i32 = 0; // 0 = full, 1 = walk only, 2 = no-emit (bench anatomy)

export function setMode(m: i32): void { mode = m; }
export function getFbCases(): i32 { return statFbCases; }
export function getFbBytes(): i32 { return statFbBytes; }
export function getErrHW(): i32 { return statErrHW; }
export function getExtHW(): i32 { return statExtHW; }
export function getSegHW(): i32 { return statSegHW; }
export function getOutOff(): i32 { return outOff; }

// ------------------------------------------------------------------ prepare
// Reserve input + case table + key buffer; return the input offset. The JS
// side writes the input bytes there, then calls process(), which measures
// the walk (filling the table), sizes the arenas from the largest case span
// and grows memory once more.
export function prepare(len: i32): i32 {
  inEnd = IN_OFF + len;
  tableOff = (inEnd + 7) & ~7;
  kbOff = tableOff + (len >> 1) + 65536;
  const total: i64 = <i64>kbOff + 512;
  const pages: i64 = (total + 65535) / 65536;
  const cur: i32 = memory.size();
  if (pages > <i64>cur) memory.grow(<i32>(pages - <i64>cur));
  return IN_OFF;
}

// Size the arenas from the largest case span and grow memory to fit.
// Per-span true bounds: re-encode <= span; error descriptors <= 8*span
// (each event charges >= 2 distinct span bytes, +1 final-record slack);
// extras <= 6*span; segments <= 12*span (raw runs are disjoint, transform
// segments charge >= 2 bytes each); fields <= 8*span; scratch <= 4*span.
function finalizeLayout(): void {
  // Clamp for absurd single-case inputs so offsets stay in i32 range.
  let budget: i64 = 3900000000 - <i64>kbOff - 512 - 1048576;
  if (budget < 0) budget = 0;
  let eff: i64 = <i64>maxSpan;
  if (39 * eff > budget) eff = budget / 39;
  const e: i32 = <i32>eff;
  rebOff = kbOff + 512;
  errOff = rebOff + e + 4096;
  extOff = errOff + 8 * e + 8192;
  segOff = extOff + 6 * e + 16384;
  fldOff = segOff + 12 * e + 8192;
  scrOff = fldOff + 8 * e + 8192;
  outOff = scrOff + 4 * e + 16384;
  outEnd = outOff + 1048576;
  outPtr = outOff;
  const total: i64 = <i64>outEnd;
  const pages: i64 = (total + 65535) / 65536;
  const cur: i32 = memory.size();
  if (pages > <i64>cur) memory.grow(<i32>(pages - <i64>cur));
}

// --------------------------------------------------------------------- emit
function ensureOut(n: i32): void {
  if (outPtr + n > outEnd) {
    let need = outPtr + n - outEnd;
    const region = outEnd - outOff;
    let add = region > need ? region : need;
    add = (add + 65535) & ~65535;
    if (add == 0) add = 65536;
    memory.grow(add >> 16);
    outEnd += add;
  }
}

function emitB(b: i32): void {
  if (mode == 2) return;
  ensureOut(1);
  store<u8>(outPtr++, b as u8);
}

function emitBytes(src: i32, len: i32): void {
  if (len <= 0 || mode == 2) return;
  ensureOut(len);
  memory.copy(outPtr, src, len);
  outPtr += len;
}

function emitStr(s: string): void {
  if (mode == 2) return;
  const n = s.length;
  ensureOut(n);
  for (let i = 0; i < n; i++) store<u8>(outPtr + i, s.charCodeAt(i) as u8);
  outPtr += n;
}

function emitNum(v: i32): void {
  if (v >= 10) emitNum(v / 10);
  emitB(48 + (v % 10));
}

// ------------------------------------------------------------- SWAR search
const SW_ONES: u64 = 0x0101010101010101;
const SW_HIGHS: u64 = 0x8080808080808080;

function zeroMask(x: u64): u64 {
  return (x - SW_ONES) & ~x & SW_HIGHS;
}

// First index in [q, end) whose byte equals t1 (or t2 when t2 >= 0); end if
// none. First-match is exact: a borrow in the SWAR subtraction can only
// flag a byte that follows a true match.
function find2(q: i32, end: i32, t1: i32, t2: i32): i32 {
  const s1: u64 = SW_ONES * (t1 as u64);
  const s2: u64 = SW_ONES * (t2 as u64);
  let i = q;
  while (i + 8 <= end) {
    const x = load<u64>(i);
    let m = zeroMask(x ^ s1);
    if (t2 >= 0) m |= zeroMask(x ^ s2);
    if (m != 0) return i + ((ctz(m) as i32) >> 3);
    i += 8;
  }
  while (i < end) {
    const b = load<u8>(i) as i32;
    if (b == t1 || b == t2) return i;
    i++;
  }
  return end;
}

// ------------------------------------------------------- logical byte access
function hexVal(c: i32): i32 {
  if (c >= 48 && c <= 57) return c - 48;
  if (c >= 97 && c <= 102) return c - 87;
  if (c >= 65 && c <= 70) return c - 55;
  return 0;
}

function hex4(q: i32): i32 {
  return (hexVal(load<u8>(q) as i32) << 12) |
    (hexVal(load<u8>(q + 1) as i32) << 8) |
    (hexVal(load<u8>(q + 2) as i32) << 4) |
    hexVal(load<u8>(q + 3) as i32);
}

// Value of a simple escape letter (the byte after a backslash), or -1.
function escVal(c: i32): i32 {
  if (c == 0x22) return 0x22;
  if (c == BS) return BS;
  if (c == 0x2f) return 0x2f;
  if (c == 0x6e) return 0x0a;
  if (c == 0x72) return 0x0d;
  if (c == 0x74) return 0x09;
  if (c == 0x62) return 0x08;
  if (c == 0x66) return 0x0c;
  return -1;
}

// Logical character at raw position q (an escape counts as one character).
function lbAt(q: i32): i32 {
  const b = load<u8>(q) as i32;
  if (b != BS) return b;
  const c = load<u8>(q + 1) as i32;
  if (c == 0x75) return hex4(q + 2); // \uXXXX
  const v = escVal(c);
  return v >= 0 ? v : c;
}

// Raw length of the logical character at q.
function lbLen(q: i32): i32 {
  if ((load<u8>(q) as i32) != BS) return 1;
  return (load<u8>(q + 1) as i32) == 0x75 ? 6 : 2;
}

// ------------------------------------------------- fallback: decode + re-encode
// A case whose raw span uses \u or \/ escapes is decoded exactly as
// JSON.parse would (code unit by code unit; raw UTF-8 becomes code points)
// and re-encoded in canonical JSON spelling into the re-encode buffer.
// The result is parsed by the same byte parser as any other case: the only
// \u escapes left in it spell lone surrogates and C0 controls without a
// short escape — both non-delimiters whose canonical spelling is \uXXXX,
// so verbatim copies stay byte-exact.
let rebPtr: i32 = 0;
let rebPendHi: i32 = -1;

function rebByte(b: i32): void {
  store<u8>(rebPtr++, b as u8);
}

function rebEscU(u: i32): void {
  rebByte(BS);
  rebByte(0x75); // u
  const hex = '0123456789abcdef';
  rebByte(hex.charCodeAt((u >> 12) & 15));
  rebByte(hex.charCodeAt((u >> 8) & 15));
  rebByte(hex.charCodeAt((u >> 4) & 15));
  rebByte(hex.charCodeAt(u & 15));
}

function rebUtf8(cp: i32): void {
  if (cp < 0x80) {
    rebByte(cp);
  } else if (cp < 0x800) {
    rebByte(0xc0 | (cp >> 6));
    rebByte(0x80 | (cp & 63));
  } else if (cp < 0x10000) {
    rebByte(0xe0 | (cp >> 12));
    rebByte(0x80 | ((cp >> 6) & 63));
    rebByte(0x80 | (cp & 63));
  } else {
    rebByte(0xf0 | (cp >> 18));
    rebByte(0x80 | ((cp >> 12) & 63));
    rebByte(0x80 | ((cp >> 6) & 63));
    rebByte(0x80 | (cp & 63));
  }
}

// Canonical spelling of one BMP code unit that is not a surrogate.
function rebUnitPlain(u: i32): void {
  if (u == QUOT) { rebByte(BS); rebByte(QUOT); return; }
  if (u == BS) { rebByte(BS); rebByte(BS); return; }
  if (u == 0x08) { rebByte(BS); rebByte(0x62); return; }
  if (u == 0x09) { rebByte(BS); rebByte(0x74); return; }
  if (u == 0x0a) { rebByte(BS); rebByte(0x6e); return; }
  if (u == 0x0c) { rebByte(BS); rebByte(0x66); return; }
  if (u == 0x0d) { rebByte(BS); rebByte(0x72); return; }
  if (u < 0x20) { rebEscU(u); return; }
  rebUtf8(u);
}

// Feed one decoded UTF-16 code unit; a high surrogate is held back one
// step so a following low surrogate combines into the raw astral char.
function rebUnit(u: i32): void {
  if (rebPendHi >= 0) {
    if (u >= 0xdc00 && u <= 0xdfff) {
      const cp = 0x10000 + ((rebPendHi - 0xd800) << 10) + (u - 0xdc00);
      rebUtf8(cp);
      rebPendHi = -1;
      return;
    }
    rebEscU(rebPendHi);
    rebPendHi = -1;
  }
  if (u >= 0xd800 && u <= 0xdbff) { rebPendHi = u; return; }
  if (u >= 0xdc00 && u <= 0xdfff) { rebEscU(u); return; }
  rebUnitPlain(u);
}

// Decode the raw span [ts, te) and re-encode it at rebOff; returns length.
function reEncode(ts: i32, te: i32): i32 {
  rebPtr = rebOff;
  rebPendHi = -1;
  let i = ts;
  while (i < te) {
    const b = load<u8>(i) as i32;
    if (b == BS) {
      const c = load<u8>(i + 1) as i32;
      if (c == 0x75) {
        rebUnit(hex4(i + 2));
        i += 6;
      } else {
        const v = escVal(c);
        rebUnit(v >= 0 ? v : c);
        i += 2;
      }
    } else if (b < 0x80) {
      rebUnit(b);
      i += 1;
    } else {
      // raw UTF-8 sequence -> code point
      let cp: i32;
      let n: i32;
      if (b >= 0xf0) {
        cp = ((b & 7) << 18) | ((load<u8>(i + 1) as i32 & 63) << 12) |
          ((load<u8>(i + 2) as i32 & 63) << 6) | (load<u8>(i + 3) as i32 & 63);
        n = 4;
      } else if (b >= 0xe0) {
        cp = ((b & 15) << 12) | ((load<u8>(i + 1) as i32 & 63) << 6) |
          (load<u8>(i + 2) as i32 & 63);
        n = 3;
      } else {
        cp = ((b & 31) << 6) | (load<u8>(i + 1) as i32 & 63);
        n = 2;
      }
      if (cp < 0x10000) {
        rebUnit(cp);
      } else {
        rebUnit(0xd800 + ((cp - 0x10000) >> 10));
        rebUnit(0xdc00 + (cp & 0x3ff));
      }
      i += n;
    }
  }
  if (rebPendHi >= 0) {
    rebEscU(rebPendHi);
    rebPendHi = -1;
  }
  return rebPtr - rebOff;
}

// ------------------------------------------------------------------- walker
function skipWs(): void {
  while (wp < inEnd) {
    const b = load<u8>(wp) as i32;
    if (b == 0x20 || b == 0x09 || b == 0x0a || b == 0x0d) wp++;
    else break;
  }
}

// wp is at the opening quote; sets strS/strE to the content span, scanFb
// when the string uses a \u or \/ escape, and moves wp past the close.
function scanStr(): void {
  wp++;
  strS = wp;
  scanFb = false;
  while (true) {
    const q = find2(wp, inEnd, QUOT, BS);
    if (q >= inEnd) {
      strE = inEnd;
      wp = inEnd;
      return;
    }
    if ((load<u8>(q) as i32) == QUOT) {
      strE = q;
      wp = q + 1;
      return;
    }
    const c = load<u8>(q + 1) as i32;
    if (c == 0x75 || c == 0x2f) scanFb = true;
    wp = q + 2;
  }
}

function kbPut(b: i32): void {
  if (kbLen < 500) store<u8>(kbOff + kbLen, b as u8);
  kbLen++;
}

// Decode the key string at wp into the key buffer; returns a key id:
// 1 = "id", 2 = "input", 3 = "text", 4 = "header", 0 = anything else.
function parseKey(): i32 {
  scanStr();
  kbLen = 0;
  kbBad = false;
  let i = strS;
  while (i < strE) {
    const b = load<u8>(i) as i32;
    if (b == BS) {
      const c = load<u8>(i + 1) as i32;
      if (c == 0x75) {
        const v = hex4(i + 2);
        if (v < 0x80) kbPut(v); else kbBad = true;
        i += 6;
      } else {
        const v = escVal(c);
        kbPut(v >= 0 ? v : c);
        i += 2;
      }
    } else {
      if (b >= 0x80) kbBad = true;
      kbPut(b);
      i += 1;
    }
  }
  if (kbBad) return 0;
  if (kbLen == 2 && load<u8>(kbOff) == 0x69 && load<u8>(kbOff + 1) == 0x64) return 1;
  if (kbLen == 5 && load<u8>(kbOff) == 0x69 && load<u8>(kbOff + 1) == 0x6e &&
    load<u8>(kbOff + 2) == 0x70 && load<u8>(kbOff + 3) == 0x75 &&
    load<u8>(kbOff + 4) == 0x74) return 2;
  if (kbLen == 4 && load<u8>(kbOff) == 0x74 && load<u8>(kbOff + 1) == 0x65 &&
    load<u8>(kbOff + 2) == 0x78 && load<u8>(kbOff + 3) == 0x74) return 3;
  if (kbLen == 6 && load<u8>(kbOff) == 0x68 && load<u8>(kbOff + 1) == 0x65 &&
    load<u8>(kbOff + 2) == 0x61 && load<u8>(kbOff + 3) == 0x64 &&
    load<u8>(kbOff + 4) == 0x65 && load<u8>(kbOff + 5) == 0x72) return 4;
  return 0;
}

function skipValue(depth: i32): void {
  skipWs();
  if (wp >= inEnd) return;
  const b = load<u8>(wp) as i32;
  if (b == QUOT) {
    scanStr();
    return;
  }
  if (b == 0x7b && depth < 100) { // {
    wp++;
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == 0x7d) { wp++; return; }
    while (true) {
      parseKey();
      skipWs();
      if (wp < inEnd && (load<u8>(wp) as i32) == 0x3a) wp++;
      skipValue(depth + 1);
      skipWs();
      if (wp < inEnd && (load<u8>(wp) as i32) == COMMA) { wp++; continue; }
      if (wp < inEnd) wp++;
      return;
    }
  }
  if (b == 0x5b && depth < 100) { // [
    wp++;
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == 0x5d) { wp++; return; }
    while (true) {
      skipValue(depth + 1);
      skipWs();
      if (wp < inEnd && (load<u8>(wp) as i32) == COMMA) { wp++; continue; }
      if (wp < inEnd) wp++;
      return;
    }
  }
  // number / true / false / null: up to the next delimiter
  while (wp < inEnd) {
    const c = load<u8>(wp) as i32;
    if (c == COMMA || c == 0x7d || c == 0x5d || c == 0x20 || c == 0x09 ||
      c == 0x0a || c == 0x0d) break;
    wp++;
  }
}

function parseInputObj(): void {
  // wp at '{' of the "input" value
  wp++;
  while (true) {
    skipWs();
    if (wp >= inEnd) return;
    if ((load<u8>(wp) as i32) == 0x7d) { wp++; return; }
    const kid = parseKey();
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == 0x3a) wp++;
    skipWs();
    if (kid == 3 && wp < inEnd && (load<u8>(wp) as i32) == QUOT) {
      scanStr();
      caseTs = strS;
      caseTe = strE;
      caseFallback = scanFb;
    } else if (kid == 4) {
      if (wp < inEnd && (load<u8>(wp) as i32) == 0x74) {
        caseHeader = true;
        wp += 4;
      } else if (wp < inEnd && (load<u8>(wp) as i32) == 0x66) {
        caseHeader = false;
        wp += 5;
      } else {
        skipValue(0);
      }
    } else {
      skipValue(0);
    }
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == COMMA) { wp++; continue; }
    if (wp < inEnd && (load<u8>(wp) as i32) == 0x7d) wp++;
    return;
  }
}

function parseCaseObj(): void {
  caseTs = 0;
  caseTe = 0;
  caseFallback = false;
  caseHeader = false;
  skipWs();
  if (wp < inEnd && (load<u8>(wp) as i32) == 0x7b) wp++;
  while (true) {
    skipWs();
    if (wp >= inEnd) return;
    if ((load<u8>(wp) as i32) == 0x7d) { wp++; return; }
    const kid = parseKey();
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == 0x3a) wp++;
    skipWs();
    if (kid == 2 && wp < inEnd && (load<u8>(wp) as i32) == 0x7b) {
      parseInputObj();
    } else {
      skipValue(0);
    }
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == COMMA) { wp++; continue; }
    if (wp < inEnd && (load<u8>(wp) as i32) == 0x7d) wp++;
    return;
  }
}

// ------------------------------------------------------------- CSV parser
function rowCur(): i32 {
  if (headerMode) return recordsDone == 0 ? -1 : recordsDone - 1;
  return recordsDone;
}

function pushErr(code: i32, line: i32, row: i32, aux: i32): void {
  const d = errOff + 16 * errCnt;
  store<i32>(d, code);
  store<i32>(d + 4, line);
  store<i32>(d + 8, row);
  store<i32>(d + 12, aux);
  errCnt++;
  if (16 * errCnt > statErrHW) statErrHW = 16 * errCnt;
}

function segPush(ptr: i32, len: i32): void {
  if (len <= 0) return;
  store<i32>(segOff + 8 * segCnt, ptr);
  store<i32>(segOff + 8 * segCnt + 4, len);
  segCnt++;
  if (8 * segCnt > statSegHW) statSegHW = 8 * segCnt;
}

// Append two raw bytes to the transform scratch and segment them.
function scrPush2(b1: i32, b2: i32): void {
  store<u8>(scrPtr, b1 as u8);
  store<u8>(scrPtr + 1, b2 as u8);
  segPush(scrPtr, 2);
  scrPtr += 2;
}

function parseUnquoted(): void {
  let segStart = sp;
  while (true) {
    const q = find2(sp, spanEnd, COMMA, BS);
    if (q >= spanEnd) {
      segPush(segStart, spanEnd - segStart);
      sp = spanEnd;
      fTerm = T_EOF;
      break;
    }
    if ((load<u8>(q) as i32) == COMMA) {
      segPush(segStart, q - segStart);
      sp = q + 1;
      fTerm = T_COMMA;
      break;
    }
    const L = load<u8>(q + 1) as i32;
    if (L == 0x6e) { // \n ends the record
      segPush(segStart, q - segStart);
      sp = q + 2;
      physLine++;
      fTerm = T_EOL;
      break;
    }
    if (L == 0x72) { // \r
      if (q + 3 < spanEnd && (load<u8>(q + 2) as i32) == BS &&
        (load<u8>(q + 3) as i32) == 0x6e) { // \r\n ends the record
        segPush(segStart, q - segStart);
        sp = q + 4;
        physLine++;
        fTerm = T_EOL;
        break;
      }
      // stray CR: dropped, error, field continues
      pushErr(E_STRAY, begun ? recStartLine : physLine, rowCur(), 0);
      segPush(segStart, q - segStart);
      sp = q + 2;
      segStart = sp;
      continue;
    }
    // any other escape is field content
    sp = q + (L == 0x75 ? 6 : 2);
  }
  let tot = 0;
  for (let i = fSegStart; i < segCnt; i++) tot += load<i32>(segOff + 8 * i + 4);
  fHad = tot > 0;
}

function parseQuoted(): void {
  const openPos = sp;
  const lineMark = physLine;
  const scrMark = scrPtr;
  sp += 2; // opening \"
  let segStart = sp;
  let closed = false;
  while (!closed) {
    const q = find2(sp, spanEnd, BS, -1);
    if (q >= spanEnd) {
      // unterminated: the quote is a literal character and the field is
      // re-read as unquoted; error first, then the re-read's own errors.
      segCnt = fSegStart;
      scrPtr = scrMark;
      physLine = lineMark;
      pushErr(E_UNTERM, recStartLine, rowCur(), 0);
      sp = openPos;
      parseUnquoted();
      return;
    }
    const L = load<u8>(q + 1) as i32;
    if (L == QUOT) {
      if (q + 3 < spanEnd && (load<u8>(q + 2) as i32) == BS &&
        (load<u8>(q + 3) as i32) == QUOT) { // "" -> one quote
        segPush(segStart, q - segStart);
        scrPush2(BS, QUOT);
        sp = q + 4;
        segStart = sp;
        continue;
      }
      segPush(segStart, q - segStart);
      sp = q + 2;
      closed = true;
      break;
    }
    if (L == 0x72) { // CR inside quotes reads as LF
      segPush(segStart, q - segStart);
      scrPush2(BS, 0x6e);
      physLine++;
      if (q + 3 < spanEnd && (load<u8>(q + 2) as i32) == BS &&
        (load<u8>(q + 3) as i32) == 0x6e) sp = q + 4;
      else sp = q + 2;
      segStart = sp;
      continue;
    }
    if (L == 0x6e) { // LF inside quotes
      physLine++;
      sp = q + 2;
      continue;
    }
    sp = q + (L == 0x75 ? 6 : 2);
  }
  // junk: appended as it stands up to the next comma or line break,
  // except stray CRs, which are dropped with an error each.
  let junkStart = sp;
  let junkAny = false;
  while (true) {
    if (sp >= spanEnd) {
      segPush(junkStart, sp - junkStart);
      fTerm = T_EOF;
      break;
    }
    const v = lbAt(sp);
    const l = lbLen(sp);
    if (v == COMMA) {
      segPush(junkStart, sp - junkStart);
      sp += l;
      fTerm = T_COMMA;
      break;
    }
    if (v == 0x0a) {
      segPush(junkStart, sp - junkStart);
      sp += l;
      physLine++;
      fTerm = T_EOL;
      break;
    }
    if (v == 0x0d) {
      const q2 = sp + l;
      if (q2 < spanEnd && lbAt(q2) == 0x0a) {
        segPush(junkStart, sp - junkStart);
        sp = q2 + lbLen(q2);
        physLine++;
        fTerm = T_EOL;
        break;
      }
      pushErr(E_STRAY, recStartLine, rowCur(), 0);
      segPush(junkStart, sp - junkStart);
      sp += l;
      junkStart = sp;
      continue;
    }
    junkAny = true;
    sp += l;
  }
  if (junkAny) pushErr(E_JUNK, recStartLine, rowCur(), 0);
  fHad = true;
}

function parseField(): void {
  fSegStart = segCnt;
  fHad = false;
  if (sp < spanEnd && lbAt(sp) == QUOT) parseQuoted();
  else parseUnquoted();
  fSegCnt = segCnt - fSegStart;
  store<i32>(fldOff + 8 * fldCnt, fSegStart);
  store<i32>(fldOff + 8 * fldCnt + 4, fSegCnt);
  fldCnt++;
}

function emitField(fi: i32): void {
  const si = load<i32>(fldOff + 8 * fi);
  const n = load<i32>(fldOff + 8 * fi + 4);
  emitB(QUOT);
  for (let j = 0; j < n; j++) {
    emitBytes(load<i32>(segOff + 8 * (si + j)), load<i32>(segOff + 8 * (si + j) + 4));
  }
  emitB(QUOT);
}

// Emit one completed record's row (fields 0..nEmit-1 plus padding).
function emitRow(nEmit: i32, padTo: i32): void {
  if (rowsOut > 0) emitB(COMMA);
  emitB(0x5b); // [
  for (let i = 0; i < nEmit; i++) {
    if (i > 0) emitB(COMMA);
    emitField(i);
  }
  for (let i = nEmit; i < padTo; i++) {
    if (i > 0) emitB(COMMA);
    emitB(QUOT);
    emitB(QUOT);
  }
  emitB(0x5d); // ]
  rowsOut++;
}

// Assemble fields [from, fldCnt) into an extras blob in the case region;
// returns the blob offset for the long_row descriptor.
function buildExtras(from: i32): i32 {
  const at = extPtr;
  store<i32>(extPtr, fldCnt - from);
  extPtr += 4;
  for (let i = from; i < fldCnt; i++) {
    const si = load<i32>(fldOff + 8 * i);
    const n = load<i32>(fldOff + 8 * i + 4);
    let len = 0;
    for (let j = 0; j < n; j++) len += load<i32>(segOff + 8 * (si + j) + 4);
    store<i32>(extPtr, len);
    extPtr += 4;
    for (let j = 0; j < n; j++) {
      const p = load<i32>(segOff + 8 * (si + j));
      const l = load<i32>(segOff + 8 * (si + j) + 4);
      memory.copy(extPtr, p, l);
      extPtr += l;
    }
  }
  if (extPtr - extOff > statExtHW) statExtHW = extPtr - extOff;
  return at;
}

// Parse one record (or one discarded line). Returns true when the span is
// exhausted (the record or line ended at EOF).
function parseRecord(): bool {
  segCnt = 0;
  fldCnt = 0;
  scrPtr = scrOff;
  begun = false;
  recStartLine = physLine;
  let term = T_EOF;
  while (true) {
    parseField();
    if (fHad) begun = true;
    term = fTerm;
    if (term == T_COMMA) {
      begun = true;
      continue;
    }
    break;
  }
  if (!begun) return term == T_EOF; // a line left with no characters
  const row = rowCur();
  if (recordsDone == 0) {
    width = fldCnt;
    if (headerMode) {
      // the first record is the columns array, emitted in place
      emitB(0x5b);
      for (let i = 0; i < fldCnt; i++) {
        if (i > 0) emitB(COMMA);
        emitField(i);
      }
      emitB(0x5d);
      emitStr(',"rows":[');
      rowsOpen = true;
    } else {
      emitRow(fldCnt, fldCnt);
    }
  } else if (fldCnt < width) {
    emitRow(fldCnt, width);
    pushErr(E_SHORT, recStartLine, row, fldCnt);
  } else if (fldCnt > width) {
    const blob = buildExtras(width);
    emitRow(width, width);
    pushErr(E_LONG, recStartLine, row, blob);
  } else {
    emitRow(fldCnt, fldCnt);
  }
  recordsDone++;
  return term == T_EOF;
}

function emitExtras(at: i32): void {
  emitB(0x5b); // [
  const n = load<i32>(at);
  let q = at + 4;
  for (let i = 0; i < n; i++) {
    if (i > 0) emitB(COMMA);
    const len = load<i32>(q);
    q += 4;
    emitB(QUOT);
    emitBytes(q, len);
    emitB(QUOT);
    q += len;
  }
  emitB(0x5d); // ]
}

function emitErrors(): void {
  for (let i = 0; i < errCnt; i++) {
    if (i > 0) emitB(COMMA);
    const d = errOff + 16 * i;
    const code = load<i32>(d);
    const line = load<i32>(d + 4);
    const row = load<i32>(d + 8);
    const aux = load<i32>(d + 12);
    emitStr('{"code":"');
    if (code == E_STRAY) emitStr('stray_cr');
    else if (code == E_JUNK) emitStr('quote_junk');
    else if (code == E_UNTERM) emitStr('unterminated_quote');
    else if (code == E_SHORT) emitStr('short_row');
    else emitStr('long_row');
    emitStr('","line":');
    emitNum(line);
    emitStr(',"row":');
    if (row < 0) emitStr('null');
    else emitNum(row);
    if (code == E_SHORT) {
      emitStr(',"fields":');
      emitNum(aux);
    } else if (code == E_LONG) {
      emitStr(',"extra":');
      emitExtras(aux);
    }
    emitB(0x7d); // }
  }
}

function processCase(): void {
  errCnt = 0;
  extPtr = extOff;
  let srcS = caseTs;
  let srcE = caseTe;
  if (caseFallback) {
    const n = reEncode(caseTs, caseTe);
    srcS = rebOff;
    srcE = rebOff + n;
    statFbCases++;
    statFbBytes += caseTe - caseTs;
  }
  // a U+FEFF at the very start of the text is dropped (raw UTF-8 here:
  // the re-encoder spells it raw too, so one check covers both paths)
  if (srcE - srcS >= 3 && (load<u8>(srcS) as i32) == 0xef &&
    (load<u8>(srcS + 1) as i32) == 0xbb && (load<u8>(srcS + 2) as i32) == 0xbf) {
    srcS += 3;
  }
  sp = srcS;
  spanEnd = srcE;
  physLine = 1;
  width = -1;
  recordsDone = 0;
  rowsOut = 0;
  rowsOpen = false;
  headerMode = caseHeader;
  emitStr('{"columns":');
  if (!headerMode) {
    emitStr('null');
    emitStr(',"rows":[');
    rowsOpen = true;
  }
  if (mode != 1) {
    let done = false;
    while (!done) done = parseRecord();
  }
  if (!rowsOpen) {
    emitStr('[]');
    emitStr(',"rows":[');
    rowsOpen = true;
  }
  emitB(0x5d); // ] of rows
  emitStr(',"errors":[');
  if (mode != 1) emitErrors();
  emitStr(']}');
}

// --------------------------------------------------------------------- main
export function process(len: i32): i32 {
  statFbCases = 0;
  statFbBytes = 0;
  tableCnt = 0;
  maxSpan = 0;
  // Pass 1 — measure: walk the cases, record each span in the table.
  wp = IN_OFF;
  if (inEnd - wp >= 3 && (load<u8>(wp) as i32) == 0xef &&
    (load<u8>(wp + 1) as i32) == 0xbb && (load<u8>(wp + 2) as i32) == 0xbf) {
    wp += 3;
  }
  skipWs();
  if (wp < inEnd && (load<u8>(wp) as i32) == 0x5b) wp++; // [
  while (true) {
    skipWs();
    if (wp >= inEnd || (load<u8>(wp) as i32) == 0x5d) break;
    parseCaseObj();
    const ent = tableOff + (tableCnt << 4);
    store<i32>(ent, caseTs);
    store<i32>(ent + 4, caseTe);
    store<i32>(ent + 8, caseFallback ? 1 : 0);
    store<i32>(ent + 12, caseHeader ? 1 : 0);
    tableCnt++;
    const span = caseTe - caseTs;
    if (span > maxSpan) maxSpan = span;
    skipWs();
    if (wp < inEnd && (load<u8>(wp) as i32) == COMMA) {
      wp++;
      continue;
    }
    break;
  }
  if (mode == 1) return 0; // walk-only bench mode
  // Pass 2 — size the arenas from the largest span, then process each case.
  finalizeLayout();
  emitB(0x5b);
  for (let i = 0; i < tableCnt; i++) {
    const ent = tableOff + (i << 4);
    caseTs = load<i32>(ent);
    caseTe = load<i32>(ent + 4);
    caseFallback = load<i32>(ent + 8) != 0;
    caseHeader = load<i32>(ent + 12) != 0;
    if (i > 0) emitB(COMMA);
    processCase();
  }
  emitB(0x5d);
  return outPtr - outOff;
}
