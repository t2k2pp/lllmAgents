# -*- coding: utf-8 -*-
"""手本: 自然の物（岩・木）。部品箱 bkit の blob / tube / fuse の使い方。

  blender -b --python nature.py -- <出力フォルダ> [rock|tree] [種]

考え方:
  - 自然の物は「きれいな形をくずす」。球や筒を作り、ノイズで表面を揺らす。
  - 同じ形を並べない。種（SEED）を変えると別の岩・木になる。いくつも置く時は種を変えて作る。
  - 木の幹と枝は筒をつないで fuse（継ぎ目が溶ける）。葉は塊をいくつも置く（1 枚ずつは作らない・重い）。
針葉樹は円すい（cylinder の radius_top=0）を段に重ねる。茂みは小さな blob を寄せる。雲は白い blob。
"""
import math
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bkit import apply_modifiers, blob, clear_scene, export, flatten_bottom, fuse, join, material, measure, render_views, shade, tube  # noqa: E402
from mathutils import Vector  # noqa: E402

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_DIR = argv[0] if argv else os.path.join(os.path.expanduser("~"), "blender_out")
KIND = argv[1] if len(argv) > 1 else "rock"
SEED = int(argv[2]) if len(argv) > 2 else 7


def build_rock():
    """岩（幅 1.4m ほど）。大きく揺らした球 → 面を減らして割れた面を出す → 平らに塗る → 底を地面に。"""
    stone = material("Stone", (0.42, 0.41, 0.39, 1), roughness=0.9)
    ob = blob("Rock", 0.6, (0, 0, 0.35), stone, scale=(1.2, 0.9, 0.7), noise=0.5, noise_size=0.5, detail=5, seed=SEED)
    d = ob.modifiers.new("Decimate", "DECIMATE")  # 面を減らすと平らな割れ面ができ、岩らしくなる
    d.ratio = 0.12
    apply_modifiers(ob)
    shade(ob, False)
    flatten_bottom(ob)
    return ob


def build_tree():
    """広葉樹（高さ 5m ほど）。"""
    bark = material("Bark", (0.30, 0.20, 0.12, 1), roughness=0.9)
    leaf = material("Leaves", (0.20, 0.38, 0.14, 1), roughness=0.8)
    rnd = random.Random(SEED)
    pieces = [tube("Trunk", [(0, 0, -0.1, 0.22), (0, 0, 0.3, 0.17), (0.03, 0.02, 1.5, 0.14), (0.05, 0.0, 2.6, 0.11)])]
    tips = []
    for i in range(5):  # 幹の上から斜め上へ伸びる枝
        ang = 2 * math.pi * i / 5 + rnd.uniform(-0.3, 0.3)
        d = Vector((math.cos(ang), math.sin(ang), rnd.uniform(0.7, 1.2))).normalized()
        p0 = Vector((0.04, 0.0, rnd.uniform(1.9, 2.5)))
        length = rnd.uniform(1.0, 1.6)
        p1, p2 = p0 + d * length * 0.5 + Vector((0, 0, 0.1)), p0 + d * length
        pieces.append(tube(f"Branch{i}", [(*p0, 0.08), (*p1, 0.06), (*p2, 0.03)], ring=12))
        tips.append(p2)
    wood = fuse(pieces, "Wood", 0.025, smooth_iter=6, keep_parts=False)
    wood.data.materials.append(bark)
    flatten_bottom(wood)
    parts = [wood]
    for i, tip in enumerate(tips + [Vector((0.05, 0, 3.6))]):  # 葉の塊: 枝先ごと＋頂上
        r = rnd.uniform(0.8, 1.1)
        parts.append(blob(f"Leaf{i}", r, tip + Vector((0, 0, 0.2)), leaf, scale=(1, 1, 0.8), noise=0.35, noise_size=0.35, detail=4, seed=SEED * 10 + i))
    return join(parts, "Tree")


KINDS = {"rock": build_rock, "tree": build_tree}

if __name__ == "__main__":
    clear_scene()
    ob = KINDS[KIND]()
    measure(ob)
    render_views(ob, OUT_DIR, KIND, views=("side", "front", "top", "three_quarter"))
    export(ob.name, OUT_DIR)
