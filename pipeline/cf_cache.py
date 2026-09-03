# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
"""nanase.cc ゾーンの、配信の挙動を決めるキャッシュ関連設定を取得し、正規化して
pipeline/cf-cache.json へ書き出す。

設定は今ダッシュボードにしか無く、手で当てている。書いた本人以外は差分を知る
術が無い。ここで取得したものをファイルに残し、実態との差を機械的に見えるように
する。書き込み(適用)は扱わない。読み取りと記録だけである。

対象は「配信の挙動を決めるキャッシュ関連」に絞る。DNS・SSL・R2 のカスタム
ドメインは対象外である。

  1. Cache Rules(`http_request_cache_settings` フェーズ)
  2. ゾーン設定のうち、キャッシュの挙動に効く一部(ZONE_SETTINGS)

正規化が肝心である。API は `id`・`version`・`last_updated`・`ref` のような、
こちらが決めていない揮発的なフィールドを返す。落とさずに書き出すと、設定を
変えていなくても実行のたび差分が出て、差分検出が役に立たなくなる。Cache Rules
は式・アクション・有効無効だけを残す。ゾーン設定はキャッシュに効く項目だけを
選ぶ。選定理由は ZONE_SETTINGS のコメントにある。

使い方:
    uv run pipeline/cf_cache.py          # 取得し、ファイルへ書き出して表示する
    uv run pipeline/cf_cache.py --diff   # 取得し、ファイルとの差分だけを出す(書かない)
"""
from __future__ import annotations

import difflib
import json
import os
import sys

import requests

from _paths import ROOT, write_atomic

API = "https://api.cloudflare.com/client/v4"
OUT = ROOT / "pipeline" / "cf-cache.json"

# トークンの環境変数名はここ 1 箇所だけで決める。CLOUDFLARE_API_TOKEN という
# 名前は使わない。その名前があると wrangler が OAuth ログインより優先して読み、
# このトークンには R2 権限が無いため `mise run publish-data` が壊れる。
TOKEN_ENV = "CLOUDFLARE_CACHE_CONFIG_TOKEN"
ZONE_ID_ENV = "CLOUDFLARE_ZONE_ID"

# キャッシュの挙動に効くゾーン設定だけを対象にする。他の設定(DNS・SSL・
# パフォーマンス系の大半)は範囲外なので含めない。
ZONE_SETTINGS = [
    # 今回の不具合の出どころ。ブラウザ向けの TTL を、origin が返す
    # cache-control より優先して被せる。
    "browser_cache_ttl",
    # エッジでのキャッシュ判定の粒度(基本 / クエリ文字列を無視して集約 等)。
    "cache_level",
    # 有効だとエッジ・ブラウザともキャッシュを迂回して origin へ直接向く。
    # 誤って有効化されたままになっていないかを、ここで検知できるようにする。
    "development_mode",
    # クエリ文字列の並び順の違いだけでキャッシュキーが割れるのを防ぐか。
    "sort_query_string_for_cache",
]


def creds() -> tuple[str, str]:
    """環境変数からトークンとゾーン ID を読む。無ければ理由を述べて落ちる。"""
    token = os.environ.get(TOKEN_ENV)
    zone_id = os.environ.get(ZONE_ID_ENV)
    missing = [n for n, v in ((TOKEN_ENV, token), (ZONE_ID_ENV, zone_id)) if not v]
    if missing:
        sys.exit(f"環境変数 {', '.join(missing)} が無い。設定してから実行する。")
    return token, zone_id


def get(path: str, token: str) -> dict:
    """Cloudflare API を GET し、`result` を返す。"""
    r = requests.get(f"{API}{path}", headers={"Authorization": f"Bearer {token}"}, timeout=30)
    r.raise_for_status()
    body = r.json()
    if not body.get("success"):
        sys.exit(f"Cloudflare API が失敗した: {body.get('errors')}")
    return body["result"]


def fetch_cache_rules(zone_id: str, token: str) -> list[dict]:
    """Cache Rules の式・アクションだけを残す。

    `id`・`version`・`last_updated` はルールセット自身の、`id`・`version`・
    `last_updated`・`ref` は各ルールの揮発的なフィールドで、内容を変えなくても
    値が変わりうる。順序はルールの優先順位そのものなので保つ。
    """
    result = get(
        f"/zones/{zone_id}/rulesets/phases/http_request_cache_settings/entrypoint",
        token,
    )
    return [
        {
            "description": rule.get("description", ""),
            "expression": rule["expression"],
            "action": rule.get("action", "set_cache_settings"),
            "action_parameters": rule.get("action_parameters", {}),
            "enabled": rule.get("enabled", True),
        }
        for rule in result.get("rules", [])
    ]


def fetch_zone_settings(zone_id: str, token: str) -> dict:
    """`ZONE_SETTINGS` に挙げた項目だけを `{id: value}` で返す。"""
    result = get(f"/zones/{zone_id}/settings", token)
    by_id = {item["id"]: item["value"] for item in result}
    missing = [k for k in ZONE_SETTINGS if k not in by_id]
    if missing:
        sys.exit(f"ゾーン設定に {', '.join(missing)} が無い。プランや権限を確認する。")
    return {k: by_id[k] for k in ZONE_SETTINGS}


def fetch() -> dict:
    """Cache Rules とゾーン設定をまとめて取得する。"""
    token, zone_id = creds()
    return {
        "cache_rules": fetch_cache_rules(zone_id, token),
        "zone_settings": fetch_zone_settings(zone_id, token),
    }


def render(doc: dict) -> str:
    """書き出し用に整形する。key を並べ替えるのは差分を安定させるため。"""
    return json.dumps(doc, ensure_ascii=False, indent=2, sort_keys=True) + "\n"


def pull() -> None:
    """取得してファイルへ書き出し、書いた内容を表示する。"""
    text = render(fetch())
    write_atomic(OUT, text)
    print(text, end="")


def diff() -> None:
    """ファイルを書き換えず、実際の設定との差分だけを出す。"""
    if not OUT.is_file():
        sys.exit(f"{OUT} が無い。先に `uv run pipeline/cf_cache.py` で取得する。")
    saved = OUT.read_text(encoding="utf-8")
    current = render(fetch())
    delta = list(
        difflib.unified_diff(
            saved.splitlines(keepends=True),
            current.splitlines(keepends=True),
            fromfile=str(OUT.relative_to(ROOT)),
            tofile="実際の設定",
        )
    )
    if not delta:
        print("差分無し")
        return
    sys.stdout.writelines(delta)
    sys.exit(1)


def main() -> None:
    sys.stdout.reconfigure(errors="replace")
    argv = sys.argv[1:]
    # 誤入力(例: --dif)を pull() に流すと、比較の基準である OUT を無言で
    # 上書きしてしまう。無し・--diff の 2 通りだけを認める。
    if argv not in ([], ["--diff"]):
        sys.exit(f"知らない引数: {' '.join(argv)}。使えるのは無しか --diff だけである。")
    if argv == ["--diff"]:
        diff()
    else:
        pull()


if __name__ == "__main__":
    main()
