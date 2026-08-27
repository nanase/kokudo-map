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
bun x playwright install chromium   # 実描画チェックにのみ必要
```

`bun install` は続けて `scripts/vendor_web.mjs` を走らせ、MapLibre と PMTiles を `node_modules` から `web/vendor/` に複製します。地図はそこから読みます。CDN は読みません。

`bunfig.toml` で `minimumReleaseAge` を設定してあり、公開から 3 日経っていないパッケージは入りません。サプライチェーン攻撃で悪意あるバージョンが公開直後に出回っても、既知の期間はそれを踏みません。

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
| `mise run audit <地域>` | 鎖が切れている路線を機械的に探す |
| `mise run compare <地域>` | Overpass 由来の基準と突き合わせる |
| `mise run compare-n13 <地域>` | 国土数値情報 N13(道路)と突き合わせ、OSM に無い国道の候補を探す |
| `mise run apply-n13 <地域>` | former のうち N13 で指定解除を機械確認できたものに revoked を書き込む |
| `mise run compare-annual-report` | 道路統計年報と延長を突き合わせ、差の内訳を出す |
| `mise run serve` | ローカルサーバを起動する |
| `mise run render-check` | Chromium で実描画を確認する |

`mise run decree` は初回に国土数値情報 N03(行政区域)を取ります。47 都道府県ぶんを現行と 2000 年版の二つ、約 530 MB です。以後はキャッシュから読みます。

`serve` は `python -m http.server` ではありません。PMTiles は Range 要求で読むので、それに答えられるサーバが要ります。

判定ルールは都道府県ごとに閉じたままにしてあります。取得は全国でも、この境界は崩せません。理由、不具合の切り分け、過去の判断は [national-route-data スキル](../.claude/skills/national-route-data/SKILL.md) にまとめてあります。

## コード・資材を作る

地図の資材は生成物ですが、めったに変わらないので追跡します。作り直すのは元を変えたときだけです。

| コマンド | 作る物 |
| --- | --- |
| `bun run glyphs` | `web/glyphs/` — ラベルの SDF グリフ |
| `bun run brand` | `web/favicon.svg` と `web/og.png` |

札は寸法を選べます。`bun run brand -- --card 1280x640 --out build/social.png` は、その寸法の札だけをそこへ書きます。GitHub の Social preview がこれで、リンクの札が期待する 1200x630 とは合いません。設定画面に上げたら捨ててください。書き先を `build/` にしてあるのは、この画像を追跡しないためです。追跡する木の中に置くと `git add -A` が拾います。

絵は寸法ごとに組み直しません。1200x630 の組みを、求められた枠を覆うまで拡大して、はみ出したぶんを切ります。そのため選べるのは 1200:630 に近い縦横比だけです。離れた寸法は切る量が題字や標識に届くので、書かずに止まります。

グリフは 11 字しかありません。ラベルは路線番号を `・` で繋いだ物だけなので、日本語フォント一式は要りません。2 ファイル 5 kB で足ります。

```sh
bun run lint                 # 静的検査
bun run format               # 整形
bun run lint:fix             # 安全な自動修正込みで検査
bun run test                 # 単体テスト
bun run check                # スタイルと絞り込み式(生成済みの地域が要る)
bun run check --spec-only    # 同上。データを読まない
bun run check:docs           # 命令の一覧が食い違っていないか
uvx ruff check pipeline      # Python の静的検査
```

## 構成

| 場所 | 中身 |
| --- | --- |
| `web/` | 地図本体。MapLibre GL JS と配信データ |
| `web/mapspec.mjs` | スタイルと絞り込み式の定義。検証スクリプトも同じ物を読む |
| `web/app.js` | 地図と操作の繋ぎ込み。生きた地図と頁が要る部分だけが残る |
| `web/wiring.mjs` | index.html の要素と state の対応づけ。地図を作らずに import できる |
| `web/urlstate.mjs` | 絞り込みと表示状態を URL のクエリ文字列に載せる |
| `web/aggregate.mjs` | 画面が出す数を組み合わせ表から読む |
| `web/panel.mjs` | 側面の一覧・集計・凡例の組み立て |
| `web/popup.mjs` | 押したアークが自分について述べること |
| `web/detail.mjs` | 一つの国道について述べること。標識を押すと出る箱 |
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
| `build/` | pbf、キャッシュ、地域ごとの中間成果。作り直せるので成果物ではない |

## 関連文書

| 文書 | 中身 |
| --- | --- |
| [architecture.md](architecture.md) | 配信データの形、コードとデータを分けて置く理由、初回セットアップ |
| [data-model.md](data-model.md) | 各区間が持つ属性、MapLibre の式に落ちる仕組み |
| [verification.md](verification.md) | 検証スクリプトの一覧、CI での扱い |
| [results.md](results.md) | 全国の集計、既知の制約 |
