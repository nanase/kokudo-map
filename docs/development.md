# 開発

[README](../README.md) から辿る詳細文書です。

## 道具

データと配信は mise が、コードと資材は bun が持ちます。作る物が Python か JavaScript かで分けてあり、同じ名前は両方に置きません。`bun run check:docs` がそれを毎回確かめます。

`uv` が依存を解決するので pip install は不要です。その `uv` 自身も含めて、道具の版は `mise.toml` だけが述べます。Node は検証とタイル化に使います。

`mise.toml` は入れた道具を PATH の先頭に置く設定にしてあります。既定では末尾に足すので、システムに別途入っている node や python が先に見つかり、宣言した版が使われないまま気付けません。効くのはこのディレクトリの下だけです。

ただしこれは `mise activate` でシェル統合を済ませた場合の話です。済ませていないシェルでは、`mise install` の後も `bun` や `python` が PATH に現れません。シェルの設定ファイルに次を足してください。

```sh
eval "$(mise activate bash)"   # bash
eval "$(mise activate zsh)"    # zsh
mise activate fish | source    # fish
```

済ませないまま進めるなら、各コマンドの前に `mise exec --` を置いてください。

```sh
bun x playwright install chromium   # 実描画の確認にだけ必要
```

`bun install` は続けて `scripts/vendor_web.mjs` を走らせ、MapLibre と PMTiles と書体を `node_modules` から `web/vendor/` に複製します。地図はそこから読みます。CDN は読みません。

書体は 2 つです。路線番号の標識が Roboto、操作面が LINE Seed JP です。後者は日本語 1 書体ぶんあるので 1 ファイルにはなりません。Fontsource が unicode-range で分けた約 120 片を、weight 400・700 のぶんだけ複製します。woff2 で 248 ファイル、6 MB です。ブラウザが取るのは画面に出ている字を含む片だけです。

`bunfig.toml` で `minimumReleaseAge` を設定してあり、公開から 3 日経っていないパッケージは入りません。サプライチェーン攻撃で悪意あるバージョンが公開直後に出回っても、その 3 日のあいだに見つかって取り下げられれば踏みません。3 日を過ぎてから悪意が判明した版は防げないので、これは防壁ではなく、気付かれるまでの時間を稼ぐ仕掛けです。

## データを作る

```sh
mise run fetch-pbf    # Geofabrik の japan-latest.osm.pbf、約 2.5 GB
mise run extract      # pbf から 47 地域ぶんを切り出す
mise run build-all    # 判定 → 検証 → 結合 → タイル化 → 全国検証
mise run serve        # http://localhost:8000/
```

`?region=niigata` を付けると、その地域の位置で開きます。出るデータは変わりません。初期表示の指定だけです。

| タスク | 内容 |
| --- | --- |
| `mise run fetch-pbf` | pbf を取得する |
| `mise run extract` | pbf から地域ごとのキャッシュを切り出す |
| `mise run build-all` | 全地域を作り直し、配信データまで通す |
| `mise run build <地域>` | 1 地域を Overpass から取得して作り直す |
| `mise run rebuild <地域>` | 1 地域だけ作り直す |
| `mise run pack` | `build/regions/` から `web/data/` を作り直す |
| `mise run publish-data` | 配信データを R2(data.nanase.cc)に上げる |
| `mise run decree` | 政令の別表から起点・終点を取り込み、座標を当てる |
| `mise run audit <地域>` | 途切れている路線を機械的に探す |
| `mise run compare <地域>` | Overpass 由来の基準と突き合わせる |
| `mise run compare-n13 <地域>` | 国土数値情報 N13(道路)と突き合わせ、OSM に無い国道の候補を探す |
| `mise run apply-n13 <地域>` | former のうち N13 で指定解除を機械確認できたものに revoked を書き込む |
| `mise run compare-annual-report` | 道路統計年報と延長を突き合わせ、差の内訳を出す |
| `mise run serve` | ローカルサーバを起動する |
| `mise run render-check` | Chromium で実描画を確認する |

国土数値情報 N03(行政区域)は初回に取ります。`mise run extract` は way の所属都道府県を決めるのに現行の年版を、`mise run decree` は政令の地名を引くのに 2000 年版も使います。47 都道府県ぶん二つで約 530 MB です。以後はキャッシュから読みます。

`serve` は `python -m http.server` ではありません。PMTiles は Range 要求で読むので、それに答えられるサーバが必要です。

判定ルールは都道府県ごとに閉じたままにしてあります。取得は全国でも、この境界は崩せません。理由、不具合の切り分け、過去の判断は [national-route-data スキル](../.claude/skills/national-route-data/SKILL.md) にまとめてあります。

## コード・資材を作る

地図の資材は生成物ですが、めったに変わらないので追跡します。作り直すのは元を変えたときだけです。

| コマンド | 作る物 |
| --- | --- |
| `bun run glyphs` | `web/glyphs/` — ラベルの SDF グリフ |
| `bun run brand` | `web/favicon.svg`・`web/og.png`・`web/icons/` — ホーム画面アイコン一式 |

共有カードは寸法を選べます。`bun run brand -- --card 1280x640 --out build/social.png` は、その寸法のカードだけをそこへ書きます。GitHub の Social preview がこれで、SNS が出すカードが期待する 1200x630 とは合いません。設定画面に上げたら捨ててください。書き先を `build/` にしてあるのは、この画像を追跡しないためです。追跡する木の中に置くと `git add -A` が拾います。

絵は寸法ごとに組み直しません。1200x630 の組みを、求められた枠を覆うまで拡大して、はみ出したぶんを切ります。そのため選べるのは 1200:630 に近い縦横比だけです。離れた寸法は切る量が題字や標識に届くので、書かずに止まります。

グリフは 11 字しかありません。ラベルは路線番号を `・` で繋いだ物だけなので、日本語フォント一式は不要です。2 ファイル 5 kB で足ります。

```sh
bun run lint                 # 静的検査
bun run format               # 整形
bun run lint:fix             # 安全な自動修正込みで検査
bun run test                 # 単体テスト
bun run check                # スタイルと絞り込み式(生成済みの地域が必要)
bun run check --spec-only    # 同上。データを読まない
bun run check:docs           # 命令の一覧が食い違っていないか
uvx ruff check pipeline      # Python の静的検査
```

## 構成

| 場所 | 中身 |
| --- | --- |
| `web/` | 地図本体。MapLibre GL JS と配信データ |
| `web/mapspec.mjs` | スタイルと絞り込み式の定義。検証スクリプトも同じ物を読む |
| `web/app.js` | 地図と操作の繋ぎ込み。生きた地図とページが必要な部分だけが残る |
| `web/wiring.mjs` | index.html の要素と state の対応づけ。地図を作らずに import できる |
| `web/urlstate.mjs` | 絞り込みと表示状態を URL のクエリ文字列に載せる |
| `web/aggregate.mjs` | 画面が出す数を組み合わせ表から読む |
| `web/panel.mjs` | 操作面の一覧・集計と、地図の上の凡例の組み立て |
| `web/popup.mjs` | 押したアークが自分について述べること |
| `web/detail.mjs` | 一つの国道について述べること。標識を押すと出るパネル |
| `web/termini.mjs` | 起点・終点を GeoJSON にする |
| `web/shield.mjs` | 国道番号標識の形。画面も favicon も共有画像もここから描く |
| `web/html.mjs` | エスケープ。OSM の文字は信用できない |
| `web/glyphs/` | ラベルの SDF グリフ。数字と `・` の 11 字 |
| `scripts/` | 地図そのものの道具。データ生成には関わらない |
| `pipeline/` | データ生成のコード一式。取得・判定・検証・タイル化。突き合わせ相手の年報の値もここに置く |
| `test/` | データを持たずに答えられることの単体テスト |
| `docs/` | この文書から辿る詳細文書 |
| `.github/workflows/` | 検査と GitHub Pages への配信 |
| `.claude/skills/national-route-data/` | 生成と品質管理の手順、判定ルール |
| `.claude/hooks/guard-data-dirs.mjs` | build/ と web/data/ を木ごと消す命令を手前で止める |
| `build/` | pbf、キャッシュ、地域ごとの中間成果。作り直せるので成果物ではない |

## 関連文書

| 文書 | 中身 |
| --- | --- |
| [architecture.md](architecture.md) | 配信データの形、コードとデータを分けて置く理由、初回セットアップ |
| [data-model.md](data-model.md) | 各区間が持つ属性、MapLibre の式に落ちる仕組み |
| [verification.md](verification.md) | 検証スクリプトの一覧、CI での扱い |
| [results.md](results.md) | 全国の集計、既知の制約 |
