![国道マップ — 重用区間で番号を丸めない日本の国道地図。単独指定・二重用・三重用と、深くなるにつれ色を変える一本の国道と、その上に載る国道番号標識](web/og.png)

日本の一般国道に特化した Web マップです。

- 縮尺で番号が省略されない
  - 短い路線も、ズームを引いても番号が出る
- 重用区間で番号を丸めない
  - 同一区間に複数の国道が指定されているとき、番号の若いものだけでなく全指定を出す

## 使う

https://nanase.github.io/kokudo-map/

## セットアップ

```sh
mise trust    # 初回のみ
mise install  # 初回のみ。node・python・bun・uv が入る
bun install
```

## 開発

データの生成、配信、検証、コードの構成は [docs/development.md](docs/development.md) にまとめてあります。

## ライセンス

- コードは [MIT](LICENSE.md)。適用範囲は `web/`・`scripts/`・`pipeline/`・`test/` 等で、道路データ(`web/data/`)は含みません
- 道路データ: © OpenStreetMap contributors, ODbL 1.0
- 背景地図: 国土地理院
- ラベルのグリフ: Noto Sans JP, SIL Open Font License 1.1
- MapLibre GL JS と PMTiles: BSD-3-Clause
