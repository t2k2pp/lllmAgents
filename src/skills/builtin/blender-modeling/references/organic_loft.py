# -*- coding: utf-8 -*-
"""生き物を「断面のつながり」で作り、ボクセルで一体にする見本（Blender 4.2〜5.x）。

使い方:
  - 画面無し:   blender -b --python organic_loft.py -- <出力フォルダ>
  - MCP:        execute_blender_code にこのファイルの中身を渡す（OUT_DIR を書き換える）

手順:
  1. 寸法の表（PARTS）を書く。1 部位 = 道すじに沿った断面の並び (x, y, z, 幅の半分, 高さの半分)
     座標は m。前 = -Y、上 = +Z、右 = +X。地面は z=0。左右の脚は mirror_x で作る。
  2. loft() で部位ごとの筒を作る（端はふさぐ）
  3. fuse() で全部をまとめ、ボクセルで作り直して 1 枚の皮にする（付け根の割れ・めり込みが消える）
  4. smooth して、必要ならポリゴンを減らす
  5. render_views() で 横・前・後ろ・上・斜め の絵を撮る（形を確かめる用。Workbench で速い）

この見本の PARTS は 馬（体高 1.6m）のおおまかな形。数値は SKILL の寸法の目安から作っている。
別の生き物は PARTS を書き換える。
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
OUT_DIR = argv[0] if argv else os.path.join(os.path.expanduser("~"), "blender_out")
NAME = "Horse"
VOXEL = 0.012  # 一体にする細かさ（m）。小さいほど細かい・重い。体長 2m なら 0.01〜0.02
TARGET_FACES = 30000  # 0 なら減らさない
SMOOTH_ITER = 12  # 付け根を丸める強さ。上げすぎると耳・ひづめが溶ける

# ---------------------------------------------------------------- 寸法の表
# (x, y, z, rx=幅の半分, rz=高さの半分)
BODY = [  # 胸の先 → 尻。背の線と腹の線の間に断面の中心を置く
    (0, -0.80, 1.18, 0.17, 0.22),
    (0, -0.70, 1.20, 0.22, 0.32),  # 胸
    (0, -0.50, 1.22, 0.25, 0.38),  # き甲の下（胴が一番深い）
    (0, -0.20, 1.20, 0.27, 0.37),  # 腹
    (0, 0.10, 1.20, 0.27, 0.35),
    (0, 0.35, 1.25, 0.25, 0.32),  # 腰
    (0, 0.55, 1.27, 0.24, 0.30),  # 尻（丸く）
    (0, 0.70, 1.22, 0.18, 0.24),
    (0, 0.78, 1.15, 0.08, 0.12),
]
NECK = [  # き甲の前 → 頭の後ろ（約 45 度で上がる・付け根は太く胴へ埋める）
    (0, -0.45, 1.30, 0.18, 0.30),
    (0, -0.62, 1.45, 0.15, 0.25),
    (0, -0.78, 1.62, 0.12, 0.19),
    (0, -0.92, 1.78, 0.095, 0.14),
    (0, -1.00, 1.88, 0.085, 0.11),
]
HEAD = [  # 頭の後ろ → 鼻先（前下へ。後ろ寄りのほお〔あご〕を深く、鼻へ細く、鼻先で少しふくらむ）
    (0, -0.99, 1.90, 0.08, 0.09),
    (0, -1.06, 1.80, 0.10, 0.15),  # ほお・あご（いちばん深い）
    (0, -1.15, 1.68, 0.085, 0.10),
    (0, -1.25, 1.56, 0.07, 0.075),
    (0, -1.33, 1.46, 0.075, 0.075),  # 鼻先
    (0, -1.36, 1.42, 0.05, 0.045),
]
EAR = [(0.05, -0.98, 1.92, 0.035, 0.025), (0.065, -0.97, 2.02, 0.03, 0.018), (0.075, -0.96, 2.10, 0.008, 0.006)]
FRONT_LEG = [  # 肩 → ひじ → 前ひざ → 球節 → ひづめ（ほぼまっすぐ下）
    (0.15, -0.62, 1.15, 0.10, 0.12),
    (0.15, -0.60, 0.95, 0.085, 0.10),  # ひじ
    (0.15, -0.60, 0.70, 0.06, 0.07),  # 前腕
    (0.15, -0.60, 0.50, 0.055, 0.06),  # 前ひざ（少し太い）
    (0.15, -0.60, 0.40, 0.04, 0.045),  # 管（細い）
    (0.15, -0.60, 0.20, 0.045, 0.05),  # 球節
    (0.15, -0.63, 0.10, 0.04, 0.04),  # つなぎ（前へ傾く）
    (0.15, -0.65, 0.04, 0.06, 0.06),  # ひづめ
    (0.15, -0.65, 0.00, 0.06, 0.06),
]
HIND_LEG = [  # 腰 → ひざ（前） → 飛節（後ろへ曲がる） → 球節 → ひづめ
    (0.17, 0.45, 1.15, 0.14, 0.20),
    (0.17, 0.35, 0.95, 0.10, 0.14),  # ひざ（前へ）
    (0.17, 0.48, 0.72, 0.07, 0.09),  # すね
    (0.17, 0.58, 0.55, 0.05, 0.07),  # 飛節（いちばん後ろ）
    (0.17, 0.56, 0.40, 0.04, 0.045),  # 管
    (0.17, 0.56, 0.20, 0.045, 0.05),  # 球節
    (0.17, 0.53, 0.10, 0.04, 0.04),
    (0.17, 0.51, 0.04, 0.06, 0.06),
    (0.17, 0.51, 0.00, 0.06, 0.06),
]
TAIL = [(0, 0.78, 1.20, 0.05, 0.05), (0, 0.88, 1.05, 0.06, 0.04), (0, 0.92, 0.80, 0.07, 0.04), (0, 0.93, 0.55, 0.05, 0.03)]
MANE = [(0, -0.40, 1.58, 0.03, 0.05), (0, -0.55, 1.68, 0.035, 0.07), (0, -0.72, 1.82, 0.035, 0.07), (0, -0.88, 1.94, 0.03, 0.05), (0, -0.97, 2.00, 0.02, 0.03)]

# (部位, 断面, 左右に写すか, 色の名前)
PARTS = [
    ("body", BODY, False, "coat"),
    ("neck", NECK, False, "coat"),
    ("head", HEAD, False, "coat"),
    ("ear", EAR, True, "coat"),
    ("front_leg", FRONT_LEG, True, "coat"),
    ("hind_leg", HIND_LEG, True, "coat"),
    ("tail", TAIL, False, "hair"),
    ("mane", MANE, False, "hair"),
]
COLORS = {"coat": (0.42, 0.25, 0.13, 1), "hair": (0.06, 0.04, 0.03, 1)}


# ---------------------------------------------------------------- 作る道具
def densify(sections, steps=4):
    """断面の間を Catmull-Rom でなめらかに補う（少ない断面でも胴が角張らない）。"""
    if len(sections) < 3:
        return list(sections)
    out = []
    n = len(sections)
    for i in range(n - 1):
        p0 = sections[max(i - 1, 0)]
        p1, p2 = sections[i], sections[i + 1]
        p3 = sections[min(i + 2, n - 1)]
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


def loft(bm, sections, ring=32):
    """断面の並びを筒にして bm に足す。端はふさぐ。足した面を返す。"""
    sections = densify(sections)
    pts = [Vector(s[:3]) for s in sections]
    rings = []
    x_axis = Vector((1, 0, 0))
    prev_side = x_axis
    for i, s in enumerate(sections):
        a = pts[max(i - 1, 0)]
        b = pts[min(i + 1, len(pts) - 1)]
        t = (b - a).normalized()
        # 幅（rx）はいつも左右（X）の向き。道すじに直交するよう X から t の成分を引く。
        # これで断面が途中でねじれない（ねじれると筒がくびれて切れて見える）。
        side = x_axis - t * x_axis.dot(t)
        if side.length < 1e-3:  # 道すじが左右を向く部位だけ、前の断面の向きを引き継ぐ
            side = prev_side - t * prev_side.dot(t)
        side.normalize()
        prev_side = side
        up = side.cross(t).normalized()  # 胴・首では上下、脚では前後
        rx, rz = s[3], s[4]
        verts = []
        for k in range(ring):
            ang = 2 * math.pi * k / ring
            verts.append(bm.verts.new(pts[i] + side * (rx * math.cos(ang)) + up * (rz * math.sin(ang))))
        rings.append(verts)
    faces = []
    for r0, r1 in zip(rings, rings[1:]):
        for k in range(ring):
            faces.append(bm.faces.new((r0[k], r0[(k + 1) % ring], r1[(k + 1) % ring], r1[k])))
    faces.append(bm.faces.new(list(reversed(rings[0]))))
    faces.append(bm.faces.new(rings[-1]))
    return faces


def mirrored(sections):
    return [(-x, y, z, rx, rz) for (x, y, z, rx, rz) in sections]


def build_parts(parts):
    """部位ごとに別の物を作る（色を分けるため）。物の一覧を返す。"""
    objs = []
    for name, sections, mirror, color in parts:
        for side, secs in [("", sections)] + ([("_R", mirrored(sections))] if mirror else []):
            bm = bmesh.new()
            loft(bm, secs)
            bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
            me = bpy.data.meshes.new(f"{name}{side}")
            bm.to_mesh(me)
            bm.free()
            ob = bpy.data.objects.new(f"{name}{side}", me)
            ob["gm_color"] = color
            bpy.context.collection.objects.link(ob)
            objs.append(ob)
    return objs


def apply_modifiers(ob):
    """物の修飾を全部当てる（画面無しでも動くように depsgraph で）。"""
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear()
    old = ob.data
    ob.data = me
    bpy.data.meshes.remove(old)


def fuse(objs, name, voxel):
    """全部を 1 つにまとめ、ボクセルで作り直して継ぎ目の無い 1 枚の皮にする。"""
    bm = bmesh.new()
    for ob in objs:
        tmp = ob.data.copy()
        tmp.transform(ob.matrix_world)
        bm.from_mesh(tmp)
        bpy.data.meshes.remove(tmp)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    out = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(out)
    # ボクセルで作り直す → ならす を 2 回。1 回目で 1 枚にし、2 回目で付け根の細い折れ目を消す。
    for _ in range(2):
        rm = out.modifiers.new("Remesh", "REMESH")
        rm.mode = "VOXEL"
        rm.voxel_size = voxel
        rm.adaptivity = 0.0
        apply_modifiers(out)
        # 体積を保つ Laplacian なので細い脚がやせにくい
        sm = out.modifiers.new("Smooth", "LAPLACIANSMOOTH")
        sm.iterations = SMOOTH_ITER
        sm.lambda_factor = 0.8
        sm.use_volume_preserve = True
        apply_modifiers(out)
    return out


def decimate(ob, target_faces):
    n = len(ob.data.polygons)
    if target_faces <= 0 or n <= target_faces:
        return
    d = ob.modifiers.new("Decimate", "DECIMATE")
    d.ratio = target_faces / n
    apply_modifiers(ob)


def paint_by_parts(ob, parts_objs):
    """一体にした皮の面を、いちばん近い部位の色に分ける。"""
    names = sorted({p["gm_color"] for p in parts_objs})
    for nm in names:
        mat = bpy.data.materials.new(f"{NAME}_{nm}")
        mat.use_nodes = True
        bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
        rgba = COLORS.get(nm, (0.5, 0.5, 0.5, 1))
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = 0.6
        mat.diffuse_color = rgba  # Workbench（確かめの絵）はこちらの色を使う
        ob.data.materials.append(mat)
    dg = bpy.context.evaluated_depsgraph_get()
    for poly in ob.data.polygons:
        c = ob.matrix_world @ poly.center
        best, best_d = None, 1e9
        for p in parts_objs:
            ok, loc, _n, _i = p.evaluated_get(dg).closest_point_on_mesh(p.matrix_world.inverted() @ c)
            if ok:
                d = (p.matrix_world @ loc - c).length
                if d < best_d:
                    best, best_d = p, d
        poly.material_index = names.index(best["gm_color"]) if best else 0


def render_views(target, out_dir, prefix):
    """横・前・後ろ・上・斜めを撮る。形を見るための Workbench（影付き・速い）。"""
    os.makedirs(out_dir, exist_ok=True)
    sc = bpy.context.scene
    try:
        sc.render.engine = "BLENDER_WORKBENCH"
    except TypeError:
        pass
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "MATERIAL"
    sc.display.shading.show_shadows = True
    sc.display.shading.show_cavity = True
    sc.render.resolution_x, sc.render.resolution_y = 1200, 900
    sc.render.film_transparent = False
    bb = [target.matrix_world @ Vector(c) for c in target.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    center = (lo + hi) / 2
    size = max(hi - lo) * 1.15
    cam_data = bpy.data.cameras.new("ShotCam")
    cam = bpy.data.objects.new("ShotCam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    views = {
        "side": (Vector((1, 0, 0)), True),
        "front": (Vector((0, -1, 0)), True),
        "rear": (Vector((0, 1, 0)), True),
        "top": (Vector((0, 0, 1)), True),
        "three_quarter": (Vector((1, -1.2, 0.6)).normalized(), False),
    }
    paths = []
    for view, (direction, ortho) in views.items():
        cam_data.type = "ORTHO" if ortho else "PERSP"
        cam_data.ortho_scale = size * sc.render.resolution_x / sc.render.resolution_y  # 縦も収める
        cam_data.lens = 50
        cam.location = center + direction * size * 2.6
        if view == "top":
            cam.rotation_euler = (0, 0, 0)  # 真下を向き、画面の上 = +Y（尻）
        else:
            cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(out_dir, f"{prefix}_{view}.png")
        bpy.ops.render.render(write_still=True)
        paths.append(sc.render.filepath)
    bpy.data.objects.remove(cam)
    return paths


# ---------------------------------------------------------------- 実行
def main():
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob)
    parts = build_parts(PARTS)
    body = fuse(parts, NAME, VOXEL)
    decimate(body, TARGET_FACES)
    paint_by_parts(body, parts)
    for p in parts:
        bpy.data.objects.remove(p)
    for poly in body.data.polygons:
        poly.use_smooth = True
    os.makedirs(OUT_DIR, exist_ok=True)
    print("faces:", len(body.data.polygons))
    for path in render_views(body, OUT_DIR, NAME.lower()):
        print("shot:", path)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT_DIR, f"{NAME.lower()}.blend"))
    bpy.ops.export_scene.fbx(
        filepath=os.path.join(OUT_DIR, f"{NAME.lower()}.fbx"),
        use_selection=False,
        apply_scale_options="FBX_SCALE_ALL",
        axis_forward="-Z",
        axis_up="Y",
    )


main()
