#!/usr/bin/env bash
# rate-limit-status.sh — CodeRabbit のレート制限（Review limit reached）の解除待ちを判定する。
#
# 使い方: rate-limit-status.sh [PR番号]
#   PR 番号を省略すると現在のブランチの PR を使う。
#
# サマリ（PR 先頭コメント）は制限に当たるたびに上書き更新され、"Next review
# available in: **N minutes**" のような分数が出る。解除時刻は経過時間で数えず、
# 常にそのコメントの updated_at を起点に計算し直す（何度待ち直しても正確）。
#
# 出力（標準出力、key=value）:
#   STATUS=no_limit                                  制限メッセージが無い。通常のループへ
#   STATUS=ready   MINUTES=N UPDATED_AT=...           解除時刻を過ぎている。促してよい
#   STATUS=waiting REMAINING_SECONDS=S DEADLINE=... MINUTES=N UPDATED_AT=...
#                                                      解除時刻まで S 秒残っている
set -euo pipefail

R="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
PR="${1:-$(gh pr view --json number -q .number)}"

# PR 番号は API パスに埋め込むため数値のみ許可する。
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "PR 番号は数値で渡してください（現在: $PR）" >&2; exit 2; }

# 制限メッセージを含むコメントのうち最新（updated_at 最大）のものを 1 件選ぶ。
# 同じコメントが繰り返し上書きされるため、複数該当しても最新だけを見ればよい。
LATEST="$(gh api "repos/$R/issues/$PR/comments" --paginate --jq '
  [.[] | select(.body | contains("Review limit reached"))]
  | sort_by(.updated_at)
  | last
  | if . == null then empty else "\(.updated_at)\t\(.body | @base64)" end
')"

if [[ -z "$LATEST" ]]; then
  echo "STATUS=no_limit"
  exit 0
fi

UPDATED_AT="${LATEST%%$'\t'*}"
BODY="$(echo "${LATEST#*$'\t'}" | base64 -d)"

# 例: "**Next review available in:** **43 minutes**"
RE='Next review available in:\*\*[[:space:]]*\*\*([0-9]+)[[:space:]]*minutes?\*\*'
if [[ ! "$BODY" =~ $RE ]]; then
  echo "レート制限メッセージは見つかりましたが分数を抽出できませんでした。コメントの文言が変わっていないか確認してください。" >&2
  exit 2
fi
MINUTES="${BASH_REMATCH[1]}"

DEADLINE_EPOCH="$(date -u -d "$UPDATED_AT + ${MINUTES} minutes" +%s)"
NOW_EPOCH="$(date -u +%s)"
REMAINING=$((DEADLINE_EPOCH - NOW_EPOCH))

if (( REMAINING <= 0 )); then
  echo "STATUS=ready"
  echo "MINUTES=$MINUTES"
  echo "UPDATED_AT=$UPDATED_AT"
else
  echo "STATUS=waiting"
  echo "REMAINING_SECONDS=$REMAINING"
  echo "DEADLINE=$(date -u -d "@$DEADLINE_EPOCH" --iso-8601=seconds)"
  echo "MINUTES=$MINUTES"
  echo "UPDATED_AT=$UPDATED_AT"
fi
