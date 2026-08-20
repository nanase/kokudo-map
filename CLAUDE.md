# 国道マップ

日本の一般国道に特化した Web マップです。縮尺で番号を省略せず、重用区間で番号を丸めないことが存在理由です。全国 47 都道府県を 1 枚で出します。

## 作業を始める前に

国道データに触るなら `.claude/skills/national-route-data/` を読んでください。取得手順、判定ルール、不具合の切り分け、過去の判断は、すべてそこにあります。判定ルールは実データの計測に基づいて決めてあるので、思いつきで変えないでください。

文書を書くときは `.claude/skills/` の readable-docs、readable-japanese、readable-skill に従ってください。利用者は長い文章を読むのが苦手です。

## コマンド

データと配信は mise が、コードと資材は bun が持ちます。作る物が Python か JavaScript かで分けます。

一覧は `mise tasks` と `bun run` が出します。何をする物かは [docs/development.md](docs/development.md) にあります。ここに書き写すと、片方が黙って古くなります。

初回は `mise trust` と `mise install` が要ります。`serve` は `python -m http.server` ではありません。PMTiles は Range 要求で読むので、それに答えられるサーバが要ります。

## 変えてはいけない判断

理由まで含めた記録は skill の CASES.md、配信の設計は [docs/architecture.md](docs/architecture.md) にあります。

- 取得は全国、判定は都道府県ごと
  - 裏取りが効くのは、保証集合が県ぶんしかないため
  - 全国で判定すると 459 番すべてが保証され、何も濾さなくなる
  - 崩すと長野県道 372 号が国道 372 号として戻る
- 旧道は除外せず `former` フラグを立てて残す
  - 指定解除まで法令上は国道であり、地理院地図も国道として描く
- 全国を Overpass から取らない
  - 47 都道府県ぶんはミラーの用途から外れる
  - 1 地域だけ取るときは毎回最も新しいミラーを選ぶ
- 機能は一般の利用者にとっての価値で判断する
  - 利用者個人の背景から機能を導かない
- 検証スクリプトは本物の定義を読み込んで検査する
  - 式を書き写した複製を検査しても検証にはならない
- 同じ問いに二箇所で答えない
  - 片方が黙って古くなる
- 配信データ(PMTiles・meta.json)は GitHub Pages を経由させない
  - Pages の裏側(Fastly)は、ファイル先頭以外への Range 要求に対して要求と無関係なバイト列を返す不具合を持つ
  - PMTiles の読み取りはほぼ全てそのような Range 要求なので、Pages 経由では地図が描けない
  - 同じ Cloudflare ゾーン内の R2(`data.nanase.cc`)には無く、そちらに置く

## 構成

| 場所 | 中身 |
| --- | --- |
| `web/` | 地図本体。配信データは手元用の中間置き場 |
| `web/data/national-routes.pmtiles` | 全国のベクタタイル。手元では `web/data/`、公開先は `data.nanase.cc`(R2) |
| `web/data/national.meta.json` | 画面が出す集計。指定の組み合わせ単位。公開先は同上 |
| `web/mapspec.mjs` | スタイルと絞り込み式。検証スクリプトも同じ物を読む |
| `scripts/` | 地図の資材を作る道具。グリフ、favicon、ライブラリの複製 |
| `test/` | データを持たずに答えられることの単体テスト |
| `docs/` | README から辿る詳細文書 |
| `.claude/skills/national-route-data/` | 手順、判定ルール、スクリプト |
| `.github/workflows/` | 検査と GitHub Pages への配信 |
| `build/` | pbf、キャッシュ、地域ごとの中間成果。作り直せるので成果物ではない |
