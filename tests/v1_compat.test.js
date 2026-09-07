// v1 互換性の回帰テスト
//
// この切り出しの価値は「RicDOM v1 の *.lz.min.js と互換の出力を生成できること」
// にある。tests/fixtures/ には v1 リポジトリ (miyoshi-tec/RicDOM-v1、2026-09-07
// 時点の v0.4.5) の docs/RicDOM.min.js と、それを v1 の build_lz_bundle.js で
// 圧縮した docs/RicDOM.lz.min.js をそのままコピーして同梱している
// (v1 リポジトリは CI から到達できないため、フィクスチャとして固定した)。
//
// 本テストは「fixtures の RicDOM.min.js を本リポジトリの lz_compress に通すと、
// 同じく fixtures の RicDOM.lz.min.js と byte 一致する」ことを検証する。
// 一致しない場合はアルゴリズムか出力形式のどちらかが v1 から drift している。

'use strict';

const fs = require('fs');
const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { lz_compress } = require('../lz');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('v1 (RicDOM-v1) 互換性: byte-identical 出力', () => {

  test('RicDOM.min.js を圧縮すると v1 の RicDOM.lz.min.js と byte 一致する', () => {
    const input = fs.readFileSync(path.join(FIXTURES, 'RicDOM.min.js'), 'utf8');
    const expected = fs.readFileSync(path.join(FIXTURES, 'RicDOM.lz.min.js'), 'utf8');
    const actual = lz_compress(input);

    if (actual !== expected) {
      // 不一致の場合は先頭の差分位置を含めて詳細を報告する
      let at = -1;
      for (let i = 0; i < Math.min(actual.length, expected.length); i++) {
        if (actual[i] !== expected[i]) { at = i; break; }
      }
      assert.fail(
        `v1 の RicDOM.lz.min.js と byte 一致しない (差分位置: ${at}, ` +
        `actual.length=${actual.length}, expected.length=${expected.length})\n` +
        `  expected: ${JSON.stringify(expected.substring(Math.max(0, at - 20), at + 40))}\n` +
        `  actual:   ${JSON.stringify(actual.substring(Math.max(0, at - 20), at + 40))}`
      );
    }
    assert.equal(actual, expected);
  });
});
