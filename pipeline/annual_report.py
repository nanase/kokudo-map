"""道路統計年報2025 の県別現況を読み、写し間違いをその場で捕まえる。

`annual_report_2025.csv` は四つの表を持つ。表8 が一般国道、表11 が都道府県道の
計、表12 が主要地方道、表13 が一般都道府県道である。列は四つとも同じなので、
読み方も一つでよい。

台帳を読む側が二人(国道の compare_annual_report.py と、都道府県道の
compare_annual_report_pref.py)になった。写し取った表の検査を両方に置けば、
片方が暗黙のうちに古くなる。ここが唯一の読み口である。

写し取った値が正しいことは、外からは確かめられない。確かめられるのは、表が自分
自身について述べている関係が成り立っているかどうかだけである。四つある。

  1. kind=pref の 47 行と kind=city の 20 行を足すと kind=total の行に一致する
  2. 表11 の各行は、表12 と表13 の同じ行の和である。路線数についても成り立つ
  3. 実延長 = 総延長 - 重用延長 - 未供用延長 - 渡船延長
  4. 実延長 = 現道 + 旧道 + 新道

1 と 2 は写し間違いを、3 と 4 は列の取り違えを捕まえる。どれかが破れたら読み込み
そのものを止める。誤った台帳と突き合わせた結果は、突き合わせていないより悪い。

路線数だけは足せない。数え上げだからである。政令指定都市とその県の両方にまたがる
路線は、二つの行に現れる。表11 で足すと合計を 404 上回る。だから県ごとの路線数は
一つの数ではなく、県の行(下限)と県+政令市(上限)の幅で述べる。
"""
from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import NamedTuple

from regions import PREF_CODE

REPORT_CSV = Path(__file__).with_name("annual_report_2025.csv")

# 表の番号と、その表が数えている道の種別。
TABLES: dict[int, str] = {
    8: "一般国道",
    11: "都道府県道",
    12: "主要地方道",
    13: "一般都道府県道",
}

# 都道府県道の三つの表。表8 は別の種別なので入らない。
PREFECTURAL_TABLES = (11, 12, 13)

LENGTH_COLUMNS = ("total", "concurrent", "unopened", "unopened_sea", "ferry",
                  "actual", "current", "former", "new", "median")


class Row(NamedTuple):
    """台帳の 1 行。

    長さはメートルの整数で持つ。シートの見出しは Km と書くが、セルはメートルで
    入っている。整数のまま持てば、上の四つの関係を厳密に、丸めの許容差なしで
    確かめられる。km が要る側は `km` を読む。

    routes は数え上げなので、None のことがある——表8 は合計の行しか持たない。
    """

    table: int
    kind: str
    code: str
    name: str
    m: dict[str, int]
    routes: int | None

    @property
    def km(self) -> dict[str, float]:
        return {c: v / 1000 for c, v in self.m.items()}


class Prefecture(NamedTuple):
    """1 県ぶんの台帳。県の行と、その県の政令指定都市の行を足した物である。

    地図は道路管理者を区別しない。県道は県が管理していても政令市が管理していても
    同じ県道なので、突き合わせる相手はこの和である。

    路線数だけは足せないので幅で持つ。routes_min は県の行、routes_max は県と
    政令市の和である。政令市の中だけを走る路線は県の行に入らないので前者が下限、
    両方にまたがる路線は二度数えられるので後者が上限になる。
    """

    code: str
    name: str
    region: str
    m: dict[str, int]
    routes_min: int
    routes_max: int

    @property
    def km(self) -> dict[str, float]:
        return {c: v / 1000 for c, v in self.m.items()}


def _rows() -> list[Row]:
    lines = [ln for ln in REPORT_CSV.read_text(encoding="utf-8").splitlines()
             if not ln.startswith("#")]
    out = []
    for r in csv.DictReader(lines):
        out.append(Row(
            table=int(r["table"]),
            kind=r["kind"],
            code=r["code"],
            name=r["name"],
            m={c: int(r[c + "_m"]) for c in LENGTH_COLUMNS},
            routes=int(r["routes"]) if r["routes"] else None,
        ))
    return out


def _fail(message: str) -> None:
    raise SystemExit(f"{REPORT_CSV.name}: {message}")


def _check_totals(rows: list[Row], table: int) -> None:
    parts = [r for r in rows if r.kind in ("pref", "city")]
    stated = [r for r in rows if r.kind == "total"]
    if len(stated) != 1:
        _fail(f"表{table} は kind=total の行を 1 つ持たねばならない({len(stated)} 個)")
    if len(parts) != 67:
        _fail(f"表{table} の県と政令市の行は 47+20 のはずだが {len(parts)} 行ある")
    for col in LENGTH_COLUMNS:
        summed = sum(r.m[col] for r in parts)
        if summed != stated[0].m[col]:
            _fail(f"表{table} の {col} は 67 行で {summed:,} m だが、"
                  f"合計の行は {stated[0].m[col]:,} m と述べる")


def _check_identities(rows: list[Row], table: int) -> None:
    for r in rows:
        expected = r.m["total"] - r.m["concurrent"] - r.m["unopened"] - r.m["ferry"]
        if expected != r.m["actual"]:
            _fail(f"表{table} {r.name}: 総延長 - 重用 - 未供用 - 渡船 = "
                  f"{expected:,} m だが、実延長は {r.m['actual']:,} m である")
        parts = r.m["current"] + r.m["former"] + r.m["new"]
        if parts != r.m["actual"]:
            _fail(f"表{table} {r.name}: 現道 + 旧道 + 新道 = {parts:,} m だが、"
                  f"実延長は {r.m['actual']:,} m である")


def _check_decomposition(by_table: dict[int, list[Row]]) -> None:
    """表11 = 表12 + 表13。行ごと、列ごと、路線数についても。"""
    key = lambda r: (r.kind, r.code, r.name)  # noqa: E731
    index = {t: {key(r): r for r in by_table[t]} for t in PREFECTURAL_TABLES}
    if not (set(index[11]) == set(index[12]) == set(index[13])):
        _fail("表11・表12・表13 の行が揃っていない")
    for k, whole in index[11].items():
        for col in LENGTH_COLUMNS:
            parts = index[12][k].m[col] + index[13][k].m[col]
            if parts != whole.m[col]:
                _fail(f"{whole.name} の {col}: 表12 + 表13 = {parts:,} m だが、"
                      f"表11 は {whole.m[col]:,} m と述べる")
        routes = (index[12][k].routes or 0) + (index[13][k].routes or 0)
        if routes != whole.routes:
            _fail(f"{whole.name} の路線数: 表12 + 表13 = {routes} だが、"
                  f"表11 は {whole.routes} と述べる")


@lru_cache(maxsize=1)
def load() -> dict[int, list[Row]]:
    """表の番号ごとの行。読み込みのたびに上の四つの関係を確かめる。"""
    by_table: dict[int, list[Row]] = {t: [] for t in TABLES}
    for row in _rows():
        if row.table not in by_table:
            _fail(f"知らない表の番号 {row.table}")
        by_table[row.table].append(row)
    for table, rows in by_table.items():
        _check_totals(rows, table)
        _check_identities(rows, table)
    _check_decomposition(by_table)
    return by_table


def total(table: int) -> Row:
    """その表の合計の行。"""
    return next(r for r in load()[table] if r.kind == "total")


@lru_cache(maxsize=len(TABLES))
def prefectures(table: int) -> dict[str, Prefecture]:
    """地域名 -> 1 県ぶんの台帳。県の行に、その県の政令指定都市の行を足す。

    政令市の符号は県の符号で始まる(0110 札幌市 は 01 北海道)ので、対応は前二桁で
    決まる。regions.PREF_CODE が符号から地域名を与える。
    """
    pref = {r.code: r for r in load()[table] if r.kind == "pref"}
    cities: dict[str, list[Row]] = {code: [] for code in pref}
    for r in load()[table]:
        if r.kind == "city":
            cities[r.code[:2]].append(r)
    out = {}
    for code, r in pref.items():
        own = cities[code]
        metres = {c: r.m[c] + sum(x.m[c] for x in own) for c in LENGTH_COLUMNS}
        low = r.routes or 0
        out[PREF_CODE[code]] = Prefecture(
            code=code, name=r.name, region=PREF_CODE[code], m=metres,
            routes_min=low, routes_max=low + sum(x.routes or 0 for x in own))
    return out
