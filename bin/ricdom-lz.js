#!/usr/bin/env node
// bin/ricdom-lz.js
//
// 任意の JS bundle を LZSS で圧縮し、自己展開する JS ファイルを生成する CLI。
// RicDOM v1 の `scripts/build_lz_bundle.js` (v0.3.20〜、npm bin 経由で外部
// consumer にも公開) を 2026-09-07 に本リポジトリへ切り出したもの。
// アルゴリズム本体は ../lz.js を参照。
//
// 使い方 (Unix-style):
//   ricdom-lz INPUT OUTPUT       # ファイル → ファイル
//   ricdom-lz INPUT              # ファイル → stdout (`> output.js` リダイレクト用)
//   ricdom-lz                    # stdin → stdout (パイプ用、`cat in.js | ricdom-lz > out.js`)
//   ricdom-lz -h / --help        # ヘルプ
//
// 注: ログ (圧縮率、marker 情報) は **stderr** に出る。stdout はピュアな圧縮出力。

'use strict';

const fs = require('fs');
const lz = require('../lz');

const args = process.argv.slice(2);

if (args.includes('-h') || args.includes('--help')) {
  process.stderr.write(
    'Usage: ricdom-lz [INPUT] [OUTPUT]\n' +
    '       ricdom-lz < input.js > output.js\n\n' +
    'LZSS-compress a JS bundle into a self-decompressing wrapper.\n' +
    'Reads from INPUT file (or stdin if omitted), writes to OUTPUT file\n' +
    '(or stdout if omitted). Compression stats are written to stderr.\n'
  );
  process.exit(0);
}

const read_input = () => {
  if (args[0] && args[0] !== '-') {
    return fs.readFileSync(args[0], 'utf8');
  }
  // stdin
  return fs.readFileSync(0, 'utf8');
};

const write_output = (s) => {
  if (args[1] && args[1] !== '-') {
    fs.writeFileSync(args[1], s);
  } else {
    process.stdout.write(s);
  }
};

const original = read_input();

let result;
try {
  result = lz.build_lz_bundle(original);
} catch (e) {
  process.stderr.write('[build_lz] ERROR: ' + e.message + '\n');
  if (e.detail) {
    process.stderr.write('  expected: ' + JSON.stringify(e.detail.expected) + '\n');
    process.stderr.write('  got:      ' + JSON.stringify(e.detail.got) + '\n');
  }
  process.exit(1);
}

write_output(result.wrapper);

// stats to stderr (so stdout-pipe usage isn't polluted)
const before = Buffer.byteLength(original, 'utf8');
const after  = Buffer.byteLength(result.wrapper, 'utf8');
const ratio  = (after / before * 100).toFixed(1);
const marker_char = String.fromCharCode(result.marker_code);
const label_in  = args[0] && args[0] !== '-' ? args[0] : '<stdin>';
const label_out = args[1] && args[1] !== '-' ? args[1] : '<stdout>';
process.stderr.write(
  `[build_lz] ${label_in} → ${label_out}: ${before} → ${after} (-${before - after}B, ${ratio}%)\n` +
  `  marker: '${marker_char}' (0x${result.marker_code.toString(16)})` +
  (result.substitution
    ? `, substituted '${String.fromCharCode(result.substitution.from_code)}' → 0x${result.substitution.to_code.toString(16)}\n`
    : ' (unused in source)\n')
);
