# 配信アーキテクチャ

[開発](development.md) から辿る詳細文書です。配信データをどう作り、どこに置くかをまとめます。

## 配信の形

全国のアークは 1 つの GeoJSON では配れません。閲覧側は特徴量を手元に持ちません。

| ファイル | 中身 |
| --- | --- |
| `web/data/national-routes.pmtiles` | 一般国道のベクタタイル。Range 要求で読む |
| `web/data/national.meta.json` | 国道について画面が出す集計 |
| `web/data/regions.json` | 地域の一覧。`?region=` の初期表示に使う |
| `web/data/prefectural-routes.pmtiles` | 都道府県道のベクタタイル |
| `web/data/pref/{region}.meta.json` | 県ごとの集計。47 個 |
| `web/data/pref/index.json` | 全国の県と番号だけの索引。「道路を選択」が番号で絞り込むために読む |

どれも git では追跡しません。道路データは ODbL 1.0 で、MIT のコードと同じ木に置くと配布条件の違う二つを一度に配ることになります。タイルは gzip 済みで圧縮も差分も効かず、作り直すたびに丸ごと履歴へ積まれます。

clone した直後は次で作れます。

```sh
mise run pack
```

タイルは geojson-vt で切ります。MapLibre が GeoJSON ソースに使うのと同じ実装なので、描かれる形は変わりません。tippecanoe は Windows 版が無く、不要です。

切り方は `pipeline/tiles.mjs`、集計は `pipeline/rollup.mjs` が持ちます。国道と都道府県道はどちらも同じ物を呼びます。数え方は路線の格に依らないので、二つの入口のどちらにも置きません。

集計は指定の組み合わせごとに 1 行です。路線別の表では足りません。重用区間のアークは複数の路線に属するので、路線の行を足すと共有部分を二重に数えます。それは地図が隠すのをやめさせたい数そのものです。

次は 1 行の例です。フィールドの形を示すためのもので、値は [結果](results.md) に合わせてあります。

```json
{ "refs": [7, 8, 17, 49, 403, 459], "n": 6, "km": 4.17, "arcs": 18,
  "kinds": { "road": 4.17 }, "former_km": 0.03,
  "names": ["栗ノ木バイパス"], "bbox": [139.05, 37.90, 139.08, 37.93] }
```

路線一覧も、重用ランキングも、選択したときの延長も、この表の部分和です。数の出どころが一つなので、三つの数字が食い違うことがありません。

`kinds` はその延長の内訳です。0 の区分は書きません。`former_km` は旧道のぶんで、`kinds` とは別の軸です。旧道はどれかの区分の道でもあるので、足すと二重に数えます。

### 索引の一番深いズームは簡略化されない

geojson-vt の性質です。`z === options.maxZoom` に当たるズームだけ、閾値 0 で書き出します。点を落とさず、短い線も捨てません。

タイルは 2 段に分けて切ります。z0 から `SPLIT - 1`(= 7)までは全国を 1 つの索引から、それより深いぶんは z8 のタイルごとの索引から作ります。深いピラミッド全体を一度に抱えないためです。

国道はその低ズーム側の索引を `maxZoom: 7` で作ります。すると z7 が上の条件に当たり、素のまま出ます。z7 の最大タイルが 2,232 kB と、その下の z8 の 581 kB より大きいのはこのためです。ズームを下げるほど軽くなるはずの並びが、ここだけ逆を向きます。

都道府県道は `maxZoom: 8` で作り、z0-7 のすべてを簡略化させます。

国道側は動かしません。値を変えると z7 の線が変わり、国道だけを見ている読み手の見え方が変わります。国道のアーカイブを作り直さないのは #100 で決めたことです。

## 国道と都道府県道でアーカイブを分ける理由

都道府県道は 290,529 アークあります。国道の 151,004 に対して 1.9 倍です。同じアーカイブに入れると、引いた画面で最初に読む 1 枚が 5〜8 MB になります。

分けると三つが同時に片付きます。

- 県道を直したときに上げ直すのは県道の側だけで済みます。国道の 55.9 MB は動きません
- タイル化のメモリが 2 回に分かれます。1 回あたりのピークが下がります
- 県道側が壊れても国道の地図は出ます

ズーム下限は置きません。都道府県道も国道と同じく、縮尺で番号を省略しません。代わりに、低ズームでは載せる属性を減らします。

### 低ズームでは描画に必要な属性だけを載せる

z0-7 のタイルが持つのは次の七つです。`pipeline/pack_web_pref.mjs` の `LOW_ZOOM_FIELDS` がそれを述べます。

| 属性 | 何に使うか |
| --- | --- |
| `pref` | 県で絞る |
| `refs` | 路線で絞る |
| `n` | 重用の深さ。線の色 |
| `kind` | 層の分かれ目 |
| `rank` | 主要地方道か一般都道府県道か |
| `former`・`revoked` | 旧道の表示切り替え |

落とすのは `id`・`label`・`name`・`km`・`src` です。番号のラベルは z8 から出るので(`route-labels` の `minzoom` が 8)、`label` は読まれません。残る四つを読むのはポップアップだけです。

線の形は変えません。簡略化の閾値は国道と同じ 3 のままです。それでも z0-7 の最大タイルは 2,322 kB から 1,258 kB になります。国道の低ズーム最大 2,232 kB に対して 56% です。実測は [結果](results.md#配信物) にあります。

引き換えに、z8 未満では県道のポップアップが出せません。z7 は 1 画素が約 1.2 km で、県道の網はその縮尺では網目になります。どの線を掴んだかが読み手にも決められないところで、どれか 1 本の名前を出しても情報になりません。

### 集計は県ごとに分ける

画面が最初に読む JSON を増やさないためです。`national.meta.json` は 0.61 MB を丸ごと先読みします。県道の路線は 13,234 あるので、同じ形の全国 1 枚を足すと、その先読みが数倍になります。

県ごとなら、画面が最初に読むのは今までどおり国道のぶんだけです。県のぶんは県を選んだときに 1 つだけ取ります。中身の一番大きい北海道で 227 kB(gzip 50 kB)、中央値は 65 kB(同 14 kB)です。

47 個に分けるのは、県が画面の選ぶ単位そのものだからです。地方でまとめると、関東の 1 個が `national.meta.json` と同じ大きさに戻り、しかも選んでいない 6 県ぶんが一緒に付いてきます。この repo には地方という区分もありません。

## コードとデータを分けて置く理由

コードは GitHub Pages に、配信データは Cloudflare R2(`data.nanase.cc`)に置きます。分けているのは選択ではなく回避です。

### GitHub Pages 経由で Range 要求が壊れる

`nanase.cc` 配下(Pages)へ実際に Range 要求を送ると、次のようになります。

| 対象 | 200 の実長 | `Range: bytes=100-199` への応答 |
| --- | --- | --- |
| `style.css` | 63677 バイト | 206 は返るが、全体長が 19634(gzip 後の長さ)になり、`content-encoding` の無いまま本文だけ gzip の生バイトになる |
| `glyphs/.../0-255.pbf` | 4835 バイト | 同様に全体長・中身とも不一致。Cloudflare が未キャッシュ(`cf-cache-status: DYNAMIC`)でも壊れる |
| `og.png` | 156949 バイト | 全体長・中身とも一致し、正しく返る。Cloudflare はキャッシュ済み(`HIT`) |

原因は origin 側、GitHub Pages の裏にある Fastly の圧縮です。Range を圧縮後の本体に適用し、`content-encoding: gzip` を名乗らずに返すため、読み手は狙った位置とは違うバイト列を受け取ります。

png が壊れないのはすでに圧縮済みの形式で、Fastly が二重に圧縮しないためです。pbf は Cloudflare が未キャッシュでも壊れるので、原因は Cloudflare のキャッシュではなく origin にあります。

PMTiles の読み取りはほぼ全てこの種の Range 要求なので、Pages 経由では地図が描けません。同じ Cloudflare ゾーンの R2 にはこの不具合が無く、配信データはそちらに置きます。

### グリフはこの不具合に触れない

`glyphs/{fontstack}/{range}.pbf`(`web/mapspec.mjs`)の `{range}` は Unicode のコードポイント範囲で、ファイル名の一部です。HTTP の Range 要求ではありません。MapLibre はこのファイルを毎回丸ごと GET します。

vendor のライブラリを検査すると、`bytes=` を送るのは `pmtiles.js` だけでした。`maplibre-gl.js` に出てくる `Range` は `latRange`・`lngRange`・`setDefaultRange` など緯度経度の範囲で、HTTP ヘッダーとは無関係です。

したがって、グリフは Pages 経由のままでも壊れません。現在 `.pbf` が `cf-cache-status: DYNAMIC` なのは、その拡張子が Cloudflare の既定の静的拡張子一覧に入っていないためで、意図した設定ではありません。

コード側(`web/vendor/`・`web/*.mjs`・`web/*.js`・`index.html`)はバンドラを通さず、`web/` をそのまま配ります。読むパスはすべて相対で、`user.github.io/<repo>/` の下でも動きます。配信データだけは例外で、`web/mapspec.mjs` と `web/app.js` は `web/dataurl.mjs` の `dataURL()` で URL を組みます。基点(相対パス `data/`)を持つのは `dataurl.mjs` の 1 行だけで、配る直前に Actions がそこを `https://data.nanase.cc/` へ書き換えます。手元の `mise run serve` では相対パスのまま、`build/regions/` から作った `web/data/` を読みます。配信データのファイルが増えても、書き換える行は増えません。

```sh
mise run publish-data   # web/data/ を R2(data.nanase.cc)に上げる
```

| 何 | どこ |
| --- | --- |
| コード | リポジトリ → GitHub Pages |
| 配信データ | R2 バケット `kokudo-map-data` → `data.nanase.cc` |
| 組み立てと配信 | `.github/workflows/pages.yml` |

ファイルが増えても Pages を経由できない理由は変わりません。増えたぶんも R2 に置きます。

データの更新に Pages の再デプロイは不要です。`data.nanase.cc` は上げた直後から新しい内容を返します。コードを `main` に push したときは Pages だけが作り直ります。そのときデータには触りません。

## キャッシュ設定

`nanase.cc` ゾーンのキャッシュ関連設定を `pipeline/cf-cache.json` としてリポジトリに持つ。設定は今もダッシュボードで手で当てており、ここでは取得と記録だけを扱う。適用(書き込み)は別に用意する。

```sh
mise run cf-cache        # 取得して pipeline/cf-cache.json へ書き出す
mise run cf-cache-diff   # ファイルと実際の設定の差分を出す
```

トークンは環境変数 `CLOUDFLARE_CACHE_CONFIG_TOKEN`、ゾーン ID は `CLOUDFLARE_ZONE_ID` から読む。`CLOUDFLARE_API_TOKEN` という名前は使わない。その名前があると wrangler が OAuth ログインより優先して読み、このトークンには R2 権限が無いため `mise run publish-data` が壊れる。

現在、次の 3 本の Cache Rule を当てている。

### ルール 1 ── `/kokudo-map/` 配下の `.mjs` をキャッシュ対象にする

`.mjs` は Cloudflare の既定の静的拡張子一覧に無い。既定のままでは `cf-cache-status: DYNAMIC`(キャッシュ対象外)になる。これを個別にキャッシュ対象へ加えているのがこのルールである。

ブラウザの監査ツール Lighthouse が「`.mjs` がキャッシュされていない」という趣旨の警告を出し、それに応えて追加した(ユーザーの記憶によるもので、Lighthouse がどの層のキャッシュを見て警告したかまでは特定されていない)。原因は `.js` はキャッシュされるのに `.mjs` はされないことで、これは今回取得した実データが裏づける。`.mjs` だけ明示のルールがあり、`.pbf` と `.webmanifest` は `DYNAMIC` のままだったので、Cloudflare の既定の静的拡張子一覧に `.mjs` が無いことが原因と読める。

### ルール 2 ── `/kokudo-map/` 配下(glyphs を除く)の Browser TTL を origin に従わせる

ゾーンの Browser Cache TTL 設定が 48 時間をブラウザ向けに被せており、GitHub Pages が返す 600 秒(10 分)を上書きしていた。この被さりはキャッシュ対象の応答にしか効かない。`.js` `.css` `.woff2` `.png` は Cloudflare の既定でエッジに乗り 48 時間が被さる。`.mjs` はルール 1 によってエッジに乗るため、同じく被さる。`.html` `.webmanifest` `.pbf` はエッジに乗らず、Pages の 600 秒がそのまま出ていた。

結果、配信の 10 分後には「新しい `index.html`」と「最大 48 時間古い `app.js`・`style.css`・`mapspec.mjs`」が組み合わさり、ページが壊れた。単に古いのではなく、新旧が混ざるのが問題だった。

ゾーン設定を直接下げると `nanase.cc` の他も巻き込むため、Cache Rule で `/kokudo-map/` 配下だけに効かせている。式に `http.host eq "nanase.cc"` を入れているので、`data.nanase.cc`(R2)には当たらない。

### ルール 3 ── `/kokudo-map/glyphs/` をエッジキャッシュ対象にする

`.pbf` は Cloudflare の既定の静的拡張子一覧に無く、`cf-cache-status: DYNAMIC` のままだった。ラベルのグリフを引くたび、GitHub Pages まで往復していた。

Edge TTL は「キャッシュ制御ヘッダーが存在する場合は使用し、存在しない場合はキャッシュをバイパスします」を選んでいる。ヘッダーが消えたときに「キャッシュしない」側へ倒れ、古い物が配られる余地が無いからである。

グリフに Range 要求は使われないので、Pages 経由の Range 破損には触れない(上の「グリフはこの不具合に触れない」を参照)。

### 適用後の実測

適用前は `app.js`・`style.css`・`mapspec.mjs`・`vendor/maplibre-gl.js`・`vendor/*.woff2` が `max-age=172800`、`/kokudo-map/`・`glyphs/*.pbf`・`manifest.webmanifest` が `max-age=600` で `cf-cache-status: DYNAMIC` だった。

適用後は `/kokudo-map/` 配下がすべて `max-age=600` に揃い、2 回目の要求で `/kokudo-map/`・`mapspec.mjs`・`vendor/maplibre-gl.js`・`glyphs/*.pbf`・`manifest.webmanifest` がいずれも `cf-cache-status: HIT` になった。`data.nanase.cc` は `DYNAMIC` のままで、PMTiles の Range も `content-range: bytes 1000-1099/55918678` と実サイズに一致しており、影響が無いことを確かめてある。

### 指定より広く効いた点

ルール 2 は Browser TTL だけを触る設計だったが、実際には HTML と `manifest.webmanifest` もキャッシュ対象になった(`DYNAMIC` → `HIT`)。これは害ではない。Edge TTL が origin に従うので、エッジが HTML を抱えるのは最大 10 分である。デプロイ時のパージ対象にルート(`""`)と `index.html` が両方入っているため、配信直後に 0 分になる。静的サイトで出し分けも無いので、そのままにしている。

ルール 2 の `action_parameters` にも `"cache": true` が入っており、`/kokudo-map/` 配下(glyphs を除く)は既にすべてキャッシュ対象にしている。`.mjs` もこれに覆われるので、ルール 1 を外しても `.mjs` はルール 2 でキャッシュ対象のままと読める。ルール 1 が解こうとした問題は、今はルール 2 が解いている形である。

ただしこれは読みであって確かめてはいない。このタスクは読み取りだけを扱うので、外すかどうかの判断はしない。外すなら、Lighthouse の警告が再発しないことまで確かめる必要がある。

### 残る制約

ファイル名にハッシュを付けておらずキャッシュバスティングができないため、設定を変える前に配られた `max-age=172800` の応答は、最終アクセスから 48 時間経つまでブラウザに残る。この設定で 0 分にはできない。0 分にするには配信時にファイル名かクエリへコミット SHA を入れる必要があり、`import` 指定子と `web/vendor/line-seed-jp.css` の 248 件の `url()` まで書き換える作業になる。今は見送っている。

## 初回セットアップ

1. リポジトリを作って push する
2. Settings → Pages → Source を **GitHub Actions** にする
3. Cloudflare で R2 バケットを作り、`data.nanase.cc` に紐づける
4. `bun x wrangler login` を済ませる
5. `bun x wrangler r2 bucket cors set kokudo-map-data --file pipeline/r2-cors.json` で CORS を許可する
   - `nanase.cc`(Pages)から `data.nanase.cc`(R2)への `fetch` は別オリジン越しになるので、許可が無いとブラウザが読み取りを止める
6. `mise run publish-data` を実行する
7. Cache Rules の Edit と Zone Settings の Edit 権限を、`nanase.cc` ゾーンだけに絞ったトークンを作る
8. リポジトリ直下に `mise.local.toml` を作り、`[env]` にトークンとゾーン ID を書く。git の管理外である(`.gitignore`)

   ```toml
   [env]
   CLOUDFLARE_CACHE_CONFIG_TOKEN = "..."
   CLOUDFLARE_ZONE_ID = "..."
   ```

   mise は設定ファイルを祖先方向へ辿るので、`.claude/worktrees/<name>/` の深さで `mise run` / `mise exec` を通して実行しても読める。素の shell から直接読むには mise の有効化(`mise activate`)が要る。
9. `mise run cf-cache` で取得できることを確かめる
