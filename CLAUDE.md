# 国道マップ

日本の一般国道に特化した Web マップです。縮尺で番号を省略せず、重用区間で番号を丸めないことが存在理由です。全国 47 都道府県を 1 枚で出します。

## 作業を始める前に

国道データに触るなら `.claude/skills/national-route-data/` を読んでください。取得手順、判定ルール、不具合の切り分け、過去の判断は、すべてそこにあります。判定ルールは実データの計測に基づいて決めてあるので、思いつきで変えないでください。

文書を書くときは readable-docs、readable-japanese、readable-skill に従ってください。利用者は長い文章を読むのが苦手です。

これらを含む汎用スキルは [nanase/claude-skills](https://github.com/nanase/claude-skills) から入ります。対話セッションでこのリポジトリを信頼した時点で有効になります。ここに置いてあるのは national-route-data だけです。

`claude -p` などの非対話セッションでは登録が走りません。CI で回すなら、先に `claude plugin marketplace add https://github.com/nanase/claude-skills.git` が必要です。

## コマンド

データと配信は mise が、コードと資材は bun が持ちます。作る物が Python か JavaScript かで分けます。

一覧は `mise tasks` と `bun run` が出します。何をする物かは [docs/development.md](docs/development.md) にあります。ここに書き写すと、片方が暗黙のうちに古くなります。

初回は `mise trust` と `mise install` が必要です。`serve` は `python -m http.server` ではありません。PMTiles は Range 要求で読むので、それに答えられるサーバが必要です。

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
  - 片方が暗黙のうちに古くなる
- build/ と web/data/ を木ごと消さない
  - 追跡していないので git では戻らない
  - pbf 2.5 GB と 47 都道府県ぶんの生成物が入っており、取り直しと再生成に何時間もかかる
  - 中の 1 ファイルを消すのは構わない。木ごと消す形だけを `.claude/hooks/guard-data-dirs.mjs` が手前で止める
- 配信データ(PMTiles・meta.json)は GitHub Pages を経由させない
  - Pages の裏側(Fastly)は、Range 要求を圧縮後の本体に対して適用し、`content-encoding` を名乗らずに返す不具合を持つ
  - PMTiles の読み取りはほぼ全てそのような Range 要求なので、Pages 経由では地図が描けない
  - 同じ Cloudflare ゾーン内の R2(`data.nanase.cc`)には無く、そちらに置く

## 構成

場所ごとの中身は [docs/development.md](docs/development.md) の「構成」節にあります。
