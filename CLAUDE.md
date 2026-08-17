# 国道マップ

日本の一般国道に特化した Web マップである。縮尺で番号を省略せず、重用区間で番号を丸めないことが存在理由である。

## 作業を始める前に

国道データに触るなら `.claude/skills/national-route-data/` を読む。取得手順、判定ルール、不具合の切り分け、過去の判断がすべてそこにある。判定ルールは実データの計測に基づいて決めてあるので、思いつきで変えない。

文書を書くときは `.claude/skills/` の readable-docs、readable-japanese、readable-skill に従う。利用者は長い文章を読むのが苦手である。

## コマンド

| コマンド | 内容 |
| --- | --- |
| `mise run build <region>` | 取得から検証まで通す |
| `mise run rebuild <region>` | キャッシュから作り直す。取得しない |
| `mise run audit <region>` | 鎖が切れている路線を機械的に探す |
| `mise run serve` | http://localhost:8000/ |
| `mise run render-check` | Chromium で実描画を確認する |

地域は `nagano` と `niigata` である。初回は `mise trust` が必要である。

## 変えてはいけない判断

理由まで含めた記録は skill の CASES.md にある。

- 旧道は除外せず `former` フラグを立てて残す
  - 指定解除まで法令上は国道であり、地理院地図も国道として描く
- Overpass は毎回最も新しいミラーを選ぶ
  - 遅れたミラーを掴むと 1 か月以上古いデータで作ることになる
- 機能は一般の利用者にとっての価値で判断する
  - 利用者個人の背景から機能を導かない
- 検証スクリプトは本物の定義を読み込んで検査する
  - 式を書き写した複製を検査しても検証にはならない

## 構成

| 場所 | 中身 |
| --- | --- |
| `web/` | 地図本体と生成済みデータ |
| `web/mapspec.mjs` | スタイルと絞り込み式。検証スクリプトも同じ物を読む |
| `.claude/skills/national-route-data/` | 手順、判定ルール、スクリプト |
| `build/cache/` | Overpass の応答。再取得できるので成果物ではない |
