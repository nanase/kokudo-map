#!/usr/bin/env bash
# その時点のラベル定義（名前・説明・色）を一覧する。判定は label-apply スキルが行う。
set -euo pipefail
gh label list --limit 200
