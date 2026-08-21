#!/usr/bin/env bash
# read-reviews.sh — PR レビューの 3 所在をまとめて出力する。判定は pr-review-loop スキルが行う。
#
# 使い方: read-reviews.sh [PR番号]
#   PR 番号を省略すると現在のブランチの PR を使う。出力は 3 区画:
#     1. review 本文 — CodeRabbit は nitpick を本文内の <details> に畳む。区画内にそのまま出るので開いて読む。
#     2. インラインコメント — path:line と id。返信は reply.sh にこの id を渡す。
#     3. サマリ / PR コメント — 先頭サマリは上書き更新されるので毎回読み直す。
set -euo pipefail

R="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
PR="${1:-$(gh pr view --json number -q .number)}"

# PR 番号は API パスに埋め込むため数値のみ許可する。
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "PR 番号は数値で渡してください（現在: $PR）" >&2; exit 2; }

# 空ボディの review（approval / changes requested）も出す。最新レビューが HEAD を対象か
# 判定するのに state・commit_id・submitted_at が要るので、body の有無で絞らない。
echo "=== 1. review 本文（PR review の body） ==="
gh api "repos/$R/pulls/$PR/reviews" --paginate \
  --jq '.[] | "--- [\(.user.login) / \(.state)] id:\(.id) commit:\(.commit_id[0:7]) at:\(.submitted_at)\n\(.body // "")\n"'

echo "=== 2. インラインコメント（コード行に付く） ==="
gh api "repos/$R/pulls/$PR/comments" --paginate \
  --jq '.[] | "--- \(.user.login) @ \(.path):\(.line // .original_line) id:\(.id)\n\(.body)\n"'

echo "=== 3. サマリ / PR コメント ==="
gh api "repos/$R/issues/$PR/comments" --paginate \
  --jq '.[] | "--- \(.user.login) id:\(.id)\n\(.body)\n"'
