# pr-review-loop — CodeRabbit 固有の扱い

[pr-review-loop](SKILL.md) のループを CodeRabbit が付く PR で回すときの、この bot 固有の挙動である。一般の作法は SKILL.md にある。

## レビューの所在

- nitpick は review 本文内の `<details>` に畳まれる（`Nitpick comments (N)`・`Outside diff range comments` 等）
  - `read-reviews.sh` の出力に含まれるので、折りたたみの中まで開いて読む
  - インラインだけ見ると取りこぼす
- サマリは PR 先頭コメントを上書き更新
  - 毎回最新を読み直す
  - docstring 不足・PR 説明文の乖離・テスト不足などのメタ警告が混じる
  - PR の質に直結するので拾い、PR 本文や docstring を直す

## 返信

対応しない指摘には `@coderabbitai` をメンションして理由を返すと、撤回・メモリ更新で応じる。

## 増分レビュー

push ごとに自動で増分レビューが走る。push 後に `@coderabbitai review` を送らない（二重に走り使用量を無駄にする）。push したら自動レビューを待つ。

手動で促してよい例外は 2 つある。いずれも自動レビューが走っていないことを先に確かめてから送る。

- 一時停止された
  - 一定のコミット数で増分レビューが止まる
  - サマリに一時停止の旨が出ていたら `@coderabbitai review` で再開を促す
- 数巡待っても走らない
  - レート制限・障害などで HEAD へのレビューが付かないとき
  - 促しても来なければ、判定表「完了」が前提とする HEAD レビューの例外として、push 前の自己レビューと CI（未対応の指摘なし・全て成功・マージ可能）を根拠に完了してよい
