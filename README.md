# 国道マップ

日本の一般国道に特化した Web マップです。既存の地図では読み取れない二点を正面から扱います。

- 縮尺で番号が省略されない
  - 短い路線も、ズームを引いても番号が出る
- 重用区間で番号を丸めない
  - 同一区間に複数の国道が指定されているとき、番号の若いものだけでなく全指定を出す

範囲は全国 47 都道府県です。地図に都道府県の選択はありません。

## 使う

https://nanase.github.io/kokudo-map/ で公開しています。

## セットアップ

```sh
mise trust    # 初回のみ
mise install  # 初回のみ。node・python・bun・uv が入る
bun install
```

## 開発

データの生成、配信、検証、コードの構成は [docs/development.md](docs/development.md) にまとめてあります。

## ライセンス

- コードは [MIT](LICENSE.md)。適用範囲は `web/`・`scripts/`・`test/` 等で、道路データ(`web/data/`)は含みません
- 道路データは © OpenStreetMap contributors, ODbL 1.0
- 背景地図は国土地理院
- ラベルのグリフは Noto Sans JP, SIL Open Font License 1.1
- MapLibre GL JS と PMTiles は BSD-3-Clause
