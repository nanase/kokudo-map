#!/usr/bin/env bash
# reply.sh — インラインレビューコメントのスレッドへ返信する。返信先は read-reviews.sh の id。
#
# 使い方: reply.sh <comment_id> <本文> [PR番号]
#   comment_id は read-reviews.sh の「インラインコメント」区画の id。
#   PR 番号を省略すると現在のブランチの PR を使う。投稿した返信の URL を出す。
set -euo pipefail

CID="${1:?comment_id を渡してください（read-reviews.sh の id）}"
BODY="${2:?返信本文を渡してください}"
R="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
PR="${3:-$(gh pr view --json number -q .number)}"

# CID・PR は API パスに埋め込むため数値のみ許可する（誤エンドポイント・パス注入を防ぐ）。
[[ "$CID" =~ ^[0-9]+$ ]] || { echo "comment_id は数値で渡してください（現在: $CID）" >&2; exit 2; }
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "PR 番号は数値で渡してください（現在: $PR）" >&2; exit 2; }

gh api "repos/$R/pulls/$PR/comments/$CID/replies" -f body="$BODY" --jq '.html_url'
