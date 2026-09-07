// lz.js
//
// RicDOM v1 の `scripts/lz.js` (v0.3.20 で公開) から 2026-09-07 に MIT で
// 独立リポジトリ `ricdom-lz` として切り出したもの。v1 側のコピーは PolyForm
// のまま (デュアルライセンス)。本リポジトリはこのファイルを MIT で再許諾する。
// アルゴリズム・出力形式は切り出し時点から 1 byte も変更していない
// (v1 の `*.lz.min.js` と互換であることが本ツールの価値のため)。
//
// LZSS 圧縮 + 自己展開 wrapper 生成の純粋関数モジュール。
// `bin/ricdom-lz.js` (CLI) と `tests/lz_algorithm.test.js` (単体テスト) が
// require する。
//
// 圧縮の仕組み:
//   1. ソース内で **一度も使われていない printable ASCII char** を marker として選ぶ
//      (典型は '~' = 0x7E)。すべて使われていれば、頻度最小の printable を
//      未使用 binary byte に置換、その printable を marker にする
//      (展開時に escape byte → 元 printable に戻す)。
//   2. LZSS: 各位置で過去 WINDOW byte 内の最長一致 (≥ MIN_MATCH) を hash table で
//      探索、`marker(1) + base64(4)` = 5 byte 参照に置換。
//   3. base64 の 3 byte = offset(2B big-endian) + length(1B)。
//      encoding 上限は offset=65535 / length=255 だが、実運用の WINDOW=4096 で
//      offset は実質 12-bit、length は 8-bit 全域使用。
//
// なぜ base64 か:
//   raw binary バイトを JS string literal に埋め込むと、
//     - CR (0x0D) が JS source 正規化で LF に化けて破損する
//     - 0x80-0xFF が UTF-8 で 2 byte に膨らむ
//     - `、\、${、改行が escape 必要
//   base64 alphabet (A-Z a-z 0-9 + /) は safe printable ASCII で、
//   4 chars 固定 = 5 byte 参照を確実に表現できる。

'use strict';

const WINDOW            = 4096;
const MIN_MATCH         = 6;    // 5 byte 参照を上回る一致長 (= 利益最低 1 byte)
const MAX_MATCH         = 255;  // length は 1 byte
const MAX_CHAIN_PROBES  = 64;   // hash chain 探索の打ち切り (= compile 速度と圧縮率の trade-off)

// ──────────────────────────────────────────────
// marker char を選ぶ
// ──────────────────────────────────────────────
const find_marker = (src) => {
  const used = new Uint8Array(128);
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c < 128) used[c] = 1;
  }
  // 未使用 printable ASCII (0x21-0x7E) を優先
  for (let c = 0x21; c <= 0x7E; c++) {
    if (!used[c]) {
      return { marker_code: c, substitution: null };
    }
  }
  // 全 printable が使われている場合: 頻度最小の printable を未使用 binary byte に置換し、
  // その printable を marker にする (decompress 時に escape byte → printable に戻す)
  const freq = new Array(128).fill(0);
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c >= 0x21 && c <= 0x7E) freq[c]++;
  }
  // 未使用 binary byte (制御文字 0x01-0x08 / 0x0E-0x1F、改行系は避ける)
  let escape_code = -1;
  for (let c = 0x01; c <= 0x1F; c++) {
    if (c === 0x09 || c === 0x0A || c === 0x0B || c === 0x0C || c === 0x0D) continue;
    if (!used[c]) { escape_code = c; break; }
  }
  if (escape_code < 0) throw new Error('No available escape byte');
  // 最少頻度の printable を選ぶ
  let min_c = 0x21, min_freq = freq[0x21];
  for (let c = 0x22; c <= 0x7E; c++) {
    if (freq[c] < min_freq) { min_c = c; min_freq = freq[c]; }
  }
  return {
    marker_code: min_c,
    substitution: { from_code: min_c, to_code: escape_code },
  };
};

// ──────────────────────────────────────────────
// LZSS 圧縮
// ──────────────────────────────────────────────
// 注意: src に marker_code が含まれていてはならない (= caller が find_marker と
// substitution で事前に保証する)。compress 自体は assert しない。

// 参照 1 件 (= 3 byte: offset_hi / offset_lo / length) を base64 4 char に変換。
// 3 → 4 は base64 の padding 不要な唯一の境界、参照 1 件 = 5 source char に固定される。
const encode_ref = (offset, length) => Buffer.from([
  (offset >>> 8) & 0xFF,
  offset & 0xFF,
  length & 0xFF,
]).toString('base64');

const compress = (src, marker_code) => {
  const N = src.length;
  const MARKER = String.fromCharCode(marker_code);
  let out = '';
  if (N === 0) return out;

  // ハッシュテーブル: 3-byte 接頭辞 → 直近の出現位置
  const HSIZE = 1 << 12;
  const HMASK = HSIZE - 1;
  const head  = new Int32Array(HSIZE).fill(-1);
  const chain = new Int32Array(N).fill(-1);
  const hash3 = (a, b, c) => ((a * 31 + b) * 31 + c) & HMASK;

  let i = 0;
  while (i < N) {
    let best_len = 0;
    let best_off = 0;
    if (i + 2 < N) {
      const h = hash3(src.charCodeAt(i), src.charCodeAt(i + 1), src.charCodeAt(i + 2));
      let j = head[h];
      let probes = 0;
      while (j >= 0 && j > i - WINDOW && probes < MAX_CHAIN_PROBES) {
        probes++;
        let len = 0;
        const max = Math.min(MAX_MATCH, N - i, i - j);
        while (len < max && src.charCodeAt(j + len) === src.charCodeAt(i + len)) len++;
        if (len > best_len) { best_len = len; best_off = i - j; }
        if (best_len >= MAX_MATCH) break;
        j = chain[j];
      }
    }
    if (best_len >= MIN_MATCH) {
      out += MARKER + encode_ref(best_off, best_len);
      // overlapping match 用に一致部分のハッシュも更新
      for (let k = 0; k < best_len; k++) {
        if (i + k + 2 < N) {
          const h2 = hash3(src.charCodeAt(i + k), src.charCodeAt(i + k + 1), src.charCodeAt(i + k + 2));
          chain[i + k] = head[h2];
          head[h2] = i + k;
        }
      }
      i += best_len;
    } else {
      out += src[i];
      if (i + 2 < N) {
        const h2 = hash3(src.charCodeAt(i), src.charCodeAt(i + 1), src.charCodeAt(i + 2));
        chain[i] = head[h2];
        head[h2] = i;
      }
      i++;
    }
  }
  return out;
};

// ──────────────────────────────────────────────
// 展開 (Node 側 sanity check 用、wrapper の decompressor と等価ロジック)
// ──────────────────────────────────────────────
const decompress = (compressed, marker_code, substitution) => {
  let s = '';
  for (let i = 0; i < compressed.length; i++) {
    const c = compressed.charCodeAt(i);
    if (c === marker_code) {
      const r = Buffer.from(compressed.substring(i + 1, i + 5), 'base64');
      const offset = (r[0] << 8) | r[1];
      const length = r[2];
      const start = s.length - offset;
      for (let k = 0; k < length; k++) s += s[start + k];
      i += 4;
    } else if (substitution && c === substitution.to_code) {
      s += String.fromCharCode(substitution.from_code);
    } else {
      s += compressed[i];
    }
  }
  return s;
};

// ──────────────────────────────────────────────
// JS template literal 用 escape
// ──────────────────────────────────────────────
// 圧縮済みデータには base64 chars (safe ASCII) と marker と 元 src の literal char
// が混在。テンプレートリテラル構文と衝突する char を escape する:
//   \   (0x5C) → \\
//   `   (0x60) → \`
//   ${  (sequence)  → \${
//   CR  (0x0D) → \r  (CR は ECMAScript の source 正規化で LF に変換されるため、絶対に escape)
// LF (\n、0x0A) はテンプレートリテラル内で raw のまま保持される (正規化されない) のでそのまま。
const escape_for_template = (s) => {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if      (c === 0x5C) out += '\\\\';
    else if (c === 0x60) out += '\\`';
    else if (c === 0x0D) out += '\\r';
    else if (c === 0x24 && s.charCodeAt(i + 1) === 0x7B) out += '\\$';
    else out += s[i];
  }
  return out;
};

// regex 内で meta chars を escape
const escape_regex_char = (c) => /[.*+?^${}()|[\]\\\/]/.test(c) ? '\\' + c : c;

// ──────────────────────────────────────────────
// 自己展開 wrapper の組み立て (golf-level minified)
// ──────────────────────────────────────────────
// 構造:
//   (()=>{
//     let C=`...payload...`, s="", r, G=n=>r.charCodeAt(n);
//     C.replace(/M(....)|./gs, (m, R) => {
//       if (R) { r = atob(R); for (let l=G(2), b=s.length-G(0)*256-G(1); l--;) s += s[b++] }
//       else s += m
//     });
//     eval(s)
//   })()
//
// IIFE で包む理由 (v0.3.19〜): top-level `let C` は classic <script> の script-level
// lexical binding を作るため、複数の LZ 出力ファイルを同じページに読み込むと
// 「Identifier 'C' has already been declared」で 2 つ目が SyntaxError に
// なる (RicDOM v1 の Potopeta dev 報告が起点)。IIFE で function scope に閉じ込めることで
// 複数 .lz ファイルが共存できる (+7 byte/file)。
//
// substitution 版は escape char → rare char の復元を 1 alternative 追加。
const build_wrapper = (compressed, marker_code, substitution) => {
  const escaped = escape_for_template(compressed);
  const M = escape_regex_char(String.fromCharCode(marker_code));
  const body = substitution
    ? (() => {
        // 展開時は: match が escape byte なら rare char に戻す、それ以外 (普通の literal)
        // はそのまま append。regex は `/M(....)|./gs` で十分 (escape byte は `.` でマッチ
        // するので alternative 不要)。
        const escape_lit = '"\\x' + substitution.to_code.toString(16).padStart(2, '0') + '"';
        const rare_lit = JSON.stringify(String.fromCharCode(substitution.from_code));
        return 'let C=`' + escaped + '`,s="",r,G=n=>r.charCodeAt(n);' +
          'C.replace(/' + M + '(....)|./gs,(m,R)=>{' +
          'if(R){r=atob(R);for(let l=G(2),b=s.length-G(0)*256-G(1);l--;)s+=s[b++]}' +
          'else if(m==' + escape_lit + ')s+=' + rare_lit + ';' +
          'else s+=m});eval(s)';
      })()
    : 'let C=`' + escaped + '`,s="",r,G=n=>r.charCodeAt(n);' +
      'C.replace(/' + M + '(....)|./gs,(m,R)=>{' +
      'if(R){r=atob(R);for(let l=G(2),b=s.length-G(0)*256-G(1);l--;)s+=s[b++]}' +
      'else s+=m});eval(s)';
  return '(()=>{' + body + '})()';
};

// ──────────────────────────────────────────────
// 高レベル API: 元文字列 → 自己展開 JS wrapper まで一括
// ──────────────────────────────────────────────
// 内部で round-trip を検証 (decompress 結果が元と一致するか) し、不一致なら
// 詳細を含む Error を throw する。
// ※ 同名の bin/ricdom-lz.js はこの関数を呼ぶ CLI (別ファイル)。
const build_lz_bundle = (original) => {
  const { marker_code, substitution } = find_marker(original);
  let src = original;
  if (substitution) {
    src = src.split(String.fromCharCode(substitution.from_code))
             .join(String.fromCharCode(substitution.to_code));
  }
  const compressed = compress(src, marker_code);
  // sanity check
  const decompressed = decompress(compressed, marker_code, substitution);
  if (decompressed !== original) {
    let at = -1;
    for (let i = 0; i < Math.min(decompressed.length, original.length); i++) {
      if (decompressed[i] !== original[i]) { at = i; break; }
    }
    const err = new Error('LZ round-trip mismatch at index ' + at);
    err.detail = {
      at,
      expected: original.substring(Math.max(0, at - 10), at + 30),
      got: decompressed.substring(Math.max(0, at - 10), at + 30),
    };
    throw err;
  }
  const wrapper = build_wrapper(compressed, marker_code, substitution);
  return { wrapper, marker_code, substitution, compressed_length: compressed.length };
};

// ──────────────────────────────────────────────
// Public API (external consumers): 入力 string → 自己展開 wrapper string
// ──────────────────────────────────────────────
// 「自分の app.js を RicDOM 由来の LZ 流儀 (LZSS + base64 + 自己展開 IIFE) で
// 圧縮したい」場合のシンプル API。build_lz_bundle がフル詳細を返すのに対し、
// lz_compress は wrapper 文字列だけを返す。中で round-trip 検証も行われる。
//
// 使い方:
//   const { lz_compress } = require('ricdom-lz');
//   const wrapper = lz_compress(fs.readFileSync('app.min.js', 'utf8'));
//   fs.writeFileSync('app.lz.min.js', wrapper);
const lz_compress = (source) => build_lz_bundle(source).wrapper;

module.exports = {
  // 高レベル API (external consumers 向け)
  lz_compress,
  build_lz_bundle,

  // 低レベル API (テストが直接触る)
  // 注: encode_ref は private 実装詳細 (= build_lz_bundle の round-trip 経由で
  // 間接的に検証される)。MAX_CHAIN_PROBES も internal tuning なので非公開。
  WINDOW, MIN_MATCH, MAX_MATCH,
  find_marker,
  compress,
  decompress,
  escape_for_template,
  escape_regex_char,
  build_wrapper,
};
