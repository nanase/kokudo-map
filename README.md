# 国道マップ

日本の一般国道に特化した Web マップです。既存の地図では読み取れない二点を正面から扱います。

- 縮尺で番号が省略されない
  - 短い路線も、ズームを引いても番号が出る
- 重用区間で番号を丸めない
  - 同一区間に複数の国道が指定されているとき、番号の若いものだけでなく全指定を出す

範囲は全国 47 都道府県です。地図に都道府県の選択はありません。

## 動かす

```sh
mise trust            # 初回のみ
mise install          # 初回のみ。node・python・bun・uv が入る
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
| `mise run audit <地域>` | 鎖が切れている路線を機械的に探す |
| `mise run compare <地域>` | Overpass 由来の基準と突き合わせる |
| `mise run serve` | ローカルサーバを起動する |
| `mise run render-check` | Chromium で実描画を確認する |

`serve` は `python -m http.server` ではありません。PMTiles は Range 要求で読むので、それに答えられるサーバが要ります。

道具は二つあります。**データと配信は mise、コードと資材は bun** です。作る物が Python か JavaScript かで分けてあり、同じ名前は両方に置きません。`scripts/check_docs.mjs` がそれを毎回確かめます。

`uv` が依存を解決するので pip install は不要です。その `uv` 自身も含めて、道具の版は `mise.toml` だけが述べます。Node は検証とタイル化に使います。パッケージ管理には bun を使います。

`mise.toml` は入れた道具を PATH の先頭に置く設定にしてあります。既定では末尾に足すので、システムに別途入っている node や python が先に見つかり、宣言した版が使われないまま気付けません。効くのはこのディレクトリの下だけです。

```sh
bun install
bun x playwright install chromium   # 実描画チェックにのみ必要
```

`bun install` は続けて `scripts/vendor_web.mjs` を走らせ、MapLibre と PMTiles を `node_modules` から `web/vendor/` に複製します。地図はそこから読みます。CDN は読みません。

地図の資材は生成物ですが、めったに変わらないので追跡します。作り直すのは元を変えたときだけです。

| コマンド | 作る物 |
| --- | --- |
| `bun run glyphs` | `web/glyphs/` — ラベルの SDF グリフ |
| `bun run brand` | `web/favicon.svg` と `web/og.png` |

グリフは 11 字しかありません。ラベルは路線番号を `・` で繋いだ物だけなので、日本語フォント一式は要りません。2 ファイル 5 kB で足ります。

`bunfig.toml` で `minimumReleaseAge` を設定してあり、公開から 3 日経っていないパッケージは入りません。サプライチェーン攻撃で悪意あるバージョンが公開直後に出回っても、既知の期間はそれを踏みません。

```sh
bun run lint                 # 静的検査
bun run format               # 整形
bun run lint:fix             # 安全な自動修正込みで検査
bun run test                 # 単体テスト
bun run check                # スタイルと絞り込み式（生成済みの地域が要る）
bun run check --spec-only    # 同上。データを読まない
bun run check:docs           # 命令の一覧が食い違っていないか
```

## 構成

| 場所 | 中身 |
| --- | --- |
| `web/` | 地図本体。MapLibre GL JS と配信データ |
| `web/mapspec.mjs` | スタイルと絞り込み式の定義。検証スクリプトも同じ物を読む |
| `web/app.js` | 地図と操作の繋ぎ込み。生きた地図と頁が要る部分だけが残る |
| `web/aggregate.mjs` | 画面が出す数を組み合わせ表から読む |
| `web/panel.mjs` | 側面の一覧・集計・凡例の組み立て |
| `web/popup.mjs` | 押したアークが自分について述べること |
| `web/termini.mjs` | 起点・終点を GeoJSON にする |
| `web/shield.mjs` | 国道番号標識の形。画面も favicon も共有画像もここから描く |
| `web/html.mjs` | エスケープ。OSM の文字は信用できない |
| `web/glyphs/` | ラベルの SDF グリフ。数字と `・` の 11 字 |
| `scripts/` | 地図そのものの道具。データ生成には関わらない |
| `test/` | データを持たずに答えられることの単体テスト |
| `docs/` | この README から辿る詳細文書 |
| `.github/workflows/` | 検査と GitHub Pages への配信 |
| `.claude/skills/national-route-data/` | 生成と品質管理の手順、判定ルール、スクリプト |
| `build/` | pbf、キャッシュ、地域ごとの中間成果。作り直せるので成果物ではない |

判定ルール、不具合の切り分け、過去の判断は
[national-route-data スキル](.claude/skills/national-route-data/SKILL.md)
にまとめてあります。

## データモデル

各区間に、そこを通る国道番号の集合を持たせます。これだけです。判定は `n`(重用数)だけで決まり、UI の主要機能はすべて MapLibre の式に落ちます。データ形式の詳細は [docs/data-model.md](docs/data-model.md) を参照してください。

## 取得と判定

OSM の取得元は Geofabrik の `japan-latest.osm.pbf` 一つですが、**判定は都道府県の箱の中で閉じたままにしてあります**。全国化でここを一緒に広げてはいけません。理由と過去の実例は [national-route-data スキル](.claude/skills/national-route-data/SKILL.md#判定は地域ごとに閉じている)にまとめてあります。

## 配信する

コードは GitHub Pages に、配信データ(PMTiles・meta.json)は Cloudflare R2(`data.nanase.cc`)に分けて置きます。分けている理由、配信の形、初回セットアップ手順は [docs/architecture.md](docs/architecture.md) にまとめてあります。

```sh
mise run pack           # clone 直後、web/data/ をローカル向けに作る
mise run publish-data   # web/data/ を R2(data.nanase.cc)に上げる
```

データの更新に Pages の再デプロイは要りません。`data.nanase.cc` は上げた直後から新しい内容を返します。

## 結果

データ基準は 2026-08-16T20:21:06Z です。全国 459 路線、144,635 アークが地図に出ています。詳しい内訳と配信物の大きさは [docs/results.md](docs/results.md) にあります。

## 検証

`verify.py`・`verify_national.py`・`check_expressions.mjs` など 7 本のスクリプトで、地域ごとの整合性から結合後の突合、実描画までを確かめます。一覧と CI の扱いは [docs/verification.md](docs/verification.md) にまとめてあります。

## 既知の制約

- bbox で切っているため隣県が食み込む
  - 行政界でのクリップは未実装
  - 路線数には食み出しで入った隣県の路線を含む
- 東京都の箱は本土だけ
  - 都域は小笠原・南鳥島・沖ノ鳥島に及び、測ると 15.8x18.5 度になる
  - その矩形は愛知から和歌山までを飲み込み、裏取りが効かなくなる
  - 外した島々に国道は無いことを、取りこぼし検査が毎回確かめる
- 起終点は暫定
  - bbox の縁で切れた端点は除外している
  - 政令の別表との突き合わせは未実施
- 海上国道は部分的
  - リレーションに含まれる航路だけが入る
  - 車道と紛れないよう破線で描き、表示は個別に切り替えられる

## ライセンス

- コードは [MIT](LICENSE.md)。適用範囲は `web/`・`scripts/`・`test/` 等で、道路データ(`web/data/`)は含みません
- 道路データは © OpenStreetMap contributors, ODbL 1.0
- 背景地図は国土地理院
- ラベルのグリフは Noto Sans JP, SIL Open Font License 1.1
- MapLibre GL JS と PMTiles は BSD-3-Clause
