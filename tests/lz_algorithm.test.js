// LZ 圧縮アルゴリズム本体の単体テスト
//
// RicDOM v1 の tests/v03_lz_algorithm.test.js (v0.3.18〜) を 2026-09-07 に
// 本リポジトリへ切り出したもの。require パスと CLI パスを新レイアウト
// (../lz.js, ../bin/ricdom-lz.js) に合わせて更新した以外は変更していない。
//
// 対象: ../lz.js の純粋関数 (find_marker / compress / decompress /
//   escape_for_template / build_wrapper / build_lz_bundle) と CLI (bin/ricdom-lz.js)。

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  find_marker,
  compress,
  decompress,
  escape_for_template,
  escape_regex_char,
  build_lz_bundle,
  lz_compress,
  MIN_MATCH,
} = require('../lz');

// ─────────────────────────────────────────────────────────────
// helper: round-trip を 1 行で検証
// ─────────────────────────────────────────────────────────────
const round_trip = (src) => {
  const { marker_code, substitution } = find_marker(src);
  let prepared = src;
  if (substitution) {
    prepared = prepared.split(String.fromCharCode(substitution.from_code))
                       .join(String.fromCharCode(substitution.to_code));
  }
  const compressed = compress(prepared, marker_code);
  const decompressed = decompress(compressed, marker_code, substitution);
  return { compressed, decompressed, marker_code, substitution };
};

// ─────────────────────────────────────────────────────────────
// find_marker
// ─────────────────────────────────────────────────────────────
describe('find_marker', () => {

  test('空文字列 → printable の先頭 (0x21 "!") が選ばれる', () => {
    const m = find_marker('');
    assert.equal(m.marker_code, 0x21);
    assert.equal(m.substitution, null);
  });

  test('未使用 printable がある場合は substitution なし', () => {
    const m = find_marker('Hello, World!');
    assert.ok(m.marker_code >= 0x21 && m.marker_code <= 0x7E,
      'marker は printable ASCII');
    assert.equal(m.substitution, null);
    // marker char が src に含まれていないことを確認
    assert.ok(!('Hello, World!'.includes(String.fromCharCode(m.marker_code))));
  });

  test('"~" を含まないソースでは "~" (0x7E) が選ばれることが多い (実装依存だが回帰防止)', () => {
    // 実装は 0x21 から走査するので、未使用の最初の char が選ばれる。
    // 典型的な ASCII ソース ("Hello, World!" など) では '!' か '"' あたりが選ばれる。
    // ここでは「printable で substitution なし」までを保証する。
    const m = find_marker('abc 123 def 456');
    assert.equal(m.substitution, null);
  });

  test('全 printable が使われている場合は substitution path に入る', () => {
    let src = '';
    for (let c = 0x21; c <= 0x7E; c++) src += String.fromCharCode(c);
    const m = find_marker(src);
    assert.ok(m.substitution, 'substitution mode が有効化されるべき');
    assert.equal(m.substitution.from_code, m.marker_code,
      'substitution の from は marker と同じ printable');
    assert.ok(m.substitution.to_code >= 0x01 && m.substitution.to_code <= 0x1F,
      'escape は制御 byte (0x01-0x1F)');
    assert.notEqual(m.substitution.to_code, 0x09);
    assert.notEqual(m.substitution.to_code, 0x0A);
    assert.notEqual(m.substitution.to_code, 0x0D);
  });

  test('substitution path で最少頻度の printable が marker に選ばれる', () => {
    // 全 printable を 5 回ずつ繰り返し、'!' だけ 1 回追加で頻度最少にする
    let src = '!';
    for (let c = 0x22; c <= 0x7E; c++) src += String.fromCharCode(c).repeat(5);
    for (let c = 0x21; c <= 0x7E; c++) src += String.fromCharCode(c).repeat(5);
    const m = find_marker(src);
    assert.ok(m.substitution);
    // '!' (0x21) が頻度 6 で、他より少なくはないので別の char が選ばれるかも。
    // 重要なのは「substitution が成立する」と「marker が printable」の 2 点。
    assert.ok(m.marker_code >= 0x21 && m.marker_code <= 0x7E);
  });
});

// ─────────────────────────────────────────────────────────────
// compress + decompress round-trip
// ─────────────────────────────────────────────────────────────
describe('compress + decompress: round-trip', () => {

  test('空文字列', () => {
    const r = round_trip('');
    assert.equal(r.compressed, '');
    assert.equal(r.decompressed, '');
  });

  test('1 文字', () => {
    const r = round_trip('A');
    assert.equal(r.decompressed, 'A');
  });

  test('MIN_MATCH 未満の短い文字列 (圧縮不可)', () => {
    const src = 'abc';
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
    // 短すぎて圧縮できない → 元と同サイズ以上
    assert.ok(r.compressed.length >= src.length,
      '短い文字列は参照化されない');
  });

  test('MIN_MATCH 丁度の長さの重複 (= ' + MIN_MATCH + ')', () => {
    const pat = 'abcdef'.substring(0, MIN_MATCH);
    const src = pat + 'XYZ' + pat;
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });

  test('高度に繰り返しのある文字列 (> 50% 圧縮)', () => {
    const src = 'abcdefghij'.repeat(100);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
    assert.ok(r.compressed.length < src.length / 2,
      `期待: < ${src.length / 2}, 実測: ${r.compressed.length}`);
  });

  test('overlapping match (run-length 的パターン)', () => {
    // "ababab..." は offset=2, length=large の overlap 参照で表現される
    const src = 'ab'.repeat(100);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });

  test('同一文字の長い run (RLE 風)', () => {
    const src = 'X'.repeat(300);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
    // MAX_MATCH (255) を超えるので 2 参照に分割されるはず
    assert.ok(r.compressed.length < src.length);
  });

  test('marker char を含まない多様な ASCII', () => {
    const src = 'function foo(x) { return x * 2 + 1; } '.repeat(20);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });

  test('テンプレートリテラル sensitive な char (\\ ` $ {)', () => {
    const src = '`backtick` and \\\\ and ${interp} and `${nested}` x'.repeat(10);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });

  test('改行と CR を含むソース', () => {
    const src = 'line1\nline2\r\nline3\nline4'.repeat(20);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });

  test('NULL byte を含むソース', () => {
    const src = 'a\x00b\x00c'.repeat(20);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });

  test('全 printable + 繰り返し (substitution path 経由)', () => {
    let head = '';
    for (let c = 0x21; c <= 0x7E; c++) head += String.fromCharCode(c);
    const src = head + 'XYZXYZXYZXYZXYZXYZ'.repeat(20);
    const r = round_trip(src);
    assert.ok(r.substitution, 'substitution path に入っているべき');
    assert.equal(r.decompressed, src);
  });

  test('長い run + 文字 mixed (overlap で MAX_MATCH 超え)', () => {
    const src = 'A'.repeat(500) + 'B'.repeat(500) + 'A'.repeat(500);
    const r = round_trip(src);
    assert.equal(r.decompressed, src);
  });
});

// ─────────────────────────────────────────────────────────────
// escape_for_template
// ─────────────────────────────────────────────────────────────
describe('escape_for_template', () => {

  test('バックスラッシュを \\\\ にエスケープ', () => {
    assert.equal(escape_for_template('a\\b'), 'a\\\\b');
  });

  test('バッククォートを \\` にエスケープ', () => {
    assert.equal(escape_for_template('a`b'), 'a\\`b');
  });

  test('${ を \\${ にエスケープ', () => {
    assert.equal(escape_for_template('a${b}c'), 'a\\${b}c');
  });

  test('$ 単体 ($ の後に { が来ない) はエスケープしない', () => {
    assert.equal(escape_for_template('a$b'), 'a$b');
    assert.equal(escape_for_template('$'), '$');
  });

  test('CR (0x0D) を \\r にエスケープ (= 構造バグの回帰防止)', () => {
    // CR を raw のまま template literal に入れると ECMAScript の source
    // 正規化で LF に変換されて payload が破損する。escape は必須。
    assert.equal(escape_for_template('a\rb'), 'a\\rb');
    assert.equal(escape_for_template('\r\r'), '\\r\\r');
  });

  test('LF (0x0A) はそのまま (template literal で正規化されない)', () => {
    // LF は escape 不要。raw のまま source に書ける、runtime も LF のまま。
    assert.equal(escape_for_template('a\nb'), 'a\nb');
  });

  test('組み合わせ', () => {
    assert.equal(escape_for_template('`\\${'), '\\`\\\\\\${');
  });

  test('通常 ASCII は変化なし', () => {
    const src = 'function() { return 42; }';
    assert.equal(escape_for_template(src), src);
  });
});

// ─────────────────────────────────────────────────────────────
// escape_regex_char
// ─────────────────────────────────────────────────────────────
describe('escape_regex_char', () => {

  test('regex meta char を \\ で escape', () => {
    for (const c of '.*+?^${}()|[]\\/') {
      assert.equal(escape_regex_char(c), '\\' + c, `meta char ${JSON.stringify(c)}`);
    }
  });

  test('通常 char はそのまま', () => {
    for (const c of '~!@#abcXYZ123') {
      assert.equal(escape_regex_char(c), c);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// build_wrapper: 生成された JS を実行して decompress 結果を捕捉
// ─────────────────────────────────────────────────────────────
//
// build_wrapper の出力は `let C=`...`; ...; eval(s)` の形。
// テストでは末尾の `eval(s)` を `globalThis.__lz_captured=s` に置換し、
// 直接 eval して s を捕捉する。これで「wrapper の中身が valid JS で、
// かつ展開ロジックが正しく元の文字列を復元する」ことを担保する。

describe('build_wrapper: 出力 JS を eval して動作確認', () => {

  const eval_capture = (wrapper) => {
    const captured_key = '__lz_test_capture_' + Math.random().toString(36).slice(2);
    const modified = wrapper.replace('eval(s)', `globalThis['${captured_key}']=s`);
    delete globalThis[captured_key];
    (0, eval)(modified);  // indirect eval = global scope; let が漏れないよう wrap
    const result = globalThis[captured_key];
    delete globalThis[captured_key];
    return result;
  };

  test('simple ASCII payload を round-trip', () => {
    const original = 'console.log("hello");'.repeat(20);
    const { wrapper } = build_lz_bundle(original);
    assert.equal(eval_capture(wrapper), original);
  });

  test('JS の bundle 風 (function / var / 多様な記号)', () => {
    const original =
      '"use strict";(()=>{var a={x:1,y:2,z:3};function f(){return a.x+a.y+a.z}return f()})()'
      .repeat(10);
    const { wrapper } = build_lz_bundle(original);
    assert.equal(eval_capture(wrapper), original);
  });

  test('テンプレートリテラル / バックスラッシュ含み', () => {
    const original = 'const s = `hello ${name}`; const path = "C:\\\\Users";'.repeat(10);
    const { wrapper } = build_lz_bundle(original);
    assert.equal(eval_capture(wrapper), original);
  });

  test('改行と CR を含む payload', () => {
    const original = 'line1\nline2\r\nline3\n'.repeat(30);
    const { wrapper } = build_lz_bundle(original);
    assert.equal(eval_capture(wrapper), original);
  });

  test('substitution path 経由でも eval 結果が原文と一致', () => {
    let head = '';
    for (let c = 0x21; c <= 0x7E; c++) head += String.fromCharCode(c);
    const original = head + 'console.log(42);'.repeat(20);
    const { wrapper, substitution } = build_lz_bundle(original);
    assert.ok(substitution, 'substitution が発動するべき');
    assert.equal(eval_capture(wrapper), original);
  });
});

// ─────────────────────────────────────────────────────────────
// build_lz_bundle: 高レベル API + 内部 round-trip 検証
// ─────────────────────────────────────────────────────────────
describe('build_lz_bundle', () => {

  test('正常系: wrapper / marker_code / substitution / compressed_length を返す', () => {
    const r = build_lz_bundle('test source ' + 'ABC'.repeat(50));
    assert.equal(typeof r.wrapper, 'string');
    assert.ok(r.wrapper.length > 0);
    assert.equal(typeof r.marker_code, 'number');
    assert.ok('substitution' in r);
    assert.equal(typeof r.compressed_length, 'number');
  });

  test('圧縮効果: 高繰り返しソースでは wrapper が元より小さい', () => {
    const original = 'console.log("hello world");'.repeat(200);
    const r = build_lz_bundle(original);
    assert.ok(r.wrapper.length < original.length,
      `wrapper ${r.wrapper.length} < original ${original.length}`);
  });

  test('短すぎるソースでは wrapper の方が大きい (overhead 込み)', () => {
    const original = 'short';
    const r = build_lz_bundle(original);
    // ~160 byte の stub overhead があるので、5 byte ソースは確実に膨らむ
    assert.ok(r.wrapper.length > original.length);
  });
});

// ─────────────────────────────────────────────────────────────
// 2 つの wrapper が同一 global scope で共存できること
// ─────────────────────────────────────────────────────────────
//
// RicDOM v1 の v0.3.18 でリリースした LZ wrapper は top-level `let C=...` を
// 持っており、複数の LZ 出力ファイルを同じ <script> 経由で読むと
// "Identifier 'C' has already been declared" で 2 つ目が SyntaxError になって
// いた (Potopeta dev 報告)。v0.3.19 で wrapper を IIFE で包み、`let C` を
// function scope に閉じ込めて回避。本テストは regression 防止のためのもの。

describe('build_wrapper: 複数 wrapper の共存 (regression for let-C 衝突)', () => {

  test('2 つの wrapper を indirect eval で順次実行しても SyntaxError にならない', () => {
    const w1 = build_lz_bundle('globalThis.__lz_dual_1=1;'.repeat(20)).wrapper;
    const w2 = build_lz_bundle('globalThis.__lz_dual_2=2;'.repeat(20)).wrapper;
    delete globalThis.__lz_dual_1;
    delete globalThis.__lz_dual_2;
    // indirect eval で 2 つの「<script>」を順次 load する状況を再現
    // (script-level lexical binding を共有する worst case)
    (0, eval)(w1);
    (0, eval)(w2);
    assert.equal(globalThis.__lz_dual_1, 1, '1 つ目の bundle が実行された');
    assert.equal(globalThis.__lz_dual_2, 2, '2 つ目の bundle も SyntaxError なく実行された');
    delete globalThis.__lz_dual_1;
    delete globalThis.__lz_dual_2;
  });

  test('同じ wrapper を 2 回 load しても SyntaxError にならない', () => {
    const w = build_lz_bundle('globalThis.__lz_twice=(globalThis.__lz_twice||0)+1;').wrapper;
    delete globalThis.__lz_twice;
    (0, eval)(w);
    (0, eval)(w);
    assert.equal(globalThis.__lz_twice, 2, '2 回読み込まれて counter が +2 になっている');
    delete globalThis.__lz_twice;
  });

  test('wrapper が IIFE で包まれていること (構造 sanity)', () => {
    const w = build_lz_bundle('let x=1;').wrapper;
    assert.ok(w.startsWith('(()=>{') || w.startsWith('(function'),
      'wrapper は IIFE で開始する (top-level let を function scope に閉じ込めるため)');
    assert.ok(w.endsWith('})()'), 'wrapper は IIFE 呼び出しで終わる');
  });
});

// ─────────────────────────────────────────────────────────────
// Public API: lz_compress (外部 consumer 向け簡易 API)
// ─────────────────────────────────────────────────────────────
//
// 「自分の app.js を RicDOM 由来の LZ 流儀で圧縮したい」場合の simple API。
// `build_lz_bundle` がフル詳細 (marker_code / substitution / compressed_length)
// を返すのに対し、`lz_compress` は wrapper 文字列だけを返す。

describe('lz_compress: 外部 consumer 向け simple API', () => {

  test('文字列を受け取って wrapper 文字列を返す', () => {
    const src = 'console.log("hello");'.repeat(20);
    const wrapper = lz_compress(src);
    assert.equal(typeof wrapper, 'string');
    assert.ok(wrapper.length > 0);
    assert.ok(wrapper.startsWith('(()=>{') && wrapper.endsWith('})()'));
  });

  test('build_lz_bundle(...).wrapper と同一の出力', () => {
    const src = 'function f(){return 42}'.repeat(20);
    assert.equal(lz_compress(src), build_lz_bundle(src).wrapper);
  });

  test('eval した結果が原文と一致 (外部 consumer の典型 use case)', () => {
    // 外部 consumer の use case シミュレーション:
    // app.js を esbuild minify → lz_compress → <script> で読み込み
    const app_minified = 'globalThis.myApp={start(){return 1+1}};'.repeat(10);
    const wrapper = lz_compress(app_minified);
    // wrapper を eval すると globalThis.myApp が設定される
    delete globalThis.myApp;
    (0, eval)(wrapper);
    assert.ok(globalThis.myApp);
    assert.equal(globalThis.myApp.start(), 2);
    delete globalThis.myApp;
  });

  test('短すぎる入力でも例外を投げない', () => {
    assert.doesNotThrow(() => lz_compress(''));
    assert.doesNotThrow(() => lz_compress('x'));
    assert.doesNotThrow(() => lz_compress('abc'));
  });
});

// ─────────────────────────────────────────────────────────────
// CLI (bin/ricdom-lz.js) の動作確認
// ─────────────────────────────────────────────────────────────
//
// npm bin `ricdom-lz` として提供する CLI。Unix-style で stdin/stdout、
// または file 引数を受け取る。ログは stderr に分離されていることを
// 確認する (stdout 出力をパイプ汚染しない)。

describe('CLI: bin/ricdom-lz.js', () => {
  const path = require('node:path');
  const { spawnSync } = require('node:child_process');
  const fs_t = require('node:fs');
  const os_t = require('node:os');

  const CLI = path.join(__dirname, '..', 'bin', 'ricdom-lz.js');

  test('stdin → stdout: pipe-style 使用', () => {
    const src = 'globalThis.__cli_test_1=42;'.repeat(20);
    const r = spawnSync(process.execPath, [CLI], {
      input: src, encoding: 'utf8',
    });
    assert.equal(r.status, 0, 'exit 0');
    assert.ok(r.stdout.length > 0, 'stdout に wrapper が出る');
    // stdout を eval すると globalThis に副作用
    delete globalThis.__cli_test_1;
    (0, eval)(r.stdout);
    assert.equal(globalThis.__cli_test_1, 42);
    delete globalThis.__cli_test_1;
    // ログは stderr
    assert.match(r.stderr, /\[build_lz\]/);
    assert.match(r.stderr, /marker:/);
  });

  test('INPUT file → stdout: 1 引数', () => {
    const tmp = path.join(os_t.tmpdir(), 'lz-cli-test-input-' + Date.now() + '.js');
    fs_t.writeFileSync(tmp, 'globalThis.__cli_test_2=43;'.repeat(20));
    try {
      const r = spawnSync(process.execPath, [CLI, tmp], { encoding: 'utf8' });
      assert.equal(r.status, 0);
      delete globalThis.__cli_test_2;
      (0, eval)(r.stdout);
      assert.equal(globalThis.__cli_test_2, 43);
      delete globalThis.__cli_test_2;
    } finally {
      fs_t.unlinkSync(tmp);
    }
  });

  test('INPUT file → OUTPUT file: 2 引数 (従来 build pipeline 互換)', () => {
    const tmp_in  = path.join(os_t.tmpdir(), 'lz-cli-test-2in-'  + Date.now() + '.js');
    const tmp_out = path.join(os_t.tmpdir(), 'lz-cli-test-2out-' + Date.now() + '.js');
    fs_t.writeFileSync(tmp_in, 'globalThis.__cli_test_3=44;'.repeat(20));
    try {
      const r = spawnSync(process.execPath, [CLI, tmp_in, tmp_out], { encoding: 'utf8' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '', 'stdout には何も書かれない (出力先がファイル)');
      const wrapper = fs_t.readFileSync(tmp_out, 'utf8');
      assert.ok(wrapper.startsWith('(()=>{'));
      delete globalThis.__cli_test_3;
      (0, eval)(wrapper);
      assert.equal(globalThis.__cli_test_3, 44);
      delete globalThis.__cli_test_3;
    } finally {
      fs_t.unlinkSync(tmp_in);
      if (fs_t.existsSync(tmp_out)) fs_t.unlinkSync(tmp_out);
    }
  });

  test('--help でヘルプを表示して exit 0', () => {
    const r = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(r.stderr, /Usage: ricdom-lz/);
  });
});
