# 国道マップ

日本の一般国道に特化した Web マップである。縮尺で番号を省略せず、重用区間で番号を丸めないことが存在理由である。全国 47 都道府県を 1 枚で出す。

## 作業を始める前に

国道データに触るなら `.claude/skills/national-route-data/` を読む。取得手順、判定ルール、不具合の切り分け、過去の判断がすべてそこにある。判定ルールは実データの計測に基づいて決めてあるので、思いつきで変えない。

文書を書くときは `.claude/skills/` の readable-docs、readable-japanese、readable-skill に従う。利用者は長い文章を読むのが苦手である。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `mise run fetch-pbf` | Geofabrik の pbf を取得する。約 2.5 GB |
| `mise run extract` | pbf から 47 地域ぶんのキャッシュを切り出す |
| `mise run build-all` | 全地域を作り直し、配信データまで通す |
| `mise run rebuild <region>` | 1 地域だけ作り直す |
| `mise run pack` | `build/regions/` から `web/data/` を作り直す |
| `mise run publish-data` | 配信データを Release に上げ、Pages を配り直す |
| `mise run audit <region>` | 鎖が切れている路線を機械的に探す |
| `mise run compare <region>` | Overpass 由来の基準と突き合わせる |
| `mise run serve` | http://localhost:8000/ |
| `mise run render-check` | Chromium で実描画を確認する |

初回は `mise trust` が必要である。`serve` は `python -m http.server` ではない。PMTiles は Range 要求で読むので、それに答えられるサーバが要る。

## 変えてはいけない判断

理由まで含めた記録は skill の CASES.md にある。

- 取得は全国、判定は都道府県ごと
  - 裏取りが効くのは、保証集合が県ぶんしかないからである
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

## 構成

| 場所 | 中身 |
| --- | --- |
| `web/` | 地図本体と配信データ |
| `web/data/national.pmtiles` | 全国のベクタタイル |
| `web/data/national.meta.json` | 画面が出す集計。指定の組み合わせ単位 |
| `web/mapspec.mjs` | スタイルと絞り込み式。検証スクリプトも同じ物を読む |
| `scripts/` | 地図の資材を作る道具。グリフ、favicon、ライブラリの複製 |
| `.claude/skills/national-route-data/` | 手順、判定ルール、スクリプト |
| `.github/workflows/` | GitHub Pages への配信 |
| `build/` | pbf、キャッシュ、地域ごとの中間成果。作り直せるので成果物ではない |
