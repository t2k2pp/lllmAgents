# -*- coding: utf-8 -*-
"""bkit — Blender で何でも作るための部品箱（Blender 4.2〜5.x）。

使い方:
  画面無し:  スクリプトの先頭で
                 import sys; sys.path.insert(0, r"<このファイルのフォルダ>"); from bkit import *
  MCP:       execute_blender_code で最初に 1 回
                 exec(open(r"<このファイルの場所>", encoding="utf-8").read(), globals())
             を送ると、以後の呼び出しでこの関数が使える。

決まり: 単位 m・上 +Z・地面 z=0・前 -Y・右 +X。

道具の選び方:
  生き物・人・キャラ（なめらかな体）    loft() を部位ごとに作り → fuse() で 1 枚の皮に → paint_by_parts()
  角のある物（家具・建物・車・機械）     box() / cylinder() / prism() を置き → cut() で穴 → join()
  屋根                                  gable_roof()（切妻）・shed_roof()（片流れ・庇）。自分で板を傾けない
  船体・車体・飛行機の胴（流れる形）     hull()（断面の形を自分で決める loft）
  自然の物（岩・木・茂み・雲）          blob()（揺らした球）＋ tube()（幹・枝）
  確かめ                                render_views()（5 方向の絵）・measure()（寸法）
"""
import math
import os
import random

import bmesh
import bpy
from mathutils import Euler, Vector


# ================================================================ 場面・材質
def clear_scene():
    """場面の物を全部消す。画面無しの時だけ使う（MCP ではユーザーの物を消さない）。"""
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)


def material(name, rgba, metallic=0.0, roughness=0.5):
    """rgba = (r, g, b, 1)。金属は metallic=1。確かめの絵（Workbench）にも同じ色が出る。"""
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    mat.diffuse_color = rgba
    mat.metallic = metallic
    mat.roughness = roughness
    return mat


def apply_modifiers(ob):
    """修飾を全部当てて形に焼き込む（画面無しでも動く）。"""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    old = ob.data
    ob.data = me
    bpy.data.meshes.remove(old)


def _object(name, bm, mat=None):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)
    return ob


def shade(ob, smooth=True):
    for p in ob.data.polygons:
        p.use_smooth = smooth


# ================================================================ 断面をつなぐ（生き物・幹・枝）
def densify(sections, steps=4):
    """断面の間を Catmull-Rom でなめらかに補う（少ない断面でも角張らない）。"""
    if len(sections) < 3:
        return list(sections)
    out, n = [], len(sections)
    for i in range(n - 1):
        p0, p1, p2, p3 = sections[max(i - 1, 0)], sections[i], sections[i + 1], sections[min(i + 2, n - 1)]
        for k in range(steps):
            t = k / steps
            t2, t3 = t * t, t * t * t
            out.append(
                tuple(
                    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
                    for a, b, c, d in zip(p0, p1, p2, p3)
                )
            )
    out.append(tuple(sections[-1]))
    return out


def _frames(pts):
    """各断面の (横, 上)。横はいつも左右（X）寄りにして、途中でねじれないようにする。"""
    frames, prev = [], Vector((1, 0, 0))
    for i in range(len(pts)):
        t = (pts[min(i + 1, len(pts) - 1)] - pts[max(i - 1, 0)]).normalized()
        side = Vector((1, 0, 0)) - t * t.x
        if side.length < 1e-3:  # 道すじが左右を向く時は前の向きを引き継ぐ
            side = prev - t * prev.dot(t)
            if side.length < 1e-3:
                side = Vector((0, 1, 0)) - t * t.y
        side.normalize()
        prev = side
        frames.append((side, side.cross(t).normalized()))
    return frames


def _ring_mesh(bm, rings):
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(n):
            bm.faces.new((r0[k], r0[(k + 1) % n], r1[(k + 1) % n], r1[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])


def loft(name, sections, mat=None, ring=32, smooth=True):
    """断面の並びを筒にする。sections = [(x, y, z, 幅の半分, 高さの半分), ...]（4 つなら丸: (x, y, z, 半径)）。
    胴・首・頭では「高さの半分」は上下、脚・腕（縦の道すじ）では前後の厚み。"""
    secs = [s if len(s) == 5 else (s[0], s[1], s[2], s[3], s[3]) for s in sections]
    secs = densify(secs)
    pts = [Vector(s[:3]) for s in secs]
    bm = bmesh.new()
    rings = []
    for (side, up), p, s in zip(_frames(pts), pts, secs):
        rings.append([bm.verts.new(p + side * (s[3] * math.cos(a)) + up * (s[4] * math.sin(a))) for a in (2 * math.pi * k / ring for k in range(ring))])
    _ring_mesh(bm, rings)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = _object(name, bm, mat)
    shade(ob, smooth)
    return ob


def tube(name, sections, mat=None, ring=16):
    """丸い筒（枝・パイプ・縄・尾）。sections = [(x, y, z, 半径), ...]。"""
    return loft(name, sections, mat, ring=ring)


def mirrored(sections):
    """左右反転した断面の並び（左右の手足・耳）。"""
    return [(-s[0],) + tuple(s[1:]) for s in sections]


def fuse(objs, name, voxel, smooth_iter=12, keep_parts=True):
    """部品をまとめ、継ぎ目を溶かして 1 枚の皮にする（Remesh で作り直す。格子が細かいので見た目はなめらか）。
    voxel = 格子の細かさ（m。体の大きさの 1/150〜1/200）。keep_parts=True なら部品は paint_by_parts 用に残す。"""
    bm = bmesh.new()
    for ob in objs:
        tmp = ob.data.copy()
        tmp.transform(ob.matrix_world)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    out = _object(name, bm)
    for _ in range(2):  # 1 回目で 1 枚にし、2 回目で付け根の細い折れ目を消す
        rm = out.modifiers.new("Remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = voxel
        rm.adaptivity = 0.0
        apply_modifiers(out)
        sm = out.modifiers.new("Smooth", "CORRECTIVE_SMOOTH")  # やせにくく、細い手足でも波打たない
        sm.iterations = smooth_iter * 2
        sm.use_only_smooth = True
        sm.smooth_type = "LENGTH_WEIGHTED"
        apply_modifiers(out)
    shade(out, True)
    if not keep_parts:
        for ob in objs:
            bpy.data.objects.remove(ob)
    return out


def paint_by_parts(ob, parts, colors):
    """1 枚にした皮の面を、いちばん近い部品の色に塗り分ける。部品には ob["color"] = "<色の名前>" を付けておく。
    colors = {"<色の名前>": (r, g, b, 1)}。塗った後、部品は消す。"""
    names = sorted({p.get("color", "base") for p in parts})
    for nm in names:
        ob.data.materials.append(material(f"{ob.name}_{nm}", colors.get(nm, (0.6, 0.6, 0.6, 1)), roughness=0.6))
    dg = bpy.context.evaluated_depsgraph_get()
    for poly in ob.data.polygons:
        c = ob.matrix_world @ poly.center
        best, best_d = None, 1e9
        for p in parts:
            ok, loc, _n, _i = p.evaluated_get(dg).closest_point_on_mesh(p.matrix_world.inverted() @ c)
            if ok and (p.matrix_world @ loc - c).length < best_d:
                best, best_d = p, (p.matrix_world @ loc - c).length
        poly.material_index = names.index(best.get("color", "base")) if best else 0
    for p in parts:
        bpy.data.objects.remove(p)


def decimate(ob, target_faces):
    """面を target_faces ほどに減らす（ゲーム向け）。0 なら何もしない。"""
    n = len(ob.data.polygons)
    if target_faces <= 0 or n <= target_faces:
        return
    d = ob.modifiers.new("Decimate", "DECIMATE")
    d.ratio = target_faces / n
    apply_modifiers(ob)


# ================================================================ 角のある物（家具・建物・車・機械）
def add_bevel(ob, width, segments=3):
    """角を丸める。幅は物の大きさの 1〜3%（机 3〜5mm・建物 1〜3cm・車 2〜5cm）。"""
    b = ob.modifiers.new("Bevel", "BEVEL")
    b.width = width
    b.segments = segments
    b.limit_method = "ANGLE"


def box(name, size, loc, mat=None, bevel=0.005, rot=(0, 0, 0)):
    """size = (幅 X, 奥行き Y, 高さ Z)。loc は箱の中心。rot はラジアン。"""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    ob = _object(name, bm, mat)
    ob.location, ob.rotation_euler = loc, Euler(rot)
    if bevel > 0:
        add_bevel(ob, bevel)
    return ob


def cylinder(name, radius, depth, loc, mat=None, rot=(0, 0, 0), verts=32, bevel=0.003, radius_top=None):
    """Z 向きの円柱（radius_top で円すい台・0 で円すい）。横に寝かせるなら rot=(0, pi/2, 0)（X 向き）。"""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=radius, radius2=radius if radius_top is None else radius_top, depth=depth)
    ob = _object(name, bm, mat)
    ob.location, ob.rotation_euler = loc, Euler(rot)
    for p in ob.data.polygons:
        p.use_smooth = len(p.vertices) == 4  # 側面だけなめらか・ふたは平ら
    if bevel > 0:
        add_bevel(ob, bevel)
    return ob


def sphere(name, radius, loc, mat=None, scale=(1, 1, 1), segments=32):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=segments // 2, radius=radius)
    ob = _object(name, bm, mat)
    ob.location, ob.scale = loc, scale
    shade(ob, True)
    return ob


def prism(name, outline, depth, loc, mat=None, plane="XZ", rot=(0, 0, 0), bevel=0.003):
    """多角形 outline [(a, b), ...] を押し出す（屋根の妻・刃・車の横顔・板金・文字の板）。
    plane="XZ": outline は (x, z)、Y 方向に depth の厚み（正面から見た形）。
    plane="YZ": outline は (y, z)、X 方向に depth の厚み（横から見た形。車・船の横顔）。
    plane="XY": outline は (x, y)、Z 方向に depth の厚み（上から見た形。床・敷地・天板）。"""
    def p3(a, b, c):
        return {"XZ": (a, c, b), "YZ": (c, a, b), "XY": (a, b, c)}[plane]

    bm = bmesh.new()
    f = [bm.verts.new(p3(a, b, -depth / 2)) for a, b in outline]
    k = [bm.verts.new(p3(a, b, depth / 2)) for a, b in outline]
    bm.faces.new(f)
    bm.faces.new(list(reversed(k)))
    for i in range(len(outline)):
        j = (i + 1) % len(outline)
        bm.faces.new((f[i], k[i], k[j], f[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = _object(name, bm, mat)
    ob.location, ob.rotation_euler = loc, Euler(rot)
    if bevel > 0:
        add_bevel(ob, bevel)
    return ob


def hull(name, stations, mat=None, profile=None, smooth=True):
    """流れる形の胴（船体・車体・飛行機・魚雷）。断面の形を自分で決める loft。
    stations = [(y, 幅の半分, 上の z, 下の z), ...]（前 → 後ろ）。
    profile = 断面の形（-1〜1 の (横, 縦) の並び。縦 1 が上・-1 が下）。無ければ船の V 字。"""
    if profile is None:  # 船: 舷は立ち、底は V
        profile = [(1.0, 1.0), (0.97, 0.3), (0.8, -0.4), (0.45, -0.85), (0.0, -1.0), (-0.45, -0.85), (-0.8, -0.4), (-0.97, 0.3), (-1.0, 1.0)]
    bm = bmesh.new()
    rings = []
    for y, hw, top, bot in densify(stations, steps=3):
        mid, hh = (top + bot) / 2, (top - bot) / 2
        rings.append([bm.verts.new((hw * a, y, mid + hh * b)) for a, b in profile])
    _ring_mesh(bm, rings)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    ob = _object(name, bm, mat)
    shade(ob, smooth)
    return ob


def gable_roof(name, width, depth, base_z, pitch_deg, mat, ridge="X", overhang=0.4, thickness=0.12, wall_mat=None, center=(0, 0)):
    """切妻屋根（板 2 枚＋棟＋妻の三角の壁）。傾ける向きの計算はここで済ませる（自分で回すと符号を間違えやすい）。
    width × depth は壁の外形、base_z は軒の高さ（壁の上）、pitch_deg は傾き（瓦 22〜27・茅 45〜・西洋 45〜60）。
    ridge="X": 棟が X 向き（屋根は ±Y へ下る。日本の「平入り」で正面が -Y の時）。ridge="Y": 棟が Y 向き（±X へ下る・正面に三角の妻）。
    wall_mat を渡すと妻の三角を壁として埋める。部品の並びを返す（join に渡す）。"""
    t = math.radians(pitch_deg)
    span, length = (depth, width) if ridge == "X" else (width, depth)
    half = span / 2
    rise = half * math.tan(t)
    run = half + overhang
    slab = run / math.cos(t)
    cx, cy = center
    parts = []
    for s in (-1, 1):
        mid_h = rise - (run / 2) * math.tan(t) + (thickness / 2) / math.cos(t)  # 板の中心の高さ（屋根面の上に厚みを載せる）
        if ridge == "X":
            parts.append(box(f"{name}_{'F' if s < 0 else 'B'}", (length + 2 * overhang, slab, thickness), (cx, cy + s * run / 2, base_z + mid_h), mat, bevel=thickness * 0.15, rot=(-s * t, 0, 0)))
        else:
            parts.append(box(f"{name}_{'L' if s < 0 else 'R'}", (slab, length + 2 * overhang, thickness), (cx + s * run / 2, cy, base_z + mid_h), mat, bevel=thickness * 0.15, rot=(0, s * t, 0)))
    ridge_size = (length + 2 * overhang, thickness * 2.5, thickness * 2) if ridge == "X" else (thickness * 2.5, length + 2 * overhang, thickness * 2)
    parts.append(box(f"{name}_Ridge", ridge_size, (cx, cy, base_z + rise + thickness), mat, bevel=thickness * 0.3))
    if wall_mat is not None:
        tri = [(-half, 0), (half, 0), (0, rise)]
        if ridge == "X":
            parts.append(prism(f"{name}_Gable", tri, length, (cx, cy, base_z), wall_mat, plane="YZ", bevel=0.01))
        else:
            parts.append(prism(f"{name}_Gable", tri, length, (cx, cy, base_z), wall_mat, plane="XZ", bevel=0.01))
    return parts


def shed_roof(name, width, depth, high_z, pitch_deg, mat, down="-Y", overhang=0.3, thickness=0.1, center=(0, 0)):
    """片流れ屋根・庇（板 1 枚）。high_z は高い側（壁に付く側）の高さ、down は下る向き（"-Y" "+Y" "-X" "+X"）。
    width × depth は覆う広さ（down の向きに depth）。部品を返す。"""
    t = math.radians(pitch_deg)
    run = depth + overhang
    slab = run / math.cos(t)
    sgn = -1 if down.startswith("-") else 1
    cx, cy = center
    z = high_z - (run / 2) * math.tan(t) + (thickness / 2) / math.cos(t)
    if down.endswith("Y"):
        return box(name, (width, slab, thickness), (cx, cy + sgn * run / 2, z), mat, bevel=thickness * 0.15, rot=(-sgn * t, 0, 0))
    return box(name, (slab, width, thickness), (cx + sgn * run / 2, cy, z), mat, bevel=thickness * 0.15, rot=(0, sgn * t, 0))


def cut(target, cutter):
    """target から cutter の形を引く（穴・窓・戸口・溝・車輪の切り欠き）。cutter は消える。"""
    bevel = next((m for m in target.modifiers if m.type == "BEVEL"), None)
    width = bevel.width if bevel else 0
    target.modifiers.clear()
    apply_modifiers(cutter)
    bo = target.modifiers.new("Cut", "BOOLEAN")
    bo.operation = "DIFFERENCE"
    bo.object = cutter
    bo.solver = "EXACT"
    apply_modifiers(target)
    bpy.data.objects.remove(cutter)
    if width:
        add_bevel(target, width)
    return target


def mirror_x(ob):
    """左右に写した複製（X を反転）。"""
    dup = ob.copy()
    dup.data = ob.data.copy()
    dup.name = ob.name + "_R"
    bpy.context.collection.objects.link(dup)
    dup.location.x = -ob.location.x
    dup.rotation_euler.y = -ob.rotation_euler.y
    dup.rotation_euler.z = -ob.rotation_euler.z
    return dup


def repeat(make, count, start, step):
    """make(i, 位置) を count 回呼んで並べる（柱・窓・手すり・瓦・石垣）。start と step は (x, y, z)。"""
    return [make(i, Vector(start) + Vector(step) * i) for i in range(count)]


def join(objs, name):
    """部品を 1 つの物にまとめる（材質は部品ごとに残る・修飾は当てる）。"""
    for ob in objs:
        apply_modifiers(ob)
    bm = bmesh.new()
    mats = []
    for ob in objs:
        tmp = ob.data.copy()
        tmp.transform(ob.matrix_world)
        remap = []
        for m in tmp.materials:
            if m not in mats:
                mats.append(m)
            remap.append(mats.index(m))
        for p in tmp.polygons:
            p.material_index = remap[p.material_index] if remap else 0
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    out = _object(name, bm)
    for m in mats:
        out.data.materials.append(m)
    for ob in objs:
        bpy.data.objects.remove(ob)
    return out


# ================================================================ 自然の物
def blob(name, radius, loc, mat=None, scale=(1, 1, 1), noise=0.3, noise_size=0.5, detail=4, seed=0):
    """揺らした球（岩・葉の塊・茂み・雲・山）。noise は radius に対する揺れ。seed で形が変わる。"""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=radius)
    ob = _object(name, bm, mat)
    ob.location, ob.scale = loc, scale
    if noise > 0:
        tex = bpy.data.textures.new(f"{name}_noise", "VORONOI")
        tex.noise_scale = noise_size
        origin = bpy.data.objects.new(f"{name}_origin", None)
        bpy.context.collection.objects.link(origin)
        rnd = random.Random(seed)
        origin.location = (rnd.uniform(-50, 50), rnd.uniform(-50, 50), rnd.uniform(-50, 50))
        dm = ob.modifiers.new("Displace", "DISPLACE")
        dm.texture, dm.strength, dm.mid_level = tex, radius * noise, 0.5
        dm.texture_coords, dm.texture_coords_object = "OBJECT", origin
        apply_modifiers(ob)
        bpy.data.objects.remove(origin)
    shade(ob, True)
    return ob


def flatten_bottom(ob, z=0.0):
    """地面より下を地面に押し付ける（浮かない・沈みすぎない）。"""
    mw, inv = ob.matrix_world, ob.matrix_world.inverted()
    for v in ob.data.vertices:
        w = mw @ v.co
        if w.z < z:
            w.z = z
            v.co = inv @ w


# ================================================================ 様式
def lowpoly(ob, ratio=0.1):
    """ローポリにする（面を減らして平らに塗る）。頼まれた時だけ。"""
    d = ob.modifiers.new("Decimate", "DECIMATE")
    d.ratio = ratio
    apply_modifiers(ob)
    shade(ob, False)


def voxelize(ob, block=0.08):
    """ボクセルアート（積み木）にする。頼まれた時だけ。block = 積み木 1 個の大きさ（m）。
    格子の点ごとに「形の内側か」を調べて積み木を置き、色は一番近い面の材質を引き継ぐ。外から見える面だけ作る。
    返り値は新しい物（元の物は消す）。細い所（耳・尾）は block より細いと消えるので、block は細い所の太さ以下に。"""
    from mathutils.bvhtree import BVHTree

    dg = bpy.context.evaluated_depsgraph_get()
    tree = BVHTree.FromObject(ob, dg)
    mw = ob.matrix_world
    inv = mw.inverted()
    polys = ob.data.polygons
    bb = [mw @ Vector(c) for c in ob.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    n = [max(1, math.ceil((hi[i] - lo[i]) / block)) for i in range(3)]
    cells = {}
    for ix in range(n[0]):
        for iy in range(n[1]):
            for iz in range(n[2]):
                c = lo + Vector(((ix + 0.5) * block, (iy + 0.5) * block, (iz + 0.5) * block))
                loc, normal, idx, _d = tree.find_nearest(inv @ c)
                if loc is not None and (inv @ c - loc).dot(normal) < 0:  # 面の裏側 = 内側
                    cells[(ix, iy, iz)] = polys[idx].material_index
    bm = bmesh.new()
    faces_mat = []
    h = block / 2
    sides = [((1, 0, 0), [(1, -1, -1), (1, 1, -1), (1, 1, 1), (1, -1, 1)]), ((-1, 0, 0), [(-1, -1, -1), (-1, -1, 1), (-1, 1, 1), (-1, 1, -1)]),
             ((0, 1, 0), [(-1, 1, -1), (-1, 1, 1), (1, 1, 1), (1, 1, -1)]), ((0, -1, 0), [(-1, -1, -1), (1, -1, -1), (1, -1, 1), (-1, -1, 1)]),
             ((0, 0, 1), [(-1, -1, 1), (1, -1, 1), (1, 1, 1), (-1, 1, 1)]), ((0, 0, -1), [(-1, -1, -1), (-1, 1, -1), (1, 1, -1), (1, -1, -1)])]
    verts = {}

    def vert(p):
        key = tuple(round(x, 5) for x in p)
        if key not in verts:
            verts[key] = bm.verts.new(p)
        return verts[key]

    for (ix, iy, iz), mi in cells.items():
        c = lo + Vector(((ix + 0.5) * block, (iy + 0.5) * block, (iz + 0.5) * block))
        for d, corners in sides:
            if (ix + d[0], iy + d[1], iz + d[2]) in cells:
                continue  # 隣にも積み木がある面は見えないので作らない
            bm.faces.new([vert(c + Vector(k) * h) for k in corners])
            faces_mat.append(mi)
    out = _object(ob.name + "_voxel", bm)
    for m in ob.data.materials:
        out.data.materials.append(m)
    for p, mi in zip(out.data.polygons, faces_mat):
        p.material_index = mi
    shade(out, False)
    name = ob.name
    bpy.data.objects.remove(ob)
    out.name = name
    flatten_bottom(out)
    return out


# ================================================================ 確かめる・書き出す
def measure(ob):
    """寸法を測って表示する（目が無くても確かめられる）。返り値 {min_z, height, length_y, width_x}。"""
    vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
    r = {
        "min_z": round(min(v.z for v in vs), 3),
        "height": round(max(v.z for v in vs) - min(v.z for v in vs), 3),
        "length_y": round(max(v.y for v in vs) - min(v.y for v in vs), 3),
        "width_x": round(max(v.x for v in vs) - min(v.x for v in vs), 3),
        "faces": len(ob.data.polygons),
    }
    print("measure:", ob.name, r)
    return r


def render_views(target, out_dir, prefix, views=("side", "front", "rear", "top", "three_quarter"), res=(1200, 900)):
    """横・前・後ろ・上・斜め を撮る（Workbench・影付き・速い。形を見るため）。撮った絵の場所の並びを返す。"""
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    prev_engine, prev_cam = sc.render.engine, sc.camera
    try:
        sc.render.engine = "BLENDER_WORKBENCH"
    except TypeError:
        pass
    sh = sc.display.shading
    sh.light, sh.color_type, sh.show_shadows, sh.show_cavity = "STUDIO", "MATERIAL", True, True
    sc.render.resolution_x, sc.render.resolution_y = res
    bb = [target.matrix_world @ Vector(c) for c in target.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    center, size = (lo + hi) / 2, max(hi - lo) * 1.15
    cam_data = bpy.data.cameras.new("ShotCam")
    cam = bpy.data.objects.new("ShotCam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    dirs = {
        "side": Vector((1, 0, 0)),
        "front": Vector((0, -1, 0)),
        "rear": Vector((0, 1, 0)),
        "top": Vector((0, 0, 1)),
        "three_quarter": Vector((1, -1.2, 0.7)).normalized(),
    }
    paths = []
    for view in views:
        cam_data.type = "PERSP" if view == "three_quarter" else "ORTHO"
        cam_data.ortho_scale = size * res[0] / res[1]
        cam.location = center + dirs[view] * size * 2.6
        cam.rotation_euler = (0, 0, 0) if view == "top" else (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(out_dir, f"{prefix}_{view}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(sc.render.filepath)
        print("shot:", sc.render.filepath)
    bpy.data.objects.remove(cam)
    sc.camera = prev_cam
    try:
        sc.render.engine = prev_engine
    except TypeError:
        pass
    return paths


def export(ob_name, out_dir, unity=True):
    """.blend と .fbx を書く。unity=True なら FBX は -Z 前・Y 上。"""
    os.makedirs(out_dir, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out_dir, f"{ob_name}.blend"))
    kw = {"axis_forward": "-Z", "axis_up": "Y"} if unity else {}
    bpy.ops.export_scene.fbx(filepath=os.path.join(out_dir, f"{ob_name}.fbx"), apply_scale_options="FBX_SCALE_ALL", **kw)
    print("export:", os.path.join(out_dir, f"{ob_name}.fbx"))
