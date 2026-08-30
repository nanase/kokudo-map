# 配信アーキテクチャ

[開発](development.md) から辿る詳細文書です。`national-routes.pmtiles`・`national.meta.json`・`regions.json` をどう作り、どこに置くかをまとめます。

## 配信の形

全国のアークは 1 つの GeoJSON では配れません。閲覧側は特徴量を手元に持ちません。

| ファイル | 中身 |
| --- | --- |
| `web/data/national-routes.pmtiles` | 全国のベクタタイル。Range 要求で読む |
| `web/data/national.meta.json` | 画面が出す集計 |
| `web/data/regions.json` | 地域の一覧。`?region=` の初期表示に使う |

三つとも git では追跡しません。理由は二つあります。道路データは ODbL 1.0 で、MIT のコードと同じ木に置くと配布条件の違う二つを一度に配ることになります。それにタイルは既に gzip されていて圧縮も差分も効かないので、作り直すたびに同じ大きさの塊が履歴へ丸ごと積まれます。

clone した直後は次で作れます。

```sh
mise run pack
```

タイルは geojson-vt で切ります。MapLibre が GeoJSON ソースに使うのと同じ実装なので、描かれる形の求め方は以前と変わりません。tippecanoe には Windows 版が無く、これには不要です。

集計は指定の組み合わせごとに 1 行です。路線別の表では足りません。重用区間のアークは複数の路線に属するので、路線の行を足すと共有部分を二重に数えます。それは地図が隠すのをやめさせたい数そのものです。

次は 1 行の例です。フィールドの形を示すためのもので、値は [結果](results.md) に合わせてあります。

```json
{ "refs": [7, 8, 17, 49, 403, 459], "n": 6, "km": 4.17, "arcs": 18,
  "kinds": { "road": 4.17 }, "former_km": 0.03,
  "names": ["栗ノ木バイパス"], "bbox": [139.05, 37.90, 139.08, 37.93] }
```

路線一覧も、重用ランキングも、選択したときの延長も、この表の部分和です。数の出どころが一つなので、三つの数字が食い違うことがありません。

`kinds` はその延長の内訳です。0 の区分は書きません。`former_km` は旧道のぶんで、`kinds` とは別の軸です。旧道はどれかの区分の道でもあるので、足すと二重に数えます。

## コードとデータを分けて置く理由

コードは GitHub Pages に、配信データは Cloudflare R2(`data.nanase.cc`)に置きます。分けているのは選択ではなく回避です。GitHub Pages の裏側にいる Fastly は、ファイルの先頭(バイト 0)から始まらない Range 要求に対して、要求したファイルと無関係なバイト列を返す不具合を抱えています。PMTiles はほぼ全ての読み取りがそのような Range 要求なので、Pages 経由では地図が描けませんでした。同じ Cloudflare ゾーンの内側にある R2 には、この不具合がありません。

コード側(`web/vendor/`・`web/*.mjs`・`web/*.js`・`index.html`)はバンドラを通さず、`web/` の中身をそのまま配ります。読むパスは元々すべて相対で、`user.github.io/<repo>/` の下でもそのまま動きます。配信データだけは例外で、`web/mapspec.mjs` と `web/app.js` が持つ `'data/…'` という相対パスを、配る直前に Actions が `https://data.nanase.cc/…` へ書き換えます(手元で `mise run serve` する分には相対パスのまま、`build/regions/` から作った `web/data/` を読みます)。

```sh
mise run publish-data   # web/data/ を R2(data.nanase.cc)に上げる
```

| 何 | どこ |
| --- | --- |
| コード | リポジトリ → GitHub Pages |
| 配信データ | R2 バケット `kokudo-map-data` → `data.nanase.cc` |
| 組み立てと配信 | `.github/workflows/pages.yml` |

データの更新に Pages の再デプロイは不要です。`data.nanase.cc` は上げた直後から新しい内容を返します。コードを `main` に push したときは Pages だけが作り直ります。そのときデータには触りません。

## 初回セットアップ

1. リポジトリを作って push する
2. Settings → Pages → Source を **GitHub Actions** にする
3. Cloudflare で R2 バケットを作り、`data.nanase.cc` に紐づける
4. `bun x wrangler login` を済ませる
5. `bun x wrangler r2 bucket cors set kokudo-map-data --file pipeline/r2-cors.json` で CORS を許可する
   - `nanase.cc`(Pages)から `data.nanase.cc`(R2)への `fetch` は別オリジン越しになるので、許可が無いとブラウザが読み取りを止める
6. `mise run publish-data` を実行する
