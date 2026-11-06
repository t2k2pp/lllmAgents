# -*- coding: utf-8 -*-
"""手本: 角のある物・乗り物・建物（机・剣・家・車・船・江戸の町家）。部品箱 bkit の box / cylinder / prism / hull / cut / join の使い方。

  blender -b --python objects.py -- <出力フォルダ> [table|sword|house|car|boat|machiya]

考え方:
  - 実物を部品に分け、部品ごとに寸法（m）を表に書いてから置く。
  - 角は少し丸める（Bevel）。穴・窓・戸口・車輪の切り欠きは cut で引く。くり返しは repeat、左右は mirror_x。
  - 流れる形（船体・車体の丸み）は hull。正面・横から見た形が大事な物は prism（多角形の押し出し）。
新しい物は build_xxx() を書いて KINDS に足す。建物の様式（江戸・昭和・ファンタジー・城）は ../styles.md。
"""
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bkit import box, clear_scene, cut, cylinder, export, gable_roof, hull, join, material, measure, mirror_x, prism, render_views, repeat, shed_roof, sphere  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_DIR = argv[0] if argv else os.path.join(os.path.expanduser("~"), "blender_out")
KIND = argv[1] if len(argv) > 1 else "table"


def build_table():
    """木の机（幅 1.2 × 奥行き 0.7 × 高さ 0.72m）。天板・幕板・脚 4 本。"""
    wood = material("Wood", (0.45, 0.28, 0.15, 1), roughness=0.6)
    w, d, h, top_t, leg = 1.2, 0.7, 0.72, 0.03, 0.05
    parts = [box("Top", (w, d, top_t), (0, 0, h - top_t / 2), wood, bevel=0.004)]
    for sx in (-1, 1):
        for sy in (-1, 1):
            parts.append(box("Leg", (leg, leg, h - top_t), (sx * (w / 2 - 0.06), sy * (d / 2 - 0.06), (h - top_t) / 2), wood, 0.003))
    ah = 0.08
    for sy in (-1, 1):
        parts.append(box("ApronL", (w - 0.17, 0.02, ah), (0, sy * (d / 2 - 0.06), h - top_t - ah / 2), wood, 0.002))
    for sx in (-1, 1):
        parts.append(box("ApronS", (0.02, d - 0.17, ah), (sx * (w / 2 - 0.06), 0, h - top_t - ah / 2), wood, 0.002))
    return join(parts, "Table")


def build_sword():
    """片手剣（全長 0.95m）。刃は正面の形を押し出す（prism XZ）。"""
    steel = material("Steel", (0.75, 0.76, 0.78, 1), metallic=1.0, roughness=0.25)
    leather = material("Leather", (0.25, 0.13, 0.07, 1), roughness=0.8)
    gold = material("Gold", (0.83, 0.62, 0.22, 1), metallic=1.0, roughness=0.3)
    blade_len, bw, z0 = 0.72, 0.05, 0.23
    outline = [(-bw / 2, 0), (bw / 2, 0), (bw / 2 * 0.8, blade_len * 0.85), (0, blade_len), (-bw / 2 * 0.8, blade_len * 0.85)]
    parts = [
        prism("Blade", outline, 0.006, (0, 0, z0), steel, plane="XZ", bevel=0.0015),
        box("Guard", (0.2, 0.03, 0.025), (0, 0, z0 - 0.0125), gold, bevel=0.006),
        cylinder("Grip", 0.016, 0.16, (0, 0, z0 - 0.105), leather, bevel=0.002),
        sphere("Pommel", 0.028, (0, 0, z0 - 0.205), gold),
    ]
    return join(parts, "Sword")


def build_house():
    """小さな家（4 × 5m・切妻屋根）。窓と戸口は cut で抜く。"""
    wall = material("Wall", (0.85, 0.82, 0.74, 1), roughness=0.9)
    roof_m = material("Roof", (0.30, 0.18, 0.15, 1), roughness=0.7)
    trim = material("Trim", (0.35, 0.24, 0.16, 1), roughness=0.6)
    glass = material("Glass", (0.25, 0.35, 0.45, 1), roughness=0.05)
    w, d, h, t = 4.0, 5.0, 2.8, 0.2
    body = box("Body", (w, d, h), (0, 0, h / 2), wall, bevel=0.02)
    cut(body, box("c_door", (1.0, 0.6, 2.0), (0, -d / 2, 1.0), bevel=0))
    for x in (-1.2, 1.2):
        cut(body, box("c_win", (0.9, 0.6, 0.9), (x, -d / 2, 1.6), bevel=0))
    for y in (-1.2, 1.2):
        cut(body, box("c_win", (0.6, 0.9, 0.9), (w / 2, y, 1.6), bevel=0))
    parts = [body]
    for x in (-1.2, 1.2):
        parts.append(box("Glass", (0.9, 0.02, 0.9), (x, -d / 2 + t / 2, 1.6), glass, bevel=0))
        parts.append(box("Sill", (1.1, 0.12, 0.05), (x, -d / 2 - 0.04, 1.13), trim, bevel=0.01))
    for y in (-1.2, 1.2):
        parts.append(box("Glass", (0.02, 0.9, 0.9), (w / 2 - t / 2, y, 1.6), glass, bevel=0))
    parts.append(box("Door", (0.95, 0.05, 1.95), (0, -d / 2 + 0.12, 0.975), trim, bevel=0.01))
    # 切妻屋根（棟は Y 向き＝正面に三角の妻）。傾ける計算は gable_roof に任せる
    parts += gable_roof("Roof", w, d, h, 35, roof_m, ridge="Y", overhang=0.3, wall_mat=wall)
    return join(parts, "House")


def build_car():
    """乗用車（全長 4.5 × 幅 1.8 × 高さ 1.45m・前 -Y）。車体は横から見た形の押し出し（prism YZ）、
    窓まわりは台形の押し出し、車輪の切り欠きは cut、車輪は寝かせた円柱。"""
    paint = material("Paint", (0.60, 0.08, 0.08, 1), metallic=0.6, roughness=0.3)
    glass = material("Glass", (0.10, 0.13, 0.16, 1), roughness=0.05)
    tire = material("Tire", (0.05, 0.05, 0.05, 1), roughness=0.9)
    rim = material("Rim", (0.7, 0.7, 0.72, 1), metallic=1.0, roughness=0.3)
    light = material("Light", (0.95, 0.92, 0.8, 1), roughness=0.1)
    L, W, wheel_r, wb = 4.5, 1.8, 0.33, 2.7  # 全長・幅・タイヤ半径・ホイールベース
    side = [(-2.25, 0.30), (-2.25, 0.62), (-2.0, 0.78), (-0.9, 0.86), (1.4, 0.90), (2.2, 0.85), (2.25, 0.55), (2.2, 0.30)]
    body = prism("Body", side, W, (0, 0, 0), paint, plane="YZ", bevel=0.05)
    for y in (-wb / 2, wb / 2):  # 車輪の切り欠き
        cut(body, cylinder("c_arch", wheel_r + 0.06, W + 0.2, (0, y, wheel_r), rot=(0, math.pi / 2, 0), bevel=0))
    cabin_side = [(-0.85, 0.86), (-0.15, 1.42), (1.05, 1.42), (1.55, 0.90)]
    cabin = prism("Cabin", cabin_side, W - 0.2, (0, 0, 0), glass, plane="YZ", bevel=0.03)
    roof = prism("RoofPanel", [(-0.1, 1.40), (1.0, 1.40), (0.98, 1.46), (-0.05, 1.46)], W - 0.24, (0, 0, 0), paint, plane="YZ", bevel=0.02)
    parts = [body, cabin, roof]
    for y in (-wb / 2, wb / 2):
        for x in (-1, 1):
            parts.append(cylinder("Tire", wheel_r, 0.22, (x * (W / 2 - 0.13), y, wheel_r), tire, rot=(0, math.pi / 2, 0), bevel=0.03))
            parts.append(cylinder("Rim", wheel_r * 0.6, 0.23, (x * (W / 2 - 0.13), y, wheel_r), rim, rot=(0, math.pi / 2, 0), bevel=0.01))
    head = box("HeadLight", (0.35, 0.05, 0.1), (0.6, -L / 2 + 0.01, 0.68), light, bevel=0.01)
    parts += [head, mirror_x(head)]
    return join(parts, "Car")


def build_boat():
    """小さな漁船（全長 7m・前 -Y）。船体は hull（断面の並び）、操舵室は箱、帆柱は円柱。"""
    hull_m = material("Hull", (0.92, 0.92, 0.9, 1), roughness=0.5)
    bottom = material("Bottom", (0.55, 0.12, 0.10, 1), roughness=0.6)
    deck_m = material("Deck", (0.55, 0.42, 0.28, 1), roughness=0.7)
    cabin_m = material("Cabin", (0.85, 0.85, 0.82, 1), roughness=0.5)
    glass = material("Glass", (0.10, 0.13, 0.16, 1), roughness=0.05)
    # (y, 幅の半分, 舷の上の z, 底の z)。船首は細く高く、船尾は広く平ら。
    stations = [(-3.5, 0.02, 1.35, 0.95), (-3.1, 0.55, 1.30, 0.30), (-2.0, 1.10, 1.22, 0.10), (0.0, 1.25, 1.18, 0.0), (2.0, 1.20, 1.18, 0.05), (3.4, 1.05, 1.20, 0.30)]
    shell = hull("Hull", stations, hull_m)
    shell.data.materials.append(bottom)
    shell.data.materials.append(deck_m)
    for p in shell.data.polygons:
        if p.normal.z > 0.8:  # 上を向いた面（ふた）= 甲板
            p.material_index = 2
        elif (shell.matrix_world @ p.center).z < 0.45:  # 喫水線より下 = 船底の色
            p.material_index = 1
    parts = [shell]
    parts.append(box("Wheelhouse", (1.4, 1.6, 1.3), (0, 0.9, 1.8), cabin_m, bevel=0.04))
    parts.append(box("WheelRoof", (1.6, 1.9, 0.08), (0, 0.9, 2.49), cabin_m, bevel=0.02))
    parts.append(box("Window", (1.3, 0.02, 0.45), (0, 0.09, 2.05), glass, bevel=0))
    parts.append(cylinder("Mast", 0.05, 2.5, (0, -1.0, 2.35), cabin_m, bevel=0.005))
    parts += repeat(lambda i, p: box(f"Rail{i}", (0.04, 0.04, 0.35), (1.08, p.y, 1.3), cabin_m, bevel=0), 6, (0, -2.0, 0), (0, 0.9, 0))
    parts += [mirror_x(r) for r in parts[-6:]]
    return join(parts, "Boat")


def build_machiya():
    """江戸の町家（間口 3 間 5.4 × 奥行き 10m・平入りの 2 階建て）。手本の無い所から styles.md の見分けどころで組んだ例。
    見分けどころ: 1 階正面の格子・のれん／低いつし 2 階と虫籠窓／通りへ下る庇／瓦の切妻屋根（棟は通りと平行）。"""
    W, D, H1, H2 = 5.4, 10.0, 3.0, 2.0
    plaster = material("Plaster", (0.86, 0.83, 0.76, 1), roughness=0.9)
    wood = material("DarkWood", (0.20, 0.13, 0.08, 1), roughness=0.7)
    tile = material("Kawara", (0.25, 0.26, 0.28, 1), roughness=0.6)
    noren = material("Noren", (0.12, 0.18, 0.35, 1), roughness=0.9)
    f1 = box("F1", (W, D, H1), (0, 0, H1 / 2), wood, bevel=0.01)
    cut(f1, box("c_front", (W - 0.6, 0.5, 2.2), (0, -D / 2, 1.1), bevel=0))  # 正面を開けて格子を入れる
    parts = [f1]
    parts += repeat(lambda i, p: box(f"Koshi{i}", (0.03, 0.04, 2.2), p, wood, bevel=0), 40, (-(W - 0.6) / 2 + 0.05, -D / 2 + 0.1, 1.1), ((W - 0.7) / 39, 0, 0))
    parts.append(box("Noren", (1.0, 0.02, 0.6), (0, -D / 2 + 0.05, 1.9), noren, bevel=0))
    f2 = box("F2", (W, D - 0.6, H2), (0, 0.3, H1 + 0.35 + H2 / 2), plaster, bevel=0.01)
    for x in (-1.5, 0, 1.5):  # 虫籠窓（穴＋縦の細い桟）
        cut(f2, box("c_mushiko", (0.9, 0.5, 0.5), (x, -D / 2 + 0.3, H1 + 1.35), bevel=0))
        parts += repeat(lambda i, p: box(f"Mushiko{i}", (0.05, 0.05, 0.5), p, plaster, bevel=0), 6, (x - 0.38, -D / 2 + 0.45, H1 + 1.35), (0.15, 0, 0))
    parts.append(f2)
    parts.append(shed_roof("Hisashi", W + 0.3, 0.9, H1 + 0.45, 24, tile, down="-Y", overhang=0.0, center=(0, -D / 2)))
    parts += gable_roof("Roof", W, D - 0.6, H1 + 0.35 + H2, 24, tile, ridge="X", overhang=0.5, wall_mat=plaster, center=(0, 0.3))
    return join(parts, "Machiya")


KINDS = {"table": build_table, "sword": build_sword, "house": build_house, "car": build_car, "boat": build_boat, "machiya": build_machiya}

if __name__ == "__main__":
    clear_scene()
    ob = KINDS[KIND]()
    measure(ob)
    render_views(ob, OUT_DIR, KIND)
    export(ob.name, OUT_DIR)
