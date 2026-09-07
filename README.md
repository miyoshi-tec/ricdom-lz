<title>ricdom-lz</title>

# ricdom-lz

An LZSS compressor and self-decompressing wrapper generator for JavaScript
bundles, for delivery environments where HTTP compression (gzip/brotli)
never runs — IoT devices, embedded targets, offline Electron distribution,
or internal servers without a CDN in front of them. Typical savings are in
the 27–43% range on top of plain minification, depending on how repetitive
the source is.

This is not a general-purpose compressor: it targets JS source text
specifically (its escaping rules assume a JS/template-literal payload) and
produces a self-contained `.lz.min.js` file — no separate runtime or loader
script is needed, the decompressor is embedded in every output file
(~160 bytes of overhead).

## Origin and license

This tool started life as `scripts/lz.js` inside RicDOM v1
(`miyoshi-tec/RicDOM-v1`), where it shipped from v0.3.20 onward as the
`ricdom-lz` CLI. On 2026-09-07 it was carved out into this standalone
repository and re-licensed under MIT — the copy inside RicDOM v1 remains
under RicDOM v1's own license (PolyForm Noncommercial / PolyForm Internal
Use). The algorithm and output format have not changed by even a single
byte in the carve-out: output from this package is byte-for-byte compatible
with RicDOM v1's `*.lz.min.js` files (see `tests/v1_compat.test.js`).

**There is no license restriction on the output.** A bundle you compress
with this tool (including the self-decompressing wrapper code it embeds)
carries no obligation back to this project — ship it under whatever terms
your own project already uses.

## Usage

### CLI (`ricdom-lz`)

Three invocation styles, Unix-style stdin/stdout:

```bash
# stdin → stdout (pipe)
$ cat src/app.min.js | npx ricdom-lz > dist/app.lz.min.js

# file → stdout
$ npx ricdom-lz src/app.min.js > dist/app.lz.min.js

# file → file
$ npx ricdom-lz src/app.min.js dist/app.lz.min.js

# help
$ npx ricdom-lz --help
```

Compression stats (ratio, marker byte used) are written to **stderr**, so
piping stdout never gets polluted with log output.

### Node API

```javascript
const { lz_compress } = require('ricdom-lz');
const fs = require('fs');

const minified = fs.readFileSync('src/app.min.js', 'utf8');
const wrapper  = lz_compress(minified);       // self-decompressing wrapper string
fs.writeFileSync('dist/app.lz.min.js', wrapper);
```

For more detail than just the wrapper string, use `build_lz_bundle(source)`,
which returns `{ wrapper, marker_code, substitution, compressed_length }`.

## Two things to know before using this

**1. CSP: self-decompression needs `eval`.**
The generated wrapper decompresses its payload at load time with
`atob(...)` and executes it via `eval`. If your delivery environment
enforces a Content-Security-Policy, `script-src` must include
`'unsafe-eval'`. If your CSP forbids `'unsafe-eval'` and you cannot change
that, do not use this tool — ship the plain, un-compressed bundle instead
(functionally identical, no `eval`).

**2. The payload must assign to `window`/`globalThis` explicitly.**
The wrapper's `eval` runs inside a function scope (an IIFE), not the top
level. That means a bare top-level `var X = ...` in your minified bundle
will **not** become a global — `eval`-in-a-function-scope does not leak
`var` declarations out to `globalThis` the way a real `<script>` tag would.
Your bundle must set the global explicitly, e.g. `window.X = ...` or
`globalThis.X = ...`, at its own top level (after your own IIFE/minifier
wrapping resolves, the *last* statement executed must be an explicit
assignment). A plain esbuild `--format=iife` bundle emitting `var X=...`
at its outer scope will **not** work through this tool as-is.

For example, [ricdom v2](https://github.com/miyoshi-tec/ricdom) has done
exactly this since `2.0.0-alpha.10` — its IIFE builds end with an explicit
assignment:

```js
// tail of dist/ricdom.iife.min.js
globalThis.ricdom=ricdom;
```

```js
// tail of dist/ricdom-ui.iife.min.js
globalThis.ricdomUI=ricdomUI;
```

So compressing an app that loads ricdom v2's two IIFE builds plus its own
app code works cleanly:

```bash
$ npx ricdom-lz dist/ricdom.iife.min.js    dist/ricdom.iife.lz.min.js
$ npx ricdom-lz dist/ricdom-ui.iife.min.js dist/ricdom-ui.iife.lz.min.js
$ npx ricdom-lz dist/app.min.js            dist/app.lz.min.js
```

```html
<script src="ricdom.iife.lz.min.js"></script>
<script src="ricdom-ui.iife.lz.min.js"></script>
<script src="app.lz.min.js"></script>
```

Each `.lz.min.js` file is self-contained (its own decompressor, own IIFE
scope), so multiple LZ-compressed files can be loaded on the same page
without colliding — this was itself a bug fixed upstream in RicDOM v1
v0.3.19 (see the comments in `lz.js` for the "two top-level `let C`"
collision it fixes).

## Development

```bash
npm test
```

`tests/v1_compat.test.js` is a byte-identity regression test: it compresses
a fixture copy of RicDOM v1's `docs/RicDOM.min.js` and checks the result is
byte-for-byte identical to RicDOM v1's own `docs/RicDOM.lz.min.js` (also
bundled as a fixture, since the v1 repository isn't reachable from CI).

---

## 日本語要約

`ricdom-lz` は、RicDOM v1 の LZ 自己展開ツール (`scripts/lz.js` + `ricdom-lz`
CLI、v0.3.20〜公開) を 2026-09-07 に MIT ライセンスの独立リポジトリとして
切り出したものです。アルゴリズム・出力形式は 1 byte も変えていないため、
v1 の `*.lz.min.js` と互換の出力が得られます (`tests/v1_compat.test.js` で
byte 一致を回帰テスト)。v1 側の同名ツールは引き続き RicDOM v1 のライセンス
(PolyForm デュアル) のままですが、こちらの MIT 版の**出力にライセンス上の
制約はありません**。

gzip/brotli が効かない配信環境 (IoT・組込み・オフライン Electron 配布・
社内サーバー等) 向けの LZSS 圧縮 + 自己展開 wrapper 生成ツールです。CLI
(`ricdom-lz`、stdin/stdout・ファイル引数どちらも対応) と Node API
(`lz_compress` / `build_lz_bundle`) を提供します。

**注意点 2 つ**: (1) 自己展開に `eval` を使うため、CSP 環境では
`script-src 'unsafe-eval'` が必要です。(2) wrapper は関数スコープ内で
`eval` するため、ペイロード側は `window.X = ...` / `globalThis.X = ...` の
ように **明示的に global を立てる**必要があります (esbuild の素の
`var X=...` は top-level に漏れないため立ちません)。ricdom v2 は
`2.0.0-alpha.10` から `globalThis.ricdom=ricdom;` のように明示代入済みです。
