# /// script
# requires-python = ">=3.12"
# dependencies = ["requests"]
# ///
"""nanase.cc ゾーンの、配信の挙動を決めるキャッシュ関連設定を取得・記録し、
記録した内容をゾーンへ当て直す。

設定は元々ダッシュボードにしか無く、手で当てていた。書いた本人以外は差分を知る
術が無い。ここで取得したものを pipeline/cf-cache.json に残し、実態との差を機械
的に見えるようにし、そのファイルを正としてゾーンへ当てられるようにする。

対象は「配信の挙動を決めるキャッシュ関連」に絞る。DNS・SSL・R2 のカスタム
ドメインは対象外である。

  1. Cache Rules(`http_request_cache_settings` フェーズ)
  2. ゾーン設定のうち、キャッシュの挙動に効く一部(ZONE_SETTINGS)

正規化が肝心である。API は `id`・`version`・`last_updated`・`ref` のような、
こちらが決めていない揮発的なフィールドを返す。落とさずに書き出すと、設定を
変えていなくても実行のたび差分が出て、差分検出が役に立たなくなる。Cache Rules
は式・アクション・有効無効だけを残す。ゾーン設定はキャッシュに効く項目だけを
選ぶ。選定理由は ZONE_SETTINGS のコメントにある。

適用は本番ゾーンを書き換える。既定では決して書かない。`--apply` を明示させ、
何がどう変わるかを表示し、人が合言葉を打ち込んで初めて書く。消えるルールが
あるときは `--allow-delete` も要求する。理由は apply() のコメントにある。

使い方:
    uv run pipeline/cf_cache.py           # 取得し、ファイルへ書き出して表示する
    uv run pipeline/cf_cache.py --diff    # 取得し、ファイルとの差分だけを出す(書かない)
    uv run pipeline/cf_cache.py --apply   # ファイルの内容をゾーンへ当てる(確認を挟む)
    uv run pipeline/cf_cache.py --apply --allow-delete   # 消えるルールがあっても進む
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

CACHE_RULES_PATH = "/rulesets/phases/http_request_cache_settings/entrypoint"

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

# 記録はするが当てない項目と、その理由。ZONE_SETTINGS が「記録する項目」で、
# そこからこれらを引いたものが「当てる項目」になる。両者は意図してずらしてある。
#
# ずれていること自体は知りたいので、記録からは外さない。差分には出しつつ、
# 書き込みの対象からだけ外す。
UNWRITABLE_ZONE_SETTINGS = {
    # 設定ではなく一時的な状態である。誰かが調査のために有効にしている最中に
    # 書き戻せば、断りなく無効化してしまう。逆に記録が古ければ、誰も望んで
    # いないのに有効化してしまう。どちらもこちらが決めてよいことではない。
    "development_mode": "一時的な状態であって設定ではないため",
    # このゾーンの契約では読み取り専用で、PATCH が code 1015(Not allowed to
    # edit zone setting)を返す。同じ値であっても拒まれる。試みると、そこまでの
    # 書き込みだけが済んだ状態で落ちる。当てられない物は初めから当てない。
    "sort_query_string_for_cache": "このゾーンの契約では API が編集を拒むため(code 1015)",
}

# 当てる対象。ZONE_SETTINGS の並び順をそのまま引き継ぐ。
WRITABLE_ZONE_SETTINGS = [k for k in ZONE_SETTINGS if k not in UNWRITABLE_ZONE_SETTINGS]


def creds() -> tuple[str, str]:
    """環境変数からトークンとゾーン ID を読む。無ければ理由を述べて落ちる。"""
    token = os.environ.get(TOKEN_ENV)
    zone_id = os.environ.get(ZONE_ID_ENV)
    missing = [n for n, v in ((TOKEN_ENV, token), (ZONE_ID_ENV, zone_id)) if not v]
    if missing:
        sys.exit(f"環境変数 {', '.join(missing)} が無い。設定してから実行する。")
    return token, zone_id


def hide_zone(path: str) -> str:
    """人に見せる文字列からゾーン ID を伏せる。

    API のパスにはゾーン ID が入る。失敗の内容は issue や PR に貼られる物なので、
    mise.local.toml にしか無い値がそこへ混ざらないようにする。
    """
    zone_id = os.environ.get(ZONE_ID_ENV)
    return path.replace(zone_id, "<zone>") if zone_id else path


def call(method: str, path: str, token: str, payload: dict | None = None) -> dict:
    """Cloudflare API を叩き、`result` を返す。

    HTTP の状態番号より先に本文を見る。Cloudflare は失敗の理由を本文の `errors`
    に入れるので、`raise_for_status` だけでは「400 だった」しか分からない。
    書き込みが失敗したときに、何が悪かったのかをそのまま出したい。
    """
    r = requests.request(
        method,
        f"{API}{path}",
        headers={"Authorization": f"Bearer {token}"},
        json=payload,
        timeout=30,
    )
    where = f"{method} {hide_zone(path)}"
    try:
        body = r.json()
    except ValueError:
        r.raise_for_status()
        sys.exit(f"Cloudflare API の応答が JSON でない({where}): {r.text[:200]}")
    if not body.get("success"):
        sys.exit(f"Cloudflare API が失敗した({where}): {body.get('errors')}")
    return body["result"]


def get(path: str, token: str) -> dict:
    """Cloudflare API を GET し、`result` を返す。"""
    return call("GET", path, token)


def normalize_rule(rule: dict) -> dict:
    """1 本のルールから、こちらが決めている値だけを残す。

    `id`・`version`・`last_updated`・`ref` は揮発的なフィールドで、内容を変えて
    いなくても値が変わりうる。
    """
    return {
        "description": rule.get("description", ""),
        "expression": rule["expression"],
        "action": rule.get("action", "set_cache_settings"),
        "action_parameters": rule.get("action_parameters", {}),
        "enabled": rule.get("enabled", True),
    }


def fetch_rules_raw(zone_id: str, token: str) -> list[dict]:
    """Cache Rules を API が返したまま取る。id が要る適用側だけが使う。

    順序はルールの優先順位そのものなので保つ。
    """
    result = get(f"/zones/{zone_id}{CACHE_RULES_PATH}", token)
    return result.get("rules", [])


def fetch_cache_rules(zone_id: str, token: str) -> list[dict]:
    """Cache Rules の式・アクションだけを残す。"""
    return [normalize_rule(rule) for rule in fetch_rules_raw(zone_id, token)]


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


# ---- 適用 -------------------------------------------------------------------


def rule_keys(rules: list[dict]) -> list[str]:
    """ファイル側と実態側のルールを突き合わせる鍵を作る。

    鍵は description である。ルールに人が付けた唯一の名前で、順序と違って途中に
    1 本挿しただけでは動かない。同じ description が複数あっても取り違えないよう、
    その中の何番目かを添える。
    """
    seen: dict[str, int] = {}
    keys = []
    for rule in rules:
        desc = rule.get("description", "")
        seen[desc] = seen.get(desc, 0) + 1
        keys.append(desc if seen[desc] == 1 else f"{desc} #{seen[desc]}")
    return keys


def plan_rules(saved: list[dict], live: list[dict]) -> dict:
    """ファイルを当てたときに Cache Rules がどう変わるかを組み立てる。

    entrypoint の PUT は配列ごと置き換えるので、ファイルに無いルールは消える。
    `removed` はその「黙って消える物」であり、これを人へ見せることがこの関数の
    主な目的である。
    """
    saved_by = dict(zip(rule_keys(saved), saved, strict=True))
    live_by = dict(zip(rule_keys(live), live, strict=True))
    kept = [k for k in saved_by if k in live_by]
    return {
        "added": [(k, saved_by[k]) for k in saved_by if k not in live_by],
        "removed": [(k, live_by[k]) for k in live_by if k not in saved_by],
        "changed": [(k, live_by[k], saved_by[k]) for k in kept if live_by[k] != saved_by[k]],
        # 順序は優先順位そのものなので、中身が同じでも並びが変われば挙動が変わる。
        "reordered": kept != [k for k in live_by if k in saved_by],
    }


def indent(rule: dict) -> str:
    """ルール 1 本を、読める形に字下げして返す。"""
    body = json.dumps(rule, ensure_ascii=False, indent=2, sort_keys=True)
    return "\n".join("    " + line for line in body.splitlines())


def rule_diff(before: dict, after: dict) -> str:
    """1 本のルールの、変わった行だけを出す。"""

    def lines(rule: dict) -> list[str]:
        text = json.dumps(rule, ensure_ascii=False, indent=2, sort_keys=True)
        return text.splitlines(keepends=True)

    delta = difflib.unified_diff(
        lines(before), lines(after), fromfile="実際の設定", tofile="ファイル", n=1
    )
    return "".join("    " + line for line in delta).rstrip("\n")


def render_plan(plan: dict, settings: list[tuple], live_settings: dict) -> str:
    """何が変わるかを人が読める形にする。書く前に必ずこれを出す。"""
    out = ["", "== Cache Rules =="]
    if plan["removed"]:
        out.append("")
        out.append(f"  !! 消えるルールが {len(plan['removed'])} 本ある !!")
        out.append("  ファイルに無いルールは、当てた時点で失われる。")
        for key, rule in plan["removed"]:
            out.append(f"  - 消える: {key}")
            out.append(indent(rule))
        out.append("")
    for key, rule in plan["added"]:
        out.append(f"  + 増える: {key}")
        out.append(indent(rule))
    for key, before, after in plan["changed"]:
        out.append(f"  * 変わる: {key}")
        out.append(rule_diff(before, after))
    if plan["reordered"]:
        out.append("  * 並び順が変わる(並び順はそのまま優先順位である)")
    if not any((plan["removed"], plan["added"], plan["changed"], plan["reordered"])):
        out.append("  変更なし(同じ内容を当て直す)")

    out.append("")
    out.append("== ゾーン設定 ==")
    for key, before, after in settings:
        out.append(f"  * {key}: {before} -> {after}")
    if not settings:
        out.append("  変更なし(同じ値を当て直す)")
    for key, why in UNWRITABLE_ZONE_SETTINGS.items():
        out.append(f"  {key} は当てない(実際の値は {live_settings[key]})。{why}。")
    out.append("")
    return "\n".join(out)


def rules_payload(saved: list[dict], live_raw: list[dict]) -> list[dict]:
    """PUT で送るルール配列を作る。既にある物には実態から引いた id を添える。

    id は記録(cf-cache.json)には入れない。Cloudflare が決める揮発的な値で、
    記録に入れると設定を変えていなくても差分が出て、差分検出が役に立たなくなる。
    かといって送らないと、ルールは毎回作り直されて id が変わる。動作は同じでも
    Cloudflare 側の履歴が毎回「全消し・全作成」に見え、いつ何が変わったのかを
    後から追えなくなる。そこで、記録には入れず、当てるときだけ実態から引く。

    突き合わせは rule_keys すなわち description で行う。取り違えても、出来上がる
    ルールセットの中身はファイルと一致する。id はどの既存ルールを使い回すかを
    決めるだけで、ルールの内容には効かないからである。
    """
    live_ids = dict(zip(rule_keys(live_raw), (r.get("id") for r in live_raw), strict=True))
    payload = []
    for key, rule in zip(rule_keys(saved), saved, strict=True):
        item = dict(rule)
        if live_ids.get(key):
            item["id"] = live_ids[key]
        payload.append(item)
    return payload


def confirm(phrase: str) -> None:
    """合言葉を打ち込ませる。打たれなければ書かない。

    端末かどうかは見ない。`echo apply |` のように意図して流し込む形は認める。
    見ているのは「その合言葉が来たかどうか」だけである。何も来なければ(EOF)、
    上に出した計画を読ませただけで終わる。これがそのまま dry run になる。
    """
    print(f"適用してよければ {phrase} と入力する(それ以外は中止): ", end="", flush=True)
    try:
        answer = input().strip()
    except EOFError:
        sys.exit("\n入力が無かったので中止した。何も書いていない。")
    if answer != phrase:
        sys.exit("中止した。何も書いていない。")


def apply(allow_delete: bool) -> None:
    """cf-cache.json の内容を実際のゾーンへ当てる。

    本番ゾーンしかないので、事故が起きない形を速さより優先する。関門は 3 つ
    ある。`--apply` の明示、何が変わるかの表示、合言葉の入力である。消える
    ルールがあるときは、`--allow-delete` が無ければそこで止める。ダッシュボード
    で足したルールが記録から漏れていると、当てた瞬間に黙って消えるためで、実際
    に `.mjs` のルールが記録から漏れていたことがある。
    """
    if not OUT.is_file():
        sys.exit(f"{OUT} が無い。先に `uv run pipeline/cf_cache.py` で取得する。")
    saved = json.loads(OUT.read_text(encoding="utf-8"))
    saved_rules = saved["cache_rules"]
    saved_settings = saved["zone_settings"]
    missing = [k for k in WRITABLE_ZONE_SETTINGS if k not in saved_settings]
    if missing:
        sys.exit(f"{OUT} に {', '.join(missing)} が無い。先に取得し直す。")

    token, zone_id = creds()
    live_raw = fetch_rules_raw(zone_id, token)
    live_settings = fetch_zone_settings(zone_id, token)

    plan = plan_rules(saved_rules, [normalize_rule(rule) for rule in live_raw])
    settings_plan = [
        (key, live_settings[key], saved_settings[key])
        for key in WRITABLE_ZONE_SETTINGS
        if live_settings[key] != saved_settings[key]
    ]
    print(render_plan(plan, settings_plan, live_settings))

    if plan["removed"] and not allow_delete:
        sys.exit(
            f"消えるルールが {len(plan['removed'])} 本あるので中止した。何も書いていない。\n"
            "ダッシュボードで足したルールが記録から漏れていないか、まず確かめる。\n"
            "残すなら `uv run pipeline/cf_cache.py` で取り直す。消してよいと分かって\n"
            "いるなら --allow-delete を添えて実行し直す。"
        )

    # 消えるルールがあるときは合言葉を変える。同じ言葉だと、いつもの手つきで
    # 打ってしまう。
    confirm("delete" if plan["removed"] else "apply")

    call(
        "PUT",
        f"/zones/{zone_id}{CACHE_RULES_PATH}",
        token,
        {"rules": rules_payload(saved_rules, live_raw)},
    )
    print("Cache Rules を当てた。")
    for key in WRITABLE_ZONE_SETTINGS:
        call("PATCH", f"/zones/{zone_id}/settings/{key}", token, {"value": saved_settings[key]})
        print(f"ゾーン設定 {key} を当てた。")

    # 当てた結果を取り直し、ファイルと一致することをその場で確かめる。
    after = {
        "cache_rules": fetch_cache_rules(zone_id, token),
        "zone_settings": fetch_zone_settings(zone_id, token),
    }
    if render(after) == OUT.read_text(encoding="utf-8"):
        print("実際の設定はファイルと一致している。")
        return
    print("当てたが、実際の設定がファイルと一致しない。`--diff` で確かめる。")
    sys.exit(1)


ARGV_FORMS = ([], ["--diff"], ["--apply"], ["--apply", "--allow-delete"])


def main() -> None:
    sys.stdout.reconfigure(errors="replace")
    argv = sys.argv[1:]
    # 誤入力(例: --dif)を pull() に流すと、比較の基準である OUT を無言で
    # 上書きしてしまう。認める形を数え上げ、それ以外は受け取らない。
    if argv not in ARGV_FORMS:
        sys.exit(
            f"知らない引数: {' '.join(argv)}。"
            "使えるのは 無し / --diff / --apply / --apply --allow-delete である。"
        )
    if argv == ["--diff"]:
        diff()
    elif argv[:1] == ["--apply"]:
        apply(allow_delete="--allow-delete" in argv)
    else:
        pull()


if __name__ == "__main__":
    main()
