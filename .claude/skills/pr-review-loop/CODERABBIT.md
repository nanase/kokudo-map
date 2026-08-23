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

手動で促してよい例外は 3 つある。いずれも自動レビューが走っていないことを先に確かめてから送る。

- 一時停止された
  - 一定のコミット数で増分レビューが止まる
  - サマリに一時停止の旨が出ていたら `@coderabbitai review` で再開を促す
- レート制限で開始できなかった
  - サマリに "Review limit reached" と解除までの分数が出ている
  - 手順は次の「レート制限」節に従う
  - 分数が明記されているので、根拠なく数巡待つ必要はない
- それ以外の理由で数巡待っても走らない
  - 上記いずれのメッセージも出ないまま、障害などで理由不明に HEAD へのレビューが付かないとき
  - 促しても来なければ、判定表「完了」が前提とする HEAD レビューの例外として、push 前の自己レビューと CI（未対応の指摘なし・全て成功・マージ可能）を根拠に完了してよい

## レート制限（Review limit reached）

CodeRabbit の 1 時間あたりのレビュー回数制限に当たると、サマリ（PR 先頭コメント）が次のように上書きされ、レビューが始まらない。

> ## Review limit reached
> `@[userid]`, you've reached your PR review limit, so we couldn't start this review.
> **Next review available in:** **43 minutes**

このメッセージが出ている間は待つしかない。分数は制限に当たるたびに変わり、複数の PR が同時に順番待ちしていれば再び当たることもあるので、固定の待ち時間を覚えず、その都度読み直す。

判定と待機時間の計算は `scripts/rate-limit-status.sh [PR番号]` に任せ、自分で分数を読んで計算しない。出力は次の 3 通りである。

- `STATUS=no_limit`
  - 制限メッセージが無く、通常のループへ戻ってよい
- `STATUS=ready`
  - 解除時刻を過ぎているので、そのまま次に進んでよい
- `STATUS=waiting REMAINING_SECONDS=S DEADLINE=...`
  - 解除まで S 秒残っている

解除時刻は分数を経過時間で数えず、そのコメントの `updated_at` を起点に計算する。このコメントは制限に当たるたびに上書きされるため、こうすることでポーリング間隔のずれや何度の待ち直しをまたいでも、常に最新のメッセージから正しく計算し直せる。

分数表示は秒が無く切り捨てられているため、計算した解除時刻は実際より早くなりうる（例: 「10 分後」と表示されて待ったのに、促すと「数秒待て」と返された）。`rate-limit-status.sh` はこの誤差を吸収するため、計算した解除時刻に数分のバッファを足しており、返る `DEADLINE`・`REMAINING_SECONDS` にはすでに反映済みである。

`STATUS=waiting` の間の待ち方と、`STATUS=ready` になってからの動きは次の通りである。

- `REMAINING_SECONDS` だけ `ScheduleWakeup` で待つ
  - 1 回の delaySeconds は 3600 秒が上限なので、残り時間がそれを超える場合は上限いっぱいで一旦起き、`rate-limit-status.sh` を再実行して残り時間を計算し直す
  - この中間ウェイクは `noop: true` にする
  - この待機は SKILL.md の状態表の「待機中」に当たるが、通常のポーリング間隔（360/330/240 秒）ではなく解除時刻ベースで待つ
- 解除時刻を過ぎたら PR コメントとして `@coderabbitai review` を送り、レビューを依頼する
  - 送った直後にもう一度 `rate-limit-status.sh` を実行する
  - 新しい `updated_at` と分数で `STATUS=waiting` に戻っていたら、順番待ちで再び制限に当たったということなので同じ手順で待ち直す
