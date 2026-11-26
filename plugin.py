"""ComfyUI 工作流插件（PromptStudio）。

思路：把 ComfyUI「导出（API）」得到的 api json 存进插件，自动识别可填位置：
    提示词 / 负向提示词 / 分辨率（宽高）/ 时长（帧数×fps）/ 参考图 / 输出节点。
面板里填提示词、时长、画幅即可提交，其余参数（步数、cfg、采样器、模型）沿用工作流原值。

对外接口（前端 web/panel.js 用）：
    POST /api/plugin/comfy_runner/import      {json|workflow, name}   导入 + 自动检测
    GET  /api/plugin/comfy_runner/workflows                           已存工作流清单
    POST /api/plugin/comfy_runner/save        {id, name, slots}       改名字 / 改映射
    POST /api/plugin/comfy_runner/delete      {id}
    GET  /api/plugin/comfy_runner/detail?id=                          原始图 + 映射
    POST /api/plugin/comfy_runner/run         {id, prompt, negative, duration, width, height, mode, seed, images:[{name,data_url}]}
    GET  /api/plugin/comfy_runner/status?prompt_id=&id=               进度 / 产物
    GET  /api/plugin/comfy_runner/view?filename=&subfolder=&type=     代理 ComfyUI /view（图片、视频直接可看）
    GET  /api/plugin/comfy_runner/ping                                ComfyUI 是否可达
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ID = "comfy_runner"
IMG_EXT = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
VID_EXT = (".mp4", ".webm", ".gif", ".mkv", ".mov", ".webp")

# 含提示词正文的输入字段（不同文本节点叫法不同）
TEXT_FIELDS = ("text", "prompt", "value", "string", "text_g", "text_l", "positive_prompt",
               "global_prompt", "main_prompt", "user_prompt", "t2v_prompt", "i2v_prompt",
               "caption", "description", "instruction", "system_prompt")
# 负向提示词专用字段名
NEG_FIELDS = ("negative_prompt", "negativeprompt", "neg_prompt", "neg")
# 把整块时间线/分镜塞进 JSON 字符串的复合节点（MiniMax 导演台等）：
#   字段值本身是 JSON 文本，提示词在 segments[i].prompt / global.prompt 里
EMBED_FIELDS = ("timeline_data", "timeline", "segments", "shots", "script",
                "prompt_json", "storyboard", "scene_data")
# 输出节点
VIDEO_OUT = ("VHS_VideoCombine", "SaveVideo", "CreateVideo", "SaveAnimatedWEBP", "SaveWEBM",
             "SaveAnimatedPNG", "VideoCombine", "SaveVideoUI")
IMAGE_OUT = ("SaveImage", "SaveImageAdvanced", "PreviewImage", "ImageSave", "SaveImageWebsocket")
# 宽高节点（值：宽、高、帧数字段名）
SIZE_NODES = {
    "EmptyLatentImage": ("width", "height", None),
    "EmptySD3LatentImage": ("width", "height", None),
    "EmptyLatentHDImage": ("width", "height", None),
    "EmptyHunyuanLatentVideo": ("width", "height", "length"),
    "EmptyLatentVideo": ("width", "height", "length"),
    "EmptyMochiLatentVideo": ("width", "height", "length"),
    "WanImageToVideo": ("width", "height", "length"),
    "WanFirstLastFrameToVideo": ("width", "height", "length"),
    "EmptyChromaRadianceLatentImage": ("width", "height", None),
    "SDXLEmptyLatentImage": ("width", "height", None),
    "LatentUpscale": ("width", "height", None),
    "ImageScale": ("width", "height", None),
    "ImageResize": ("width", "height", None),
    "ResizeImage": ("width", "height", None),
    "EmptyImage": ("width", "height", None),
}

# 常用分辨率预设（面板下拉用；改它直接写进工作流的分辨率节点）
RES_PRESETS = {
    "image": [
        ("1024×1024（1:1）", 1024, 1024),
        ("832×1216（竖 2:3）", 832, 1216),
        ("1216×832（横 3:2）", 1216, 832),
        ("896×1152（竖 3:4）", 896, 1152),
        ("1152×896（横 4:3）", 1152, 896),
        ("1344×768（横 16:9）", 1344, 768),
        ("768×1344（竖 9:16）", 768, 1344),
        ("1536×1536（1:1 大）", 1536, 1536),
        ("2048×1152（2K 16:9）", 2048, 1152),
    ],
    "video": [
        ("864×480（导演台默认 16:9）", 864, 480),
        ("1280×720（720p）", 1280, 720),
        ("720×1280（竖 720p）", 720, 1280),
        ("1920×1080（1080p）", 1920, 1080),
        ("1080×1920（竖 1080p）", 1080, 1920),
        ("1536×864（16:9）", 1536, 864),
        ("1024×576（16:9 小）", 1024, 576),
        ("832×480（16:9 小）", 832, 480),
        ("704×1280（竖短剧）", 704, 1280),
        ("2048×1152（2K 16:9）", 2048, 1152),
    ],
    "ImageScaleBy": (None, None, None),
    "LatentUpscaleBy": (None, None, None),
    "ImageScaleToTotalPixels": (None, None, None),
}
LENGTH_FIELDS = ("length", "num_frames", "frames", "video_frames", "frame_count",
                 "total_frames", "frameNum", "frame_num", "numframes")
FPS_FIELDS = ("frame_rate", "fps", "frameRate")

# 分辨率由 ResolutionSelector 计算（比例 + 百万像素 + 对齐倍数）
RATIO_SELECTORS = ("ResolutionSelector",)
RATIO_OPTIONS = (
    ("1:1 (Square)", 1, 1),
    ("2:3 (Portrait Photo)", 2, 3),
    ("3:2 (Photo)", 3, 2),
    ("3:4 (Portrait Standard)", 3, 4),
    ("4:3 (Standard)", 4, 3),
    ("9:16 (Portrait Widescreen)", 9, 16),
    ("16:9 (Widescreen)", 16, 9),
    ("21:9 (Ultrawide)", 21, 9),
)

# 模型下拉：字段名 → 中文类别
MODEL_FIELDS = (
    ("unet_name", "UNet"), ("ckpt_name", "大模型"), ("clip_name", "文本编码器"),
    ("clip_name1", "文本编码器"), ("clip_name2", "文本编码器"), ("vae_name", "VAE"),
    ("lora_name", "LoRA"), ("control_net_name", "ControlNet"), ("model_name", "放大模型"),
)
SAMPLER_HINT = ("KSampler", "SamplerCustom", "KSamplerAdvanced")


# ------------------------------------------------------------------ 小工具
def _base(ctx):
    url = str(ctx.get("comfy_url") or "http://127.0.0.1:8188").strip().rstrip("/")
    if not url.startswith("http"):
        url = "http://" + url
    return url


def _req(url, data=None, timeout=15, headers=None, raw=False):
    h = {"Accept": "*/*"}
    h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        h["Content-Type"] = "application/json"
    rq = urllib.request.Request(url, data=body, headers=h, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(rq, timeout=timeout) as r:
        return r.read() if raw else (r.headers, r.read())


def _json(url, data=None, timeout=20):
    rq = urllib.request.Request(
        url, data=(json.dumps(data, ensure_ascii=False).encode("utf-8") if data is not None else None),
        headers={"Content-Type": "application/json"}, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(rq, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _truthy(v):
    """兼容 true/1/"true" 这类开关值。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes", "on")
    return False


def _switch_of(nodes, node_id):
    """某节点若被 *Switch* 节点旁路（on_true / on_false），返回开关信息。"""
    fallback = None
    for cid, cn in (nodes or {}).items():
        cls = cn.get("class_type") or ""
        if "Switch" not in cls:
            continue
        ins = cn.get("inputs") or {}
        for f in ("on_true", "on_false"):
            v = ins.get(f)
            if _is_ref(v) and str(v[0]) == str(node_id):
                info = {"node": cid, "class": cls, "field": "switch",
                        "on": _truthy(ins.get("switch")), "branch": f}
                if f == "on_true":
                    return info
                fallback = fallback or info
    return fallback


def _open_switch(graph, holder, label, used):
    """把 holder["switch"] 指向的开关打开（只在当前关着时动手）。"""
    sw = holder.get("switch") if isinstance(holder, dict) else None
    if not isinstance(sw, dict) or not sw.get("node"):
        return False
    nid = str(sw["node"])
    node = graph.get(nid)
    if not node:
        return False
    ins = node.setdefault("inputs", {})
    if _truthy(ins.get("switch")):
        return False
    ins["switch"] = True
    used.append("打开%s开关 %s" % (label, nid))
    return True


def _is_ref(v):
    return isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and isinstance(v[1], (int, float))


def _store(ctx):
    d = ctx.data_dir
    os.makedirs(os.path.join(d, "wf"), exist_ok=True)
    return os.path.join(d, "workflows.json")


def _load_index(ctx):
    try:
        with open(_store(ctx), "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, list):
            return raw
        return raw.get("items") or []
    except (OSError, ValueError):
        return []


def _save_index(ctx, items):
    with open(_store(ctx), "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=1)


def _wf_path(ctx, wid):
    d = os.path.join(ctx.data_dir, "wf")
    os.makedirs(d, exist_ok=True)
    return os.path.join(d, "%s.json" % wid)


def _load_graph(ctx, wid):
    with open(_wf_path(ctx, wid), "r", encoding="utf-8") as f:
        return json.load(f)


def _new_id(name):
    slug = re.sub(r"[^0-9a-zA-Z\u4e00-\u9fa5]+", "_", str(name or "wf")).strip("_")[:24] or "wf"
    return "%s_%s" % (slug, uuid.uuid4().hex[:6])


def _short(s, n=60):
    s = re.sub(r"\s+", " ", str(s or ""))
    return s if len(s) <= n else s[:n] + "…"


# ------------------------------------------------------------------ 检测
def _path_get(obj, path):
    """按 "a.b[0].c" 取值。"""
    cur = obj
    for part in [p for p in str(path or "").split(".") if p]:
        if part.endswith("]") and "[" in part:
            key, idx = part[:-1].split("[", 1)
            if key:
                cur = cur.get(key) if isinstance(cur, dict) else None
            try:
                cur = cur[int(idx)] if isinstance(cur, list) else None
            except (ValueError, IndexError):
                return None
        else:
            cur = cur.get(part) if isinstance(cur, dict) else None
        if cur is None:
            return None
    return cur


def _path_set(obj, path, value):
    """按 "a.b[0].c" 写值（就地修改）。"""
    parts = [p for p in str(path or "").split(".") if p]
    if not parts:
        return False
    cur = obj
    for part in parts[:-1]:
        if part.endswith("]") and "[" in part:
            key, idx = part[:-1].split("[", 1)
            try:
                idx = int(idx)
            except ValueError:
                return False
            nxt = cur.get(key) if isinstance(cur, dict) else None
            if not isinstance(nxt, list) or idx >= len(nxt):
                return False
            cur = nxt[idx]
        else:
            nxt = cur.get(part) if isinstance(cur, dict) else None
            if not isinstance(nxt, (dict, list)):
                return False
            cur = nxt
    last = parts[-1]
    if last.endswith("]") and "[" in last:
        key, idx = last[:-1].split("[", 1)
        try:
            idx = int(idx)
        except ValueError:
            return False
        arr = cur.get(key) if isinstance(cur, dict) else None
        if not isinstance(arr, list) or idx >= len(arr):
            return False
        arr[idx] = value
        return True
    if not isinstance(cur, dict):
        return False
    cur[last] = value
    return True


def _embed_texts(value):
    """把 JSON 字符串（时间线/分镜）展开成 [(path, text, is_negative)]。"""
    try:
        obj = json.loads(value) if isinstance(value, str) else value
    except (ValueError, TypeError):
        return []
    if not isinstance(obj, (dict, list)):
        return []
    out = []

    def walk(node, prefix, depth=0):
        if depth > 6:
            return
        if isinstance(node, dict):
            for k, v in node.items():
                p = ("%s.%s" % (prefix, k)) if prefix else k
                kl = str(k).lower()
                if isinstance(v, str) and v.strip():
                    if kl in TEXT_FIELDS:
                        out.append((p, v, False))
                    elif kl in NEG_FIELDS:
                        out.append((p, v, True))
                elif isinstance(v, (dict, list)):
                    walk(v, p, depth + 1)
        elif isinstance(node, list):
            for i, v in enumerate(node[:24]):
                if isinstance(v, (dict, list)):
                    walk(v, "%s[%d]" % (prefix, i), depth + 1)

    walk(obj, "")
    return out


def _collect_texts(nodes, start, limit=200):
    """从一个输入引用出发，向上追到含文本字段的节点。

    返回 [(node_id, field, value, path, is_negative)]；path 非空表示文本藏在 JSON 串里。
    """
    out, seen, queue = [], set(), [start]
    hops = 0
    while queue and hops < limit:
        hops += 1
        cur = queue.pop(0)
        if not isinstance(cur, str) or cur in seen or cur not in nodes:
            continue
        seen.add(cur)
        node = nodes[cur] if isinstance(nodes[cur], dict) else {}
        inputs = node.get("inputs") or {}
        for k, v in inputs.items():
            kl = str(k).lower()
            if kl in TEXT_FIELDS and isinstance(v, str):
                out.append((cur, k, v, None, False))
            elif kl in NEG_FIELDS and isinstance(v, str):
                out.append((cur, k, v, None, True))
            elif k in EMBED_FIELDS and isinstance(v, str):
                for path, txt, neg in _embed_texts(v):
                    out.append((cur, k, txt, path, neg))
            elif _is_ref(v) and v[0] not in seen:
                queue.append(v[0])
    return out


def _first_ref(node, *keys):
    inputs = (node or {}).get("inputs") or {}
    for k in keys:
        v = inputs.get(k)
        if _is_ref(v):
            return v[0]
    return None


# ---------------------------------------------------------------- 导演台多模式
DIRECTOR_TYPES = ("MiniMaxH3Director",)
GROUP_I2V_TYPES = ("MiniMaxH3DirectorGroupImageToVideo",)
GROUP_R2V_TYPES = ("MiniMaxH3DirectorGroupReferenceToVideo",)
GROUP_COMBINE_TYPES = ("MiniMaxH3DirectorGroupsCombine",)

# key -> (中文名, 需要的图片数说明, 建议图片数)
TASK_MODES = {
    "t2v": ("文生视频", "不需要图片", 0),
    "i2v": ("图生视频（首帧）", "1 张首帧图", 1),
    "fl2v": ("首尾帧生视频", "2 张（首帧+尾帧），也可只给首帧", 2),
    "r2v": ("参考主体生视频", "1–9 张参考图，提示词用 <Picture 1>… 指代", 9),
    "v2v": ("视频转视频", "需要源视频（这里只填图片参考，视频在 ComfyUI 里换）", 0),
    "rv2v": ("参考素材改视频", "源视频 + 可选 1–9 张参考图", 9),
    "mixed": ("混合模式（按段）", "每段自己决定要不要图", 9),
    "t2i": ("文生图", "不需要图片", 0),
    "i2i": ("图生图", "1 张以上参考图", 8),
}


def _resolve_task_key(v):
    """把 'r2v — 参考主体生视频(Reference to Video)' 这类字符串切成 key。"""
    if not isinstance(v, str) or not v.strip():
        return ""
    s = v
    for cut in (",[object Object]", " · "):
        if cut in s:
            s = s.split(cut)[0]
    for sep in (" — ", " —— ", " - ", " – ", " —"):
        if sep in s:
            s = s.split(sep)[0]
    return s.strip().lower()


def _find_directors(nodes):
    """找导演台节点（API 格式里 inputs.task_type 是那种 'xxx — 名称' 字符串）。"""
    out = []
    for nid, n in nodes.items():
        cls = n.get("class_type") or ""
        ins = n.get("inputs") or {}
        if cls in DIRECTOR_TYPES or ("Director" in cls and isinstance(ins.get("task_type"), str)):
            out.append(nid)
    return out


def _collect_refs(nodes, directors):
    """收集参考图槽位。

    返回 [{node, field, label, group, role}]：
      - 导演台外部组：i2v_groups / r2v_groups → GroupsCombine → 组节点 → first_frame / last_frame / ref_images.ref_image_N
      - 兜底：全图裸 LoadImage
    """
    slots, seen_load, groups_seen = [], set(), 0

    def _push_group(group_node, gno):
        g = nodes.get(group_node) or {}
        cls = g.get("class_type") or ""
        if cls in GROUP_I2V_TYPES:
            for field, label in (("first_frame", "首帧"), ("last_frame", "尾帧")):
                v = (g.get("inputs") or {}).get(field)
                if _is_ref(v) and v[0] in nodes:
                    lid = v[0]
                    slots.append({"node": lid, "field": "image",
                                  "label": "组%d·%s" % (gno, label), "group": gno, "role": field,
                                  "empty": False})
                    seen_load.add(lid)
                elif v is None:
                    slots.append({"node": None, "field": field,
                                  "label": "组%d·%s（未接图）" % (gno, label), "group": gno,
                                  "role": field, "host": group_node, "empty": True})
        elif cls in GROUP_R2V_TYPES:
            ins = g.get("inputs") or {}
            keys = [k for k in ins if str(k).startswith("ref_images.")]
            keys.sort()

            def _idx(k):
                try:
                    return int(str(k).rsplit("_", 1)[-1])
                except Exception:
                    return 99

            for k in sorted(keys, key=_idx):
                v = ins.get(k)
                n = _idx(k) + 1
                if _is_ref(v) and v[0] in nodes:
                    lid = v[0]
                    slots.append({"node": lid, "field": "image",
                                  "label": "组%d·参考图%d" % (gno, n), "group": gno,
                                  "role": k, "empty": False})
                    seen_load.add(lid)
                elif v is None:
                    slots.append({"node": None, "field": k,
                                  "label": "组%d·参考图%d（未接图）" % (gno, n), "group": gno,
                                  "role": k, "host": group_node, "empty": True})

    for did in directors:
        ins = (nodes.get(did) or {}).get("inputs") or {}
        for key in ("i2v_groups", "r2v_groups"):
            v = ins.get(key)
            if not _is_ref(v):
                continue
            comb = nodes.get(v[0]) or {}
            if (comb.get("class_type") or "") not in GROUP_COMBINE_TYPES:
                continue
            cins = comb.get("inputs") or {}
            gkeys = [k for k in cins if str(k).startswith("groups.")]
            gkeys.sort()

            def _gidx(k):
                try:
                    return int(str(k).rsplit("_", 1)[-1])
                except Exception:
                    return 99

            for k in sorted(gkeys, key=_gidx):
                gv = cins.get(k)
                if _is_ref(gv) and gv[0] in nodes:
                    groups_seen += 1
                    _push_group(gv[0], groups_seen)

    # 兜底：没有被组槽吃掉的裸 LoadImage —— 标签带上它喂给谁（images.image_1 → 参考图1）
    for nid, n in nodes.items():
        if (n.get("class_type") or "") == "LoadImage" and nid not in seen_load:
            cons = []
            for cid, cn in nodes.items():
                for f, v in (cn.get("inputs") or {}).items():
                    if _is_ref(v) and v[0] == nid:
                        cons.append((cid, cn.get("class_type") or "", str(f)))
            cons.sort(key=lambda x: (0 if "image" in x[2] else 1, str(x[0])))
            label, hint = "图片 %s" % nid, ""
            if cons:
                cid, ccls, cf = cons[0]
                m = re.search(r"image[_.]?(\d+)", cf)
                label = ("参考图%s（%s）" % (m.group(1), ccls)) if m else ("图片 %s（%s）" % (nid, ccls))
                hint = "%s.%s" % (cid, cf)
            slots.append({"node": nid, "field": "image", "label": label,
                          "group": 0, "role": "load", "empty": False, "hint": hint,
                          "orig": (n.get("inputs") or {}).get("image")})
    for i, s in enumerate(slots):
        s["idx"] = i
    return slots


def detect(graph):
    """分析 API 格式工作流，给出可填槽位。"""
    nodes = {k: v for k, v in graph.items() if isinstance(v, dict) and v.get("class_type")}
    out_types, outputs = [], []
    for nid, n in nodes.items():
        cls = n.get("class_type") or ""
        if cls in VIDEO_OUT:
            out_types.append("video")
            outputs.append({"node": nid, "class": cls, "type": "video"})
        elif cls in IMAGE_OUT:
            out_types.append("image")
            outputs.append({"node": nid, "class": cls, "type": "image"})
    kind = "video" if "video" in out_types else "image"

    # 采样器（步数等参数的展示来源）
    samplers = []
    for nid, n in nodes.items():
        cls = n.get("class_type") or ""
        if any(cls.startswith(h) for h in SAMPLER_HINT):
            ins = n.get("inputs") or {}
            samplers.append({
                "node": nid, "class": cls,
                "steps": ins.get("steps"), "cfg": ins.get("cfg"),
                "sampler": ins.get("sampler_name"), "scheduler": ins.get("scheduler"),
                "denoise": ins.get("denoise"), "seed": ins.get("seed") or ins.get("noise_seed"),
            })

    # 正向 / 负向提示词
    pos_start = neg_start = None
    for s in samplers:
        node = nodes.get(s["node"]) or {}
        pos_start = pos_start or _first_ref(node, "positive", "conditioning", "cond")
        neg_start = neg_start or _first_ref(node, "negative", "negative_conditioning")
    pos_texts = _collect_texts(nodes, pos_start) if pos_start else []
    neg_texts = _collect_texts(nodes, neg_start) if neg_start else []

    # 全图文本（含 JSON 串里展开的：MiniMax 导演台把提示词放在 timeline_data 里）
    all_texts = []
    for nid, n in nodes.items():
        for k, v in (n.get("inputs") or {}).items():
            kl = str(k).lower()
            if kl in TEXT_FIELDS and isinstance(v, str):
                all_texts.append({"node": nid, "field": k, "path": None, "class": n.get("class_type"),
                                  "chars": len(v), "preview": _short(v, 80), "raw": v})
            elif k in EMBED_FIELDS and isinstance(v, str):
                for path, txt, neg in _embed_texts(v):
                    all_texts.append({"node": nid, "field": k, "path": path,
                                      "class": n.get("class_type"), "chars": len(txt),
                                      "neg": neg, "preview": _short(txt, 80), "raw": txt})

    # 正向：采样器追到的第一个非负向文本；否则退回全图最长的文本（含 JSON 内文本）
    prompt = None
    pos_ok = [t for t in pos_texts if not t[4]]
    if pos_ok:
        nid, field, val, path, _neg = pos_ok[0]
        prompt = {"node": nid, "field": field, "path": path, "text": val}
    else:
        plain = [t for t in all_texts if not t.get("neg") and t.get("chars", 0) > 0]
        if plain:
            best = max(plain, key=lambda x: x["chars"])
            text = best["preview"]
            if best.get("path"):
                text = ""
            prompt = {"node": best["node"], "field": best["field"],
                      "path": best.get("path"), "text": text}
    if prompt and prompt.get("node"):
        sw = _switch_of(nodes, prompt["node"])
        if sw:
            prompt["switch"] = sw

    negative = None
    neg_ok = [t for t in neg_texts if t[4]] or [t for t in pos_texts if t[4]]
    if neg_ok:
        nid, field, val, path, _neg = neg_ok[0]
        negative = {"node": nid, "field": field, "path": path, "text": val}
    if not negative:
        emb_neg = [t for t in all_texts if t.get("neg") and t.get("chars", 0) > 0]
        if emb_neg:
            b = emb_neg[0]
            negative = {"node": b["node"], "field": b["field"], "path": b.get("path"), "text": ""}

    # 参考图节点
    load_images = []
    for nid, n in nodes.items():
        if (n.get("class_type") or "") == "LoadImage":
            ins = n.get("inputs") or {}
            load_images.append({"node": nid, "field": "image", "value": ins.get("image")})

    # 分辨率：优先采样器 latent_image 追到的空 latent 节点
    size = None
    latent_start = None
    for s in samplers:
        latent_start = latent_start or _first_ref(nodes.get(s["node"]) or {}, "latent_image", "latent")
    order = [latent_start] if latent_start else []
    order += [k for k in nodes if k not in order]
    for nid in order:
        n = nodes.get(nid) or {}
        cls = n.get("class_type") or ""
        if cls in SIZE_NODES:
            wf, hf, lf = SIZE_NODES[cls]
            if not wf:
                continue
            ins = n.get("inputs") or {}
            w, h = ins.get(wf), ins.get(hf)
            if isinstance(w, int) and isinstance(h, int) and w > 0 and h > 0:
                size = {"node": nid, "class": cls, "w_field": wf, "h_field": hf,
                        "width": w, "height": h,
                        "length_field": lf if (lf and isinstance(ins.get(lf), int)) else None}
                break
    # ResolutionSelector：分辨率由「比例 + 百万像素」算出
    if not size:
        for nid, n in nodes.items():
            if (n.get("class_type") or "") not in RATIO_SELECTORS:
                continue
            ins = n.get("inputs") or {}
            ar, mp = ins.get("aspect_ratio"), ins.get("megapixels")
            ml = ins.get("multiple") or 8
            if isinstance(ar, str) and isinstance(mp, (int, float)):
                _w, _h = _ratio_size(ar, mp, ml)
                size = {"node": nid, "class": n.get("class_type"), "virtual": False,
                        "mode": "ratio", "aspect_ratio": ar, "megapixels": float(mp),
                        "multiple": int(ml), "w_field": "aspect_ratio", "h_field": "megapixels",
                        "width": _w, "height": _h, "length_field": None}
                break

    # 通用回退：任意节点上同时有数值 width/height（MiniMax 导演台这类复合节点）
    if not size:
        for nid, n in nodes.items():
            ins = n.get("inputs") or {}
            w, h = ins.get("width"), ins.get("height")
            if (isinstance(w, int) and isinstance(h, int)
                    and 16 <= w <= 8192 and 16 <= h <= 8192):
                size = {"node": nid, "class": n.get("class_type"), "w_field": "width",
                        "h_field": "height", "width": w, "height": h, "length_field": None}
                break

    # 仍然没有：给一个可改的虚拟分辨率（改它会在参考图后插 ImageScale 统一尺寸）
    if not size:
        size = {"node": None, "class": "", "virtual": True,
                "w_field": "width", "h_field": "height",
                "width": 1024, "height": 1024, "length_field": None}
    # 分辨率：只有当空 latent 节点被 latent 开关旁路时才算（此时改分辨率默认不生效）
    if isinstance(size, dict) and size.get("node") and not size.get("virtual"):
        _cls = size.get("class") or ""
        if _cls in SIZE_NODES and SIZE_NODES[_cls][0]:
            _sw = _switch_of(nodes, size["node"])
            if _sw:
                size["switch"] = _sw

    # 给面板用的派生量：当前百万像素与宽高比
    try:
        _w, _h = int(size.get("width") or 0), int(size.get("height") or 0)
        if _w > 0 and _h > 0:
            size["mp"] = round(_w * _h / 1000000.0, 2)
            size["ratio"] = round(float(_w) / float(_h), 4)
    except (TypeError, ValueError):
        pass

    # 时长：视频帧数 + fps
    fps, fps_from = 24, ""
    for nid, n in nodes.items():
        ins = n.get("inputs") or {}
        for f in FPS_FIELDS:
            v = ins.get(f)
            if isinstance(v, (int, float)) and 1 <= v <= 120:
                fps, fps_from = float(v), "%s.%s" % (nid, f)
                break
        if fps_from:
            break
    length = None
    if kind == "video":
        cand = []
        if size and size.get("length_field"):
            cand.append((size["node"], size["length_field"], nodes[size["node"]]["inputs"].get(size["length_field"])))
        for nid, n in nodes.items():
            ins = n.get("inputs") or {}
            for f in LENGTH_FIELDS:
                v = ins.get(f)
                if isinstance(v, int) and v > 0:
                    cand.append((nid, f, v))
        cand = [c for c in cand if isinstance(c[2], int) and c[2] > 0]
        if cand:
            nid, f, frames = cand[0]
            length = {"node": nid, "field": f, "frames": frames, "fps": fps,
                      "duration": round(frames / fps, 2), "fps_from": fps_from}

    # 模式：优先读导演台的 task_type（支持 7 种模式），否则按图片数量推断
    directors = _find_directors(nodes)
    task_key, task_label, mode_from = "", "", ""
    for did in directors:
        raw = (nodes.get(did) or {}).get("inputs", {}).get("task_type")
        k = _resolve_task_key(raw)
        if k in TASK_MODES:
            task_key, task_label, mode_from = k, TASK_MODES[k][0], "导演台 task_type"
            break
    refs = _collect_refs(nodes, directors)
    # 导演台：提示词落在导演节点自己身上时，时间轴里每段的 prompt 才是这一段的正文，
    # 优先于导演节点的 global_prompt；若提示词已在外部组节点（组 prompt 才生效）则不动。
    if directors and prompt and str(prompt.get("node")) in directors:
        segs = [t for t in all_texts
                if str(t.get("node")) == str(prompt.get("node")) and t.get("path")
                and re.match(r"^segments\[\d+\]\.prompt$", str(t.get("path")))
                and not t.get("neg") and t.get("chars", 0) > 0]
        if segs:
            segs.sort(key=lambda x: x.get("chars", 0), reverse=True)
            b = segs[0]
            prompt = {"node": b["node"], "field": b["field"], "path": b["path"],
                      "text": b.get("raw") or b.get("preview") or "",
                      "segments": len(segs)}

    n_filled = len([r for r in refs if not r.get("empty")])
    if task_key:
        mode = task_key
    elif kind == "video":
        n_img = max(n_filled, len(load_images))
        mode = "fl2v" if n_img >= 2 else ("i2v" if n_img == 1 else "t2v")
    else:
        mode = "i2i" if (n_filled or load_images) else "t2i"

    loras = _lora_slots(nodes)
    models = _model_slots(nodes)
    _sw_suffix = ""
    _size_sw = (size or {}).get("switch") if isinstance(size, dict) else None
    if isinstance(_size_sw, dict) and _size_sw.get("on") is False:
        _sw_suffix = ("（分辨率节点被 latent 开关 %s 旁路——该工作流默认按参考图尺寸定 latent；"
                      "改分辨率时插件会自动切到固定 latent）" % _size_sw["node"])

    return {
        "kind": kind, "mode": mode,
        "mode_label": TASK_MODES.get(mode, (mode,))[0],
        "mode_desc": TASK_MODES.get(mode, ("", "", 0))[1],
        "mode_need": TASK_MODES.get(mode, ("", "", 0))[2],
        "mode_from": mode_from,
        "task_type": (nodes.get(directors[0]) or {}).get("inputs", {}).get("task_type") if directors else None,
        "director": directors[0] if directors else None,
        "refs": refs,
        "prompt": prompt, "negative": negative,
        "size": size, "length": length,
        "presets": {"image": [list(x) for x in RES_PRESETS["image"]],
                    "video": [list(x) for x in RES_PRESETS["video"]]},
        "outputs": outputs, "load_images": load_images,
        "samplers": samplers,
        "texts": [{k2: v2 for k2, v2 in t.items() if k2 != "raw"} for t in all_texts],
        "loras": loras, "models": models,
        "nodes": len(nodes),
        "note": _detect_note(kind, prompt, size, length, len(all_texts), mode, refs) + _sw_suffix
                + (("（提示词接在开关节点 %s 上，生成时插件会自动打开它）" % prompt["switch"]["node"])
                   if (prompt and prompt.get("switch")) else ""),
    }


def _detect_note(kind, prompt, size, length, ntexts=0, mode="", refs=None):
    miss = []
    if not prompt:
        miss.append("提示词节点")
    if not size:
        miss.append("分辨率节点")
    if kind == "video" and not length:
        miss.append("时长（帧数）节点")
    if miss:
        return "未识别到：%s —— 可在导入后手动指定" % "、".join(miss)
    tips = []
    if prompt and prompt.get("path"):
        tips.append("提示词在复合节点的 JSON 里：%s.%s → %s" % (
            prompt.get("node"), prompt.get("field"), prompt.get("path")))
    if prompt and prompt.get("segments") and prompt["segments"] > 1:
        tips.append("时间轴有 %d 段提示词，插件只写 %s 这一段" % (prompt["segments"], prompt.get("path")))
    elif ntexts > 1:
        tips.append("共 %d 个文本位置，保存前可改选" % ntexts)
    note = "；".join(tips)
    if mode in ("v2v", "rv2v"):
        note = (note + "；" if note else "") + "该模式要源视频：在工作流里换 VHS_LoadVideo 的 video"
    return note


# ------------------------------------------------------------------ 组装与提交
def _set_text(graph, slot, text):
    """写提示词槽位。slot 带 path 时表示文本藏在 JSON 串里，需要改完再序列化回去。"""
    if not slot:
        return False
    nid, field, path = slot.get("node"), slot.get("field"), slot.get("path")
    if nid not in graph or not field:
        return False
    ins = graph[nid].setdefault("inputs", {})
    if path:
        raw = ins.get(field)
        try:
            obj = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError):
            return False
        if not isinstance(obj, (dict, list)) or not _path_set(obj, path, str(text or "")):
            return False
        ins[field] = json.dumps(obj, ensure_ascii=False)
        return True
    ins[field] = str(text or "")
    return True


def _sync_prompt_twin(graph, slot, text):
    """导演台把同一段提示词存了两份：节点 inputs.global_prompt 与 timeline_data 里的 global.prompt。
    只写一处会出现「面板里改了、ComfyUI 跑出来还是旧的」，这里把另一处一并同步。"""
    if not slot:
        return False
    nid, field, path = slot.get("node"), slot.get("field"), slot.get("path")
    if nid not in graph:
        return False
    ins = graph[nid].setdefault("inputs", {})
    done = False
    if field == "global_prompt":
        done = _set_text(graph, {"node": nid, "field": "timeline_data", "path": "global.prompt"}, text)
    elif path == "global.prompt":
        done = _set_text(graph, {"node": nid, "field": "global_prompt", "path": None}, text)
    return done


def _sync_embed(graph, nid, updates):
    """把尺寸/时长同步进同节点的 JSON 串（timeline_data 里也存了一份宽高与帧数）。"""
    ins = graph[nid].get("inputs") or {}
    for field in EMBED_FIELDS:
        raw = ins.get(field)
        if not isinstance(raw, str):
            continue
        try:
            obj = json.loads(raw)
        except ValueError:
            continue
        if not isinstance(obj, dict):
            continue
        changed = False
        for path, val in updates:
            if _path_set(obj, path, val):
                changed = True
        if changed:
            ins[field] = json.dumps(obj, ensure_ascii=False)


SCALE_TYPES = ("ImageScale", "ImageResize", "ResizeImage")


def _next_id(graph, base):
    n = base
    while n in graph:
        n = str(int(n) + 1) if str(n).isdigit() else n + "_"
    return n


def _max_id(graph):
    nums = [int(k) for k in graph if str(k).isdigit()]
    return (max(nums) + 1) if nums else 1


def _inject_scale(graph, w, h):
    """工作流本身没有分辨率节点时：在每张参考图后插一个 ImageScale，把尺寸统一到 w×h。
    纯文生图（没有 LoadImage）则改/建 EmptyImage 接给 VAEEncode。"""
    w, h = int(w), int(h)
    loads = [k for k, v in graph.items()
             if isinstance(v, dict) and str(v.get("class_type") or "").endswith("LoadImage")]
    if not loads:
        for nid, n in graph.items():
            if not isinstance(n, dict):
                continue
            ins = n.get("inputs") or {}
            if n.get("class_type") not in ("VAEEncode", "VAEEncodeForInpaint", "VAEEncodeTiled"):
                continue
            src = ins.get("pixels")
            if _is_ref(src) and str(src[0]) in graph:
                node = graph[str(src[0])]
                if str(node.get("class_type") or "") in ("EmptyImage", "EmptyLatentImage"):
                    node.setdefault("inputs", {})["width"] = w
                    node["inputs"]["height"] = h
                    return True
            new = _next_id(graph, str(_max_id(graph)))
            graph[new] = {"class_type": "EmptyImage",
                          "inputs": {"width": w, "height": h, "batch_size": 1, "color": 0}}
            ins["pixels"] = [new, 0]
            return True
        return False
    changed = False
    for lid in loads:
        lid = str(lid)
        hit = None
        for nid, n in graph.items():
            if not isinstance(n, dict) or str(n.get("class_type") or "") not in SCALE_TYPES:
                continue
            ins = n.get("inputs") or {}
            if _is_ref(ins.get("image")) and str(ins["image"][0]) == lid:
                hit = nid
                break
        if hit:
            ins = graph[hit].setdefault("inputs", {})
            ins["width"], ins["height"] = w, h
            changed = True
            continue
        users = []
        for nid, n in graph.items():
            for k, v in ((n or {}).get("inputs") or {}).items():
                if _is_ref(v) and str(v[0]) == lid and int(v[1]) == 0:
                    users.append((nid, k))
        if not users:
            continue
        new = _next_id(graph, str(_max_id(graph)))
        graph[new] = {"class_type": "ImageScale",
                      "inputs": {"image": [lid, 0], "upscale_method": "lanczos",
                                 "width": w, "height": h, "crop": "disabled"}}
        for nid, k in users:
            graph[nid]["inputs"][k] = [new, 0]
        changed = True
    return changed


def _patch_detect(d):
    """老工作流存下来的 detect 快照没有 presets/mp/ratio —— 读的时候补上，不改存储。"""
    if not isinstance(d, dict):
        return d
    sz = d.get("size") or {}
    try:
        _w, _h = int(sz.get("width") or 0), int(sz.get("height") or 0)
        if _w > 0 and _h > 0:
            sz.setdefault("mp", round(_w * _h / 1000000.0, 2))
            sz.setdefault("ratio", round(float(_w) / float(_h), 4))
    except (TypeError, ValueError):
        pass
    d.setdefault("presets", {"image": [list(x) for x in RES_PRESETS["image"]],
                             "video": [list(x) for x in RES_PRESETS["video"]]})
    return d


def _ratio_size(ar, mp, multiple=8):
    """复刻 ComfyUI ResolutionSelector 的算法：按比例 + 百万像素算宽高。"""
    table = {n: (a, b) for n, a, b in RATIO_OPTIONS}
    a, b = table.get(str(ar), (1, 1))
    try:
        total = float(mp or 1.0) * 1024 * 1024
        m = max(8, int(multiple or 8))
    except (TypeError, ValueError):
        return 1024, 1024
    scale = (total / float(a * b)) ** 0.5
    w = int(round(a * scale / m)) * m
    h = int(round(b * scale / m)) * m
    return max(m, w), max(m, h)


def _pick_ratio(w, h):
    """给定宽高，选最接近的比例（按对数误差）。"""
    try:
        r = float(w) / float(h)
    except (TypeError, ValueError, ZeroDivisionError):
        return RATIO_OPTIONS[0]
    best, best_d = RATIO_OPTIONS[0], 1e9
    for name, a, b in RATIO_OPTIONS:
        d = abs((r / (float(a) / float(b))) ** 1.0 - 1.0) if r > 0 else 1e9
        if d < best_d:
            best, best_d = (name, a, b), d
    return best


def _model_slots(nodes):
    """工作流里所有可换的模型文件槽（unet/clip/vae/lora…）。"""
    out = []
    for nid, n in nodes.items():
        ins = n.get("inputs") or {}
        for f, kind in MODEL_FIELDS:
            v = ins.get(f)
            if isinstance(v, str) and v and not _is_ref(v):
                out.append({"node": nid, "class": n.get("class_type"), "field": f,
                            "value": v, "kind": kind})
    return out


def _lora_slots(nodes):
    """工作流里挂的 LoRA（名称 + 两个强度）。"""
    out = []
    for nid, n in nodes.items():
        cls = n.get("class_type") or ""
        ins = n.get("inputs") or {}
        if "lora" not in cls.lower():
            continue
        name = ins.get("lora_name")
        if not isinstance(name, str) or not name:
            continue
        out.append({"node": nid, "class": cls, "name": name,
                    "strength_model": ins.get("strength_model"),
                    "strength_clip": ins.get("strength_clip")})
    return out


def _mp_size(mp, ratio):
    """按目标百万像素 + 宽高比算宽高（8 的倍数，最小 16）。"""
    try:
        mp, ratio = float(mp), float(ratio or 1.0)
    except (TypeError, ValueError):
        return None
    if mp <= 0 or ratio <= 0:
        return None
    w = max(16, int(round((mp * 1000000.0 * ratio) ** 0.5 / 8.0)) * 8)
    h = max(16, int(round(w / ratio / 8.0)) * 8)
    return w, h


def _set_size(graph, size, w, h):
    if not size or not w or not h:
        return False
    if size.get("mode") == "ratio":
        rid = str(size.get("node") or "")
        if rid in graph:
            name, _a, _b = _pick_ratio(w, h)
            ins = graph[rid].setdefault("inputs", {})
            ins["aspect_ratio"] = name
            ins["megapixels"] = round(float(w) * float(h) / (1024.0 * 1024.0), 3)
            return True
        return False
    nid = size.get("node")
    if nid and nid in graph:
        ins = graph[nid].setdefault("inputs", {})
        ins[size.get("w_field") or "width"] = int(w)
        ins[size.get("h_field") or "height"] = int(h)
        _sync_embed(graph, nid, [("width", int(w)), ("height", int(h)),
                                 ("output.width", int(w)), ("output.height", int(h))])
        return True
    if size.get("virtual") or not nid:
        return _inject_scale(graph, w, h)
    return False


def _set_length(graph, length, duration):
    if not length or not duration:
        return False
    nid = length.get("node")
    if nid in graph:
        fps = float(length.get("fps") or 24)
        frames = max(1, int(round(float(duration) * fps)))
        graph[nid].setdefault("inputs", {})[length.get("field") or "length"] = frames
        _sync_embed(graph, nid, [("totalFrames", frames), ("frameCount", frames),
                                 ("frameRate", int(fps)), ("durationSec", float(duration)),
                                 ("segments[0].frameCount", frames),
                                 ("segments[0].length", frames),
                                 ("segments[0].durationSec", float(duration))])
        return True
    return False


def _set_seed(graph, samplers, seed):
    if seed in (None, ""):
        return False
    ok = False
    for s in samplers:
        nid = s.get("node")
        if nid in graph:
            ins = graph[nid].setdefault("inputs", {})
            for k in ("seed", "noise_seed"):
                if k in ins:
                    ins[k] = int(seed)
                    ok = True
    return ok


def _upload(ctx, name, data_url):
    """把 dataURL 传到 ComfyUI 的 input 目录，返回文件名。"""
    m = re.match(r"^data:([^;]+);base64,(.*)$", str(data_url or ""), re.S)
    if not m:
        raise ValueError("参考图格式不对（需要 dataURL）")
    blob = base64.b64decode(m.group(2))
    ext = ".png"
    mt = m.group(1)
    if "jpeg" in mt or "jpg" in mt:
        ext = ".jpg"
    elif "webp" in mt:
        ext = ".webp"
    fname = re.sub(r"[^0-9a-zA-Z_.-]+", "_", str(name or "ref"))[:40] or "ref"
    if not fname.lower().endswith(IMG_EXT):
        fname += ext
    fname = "pm_%d_%s" % (int(time.time()), fname)
    boundary = "----pm" + uuid.uuid4().hex
    parts = []
    parts.append(("--%s\r\n" % boundary).encode())
    parts.append(('Content-Disposition: form-data; name="image"; filename="%s"\r\n' % fname).encode())
    parts.append(b"Content-Type: application/octet-stream\r\n\r\n")
    parts.append(blob)
    parts.append(b"\r\n")
    parts.append(("--%s\r\n" % boundary).encode())
    parts.append(b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n')
    parts.append(("--%s--\r\n" % boundary).encode())
    body = b"".join(parts)
    rq = urllib.request.Request(_base(ctx) + "/upload/image", data=body, method="POST",
                                headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(rq, timeout=60) as r:
        j = json.loads(r.read().decode("utf-8", "replace"))
    nm = j.get("name") or fname
    sub = j.get("subfolder") or ""
    return (sub + "/" + nm) if sub else nm


def _history(ctx, prompt_id):
    return _json(_base(ctx) + "/history/" + urllib.parse.quote(prompt_id), timeout=20)


def _mime_of(name):
    ext = os.path.splitext(str(name or ""))[1].lower()
    return {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
            ".webp": "image/webp", ".gif": "image/gif",
            ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
            ".mp3": "audio/mpeg", ".wav": "audio/wav"}.get(ext, "application/octet-stream")


def _out_dir(ctx, prompt_id):
    """产物的本地缓存目录（生成完成后落盘，ComfyUI 清了也还能看）。"""
    d = os.path.join(ctx.data_dir, "out", str(prompt_id))
    os.makedirs(d, exist_ok=True)
    return d


def _cache_output(ctx, prompt_id, outs):
    """把产物拉到本地缓存；已存在就跳过。返回真正可读的本地路径列表。"""
    got = []
    for o in outs:
        name = os.path.basename(str(o.get("filename") or ""))
        if not name:
            continue
        path = os.path.join(_out_dir(ctx, prompt_id), name)
        if os.path.exists(path) and os.path.getsize(path) > 0:
            o["cached"] = True
            got.append(path)
            continue
        qs = urllib.parse.urlencode({"filename": o.get("filename") or "",
                                     "subfolder": o.get("subfolder") or "",
                                     "type": o.get("type") or "output"})
        try:
            headers, data = _req(_base(ctx) + "/view?" + qs, timeout=120, raw=False)
            if data:
                with open(path, "wb") as f:
                    f.write(data)
                o["cached"] = True
                got.append(path)
        except Exception as e:  # noqa: BLE001
            ctx.log("缓存产物失败 %s：%s" % (name, e))
    return got


def _outputs_from(hist, prompt_id):
    """从 /history 里捞出产物列表。"""
    node = (hist or {}).get(prompt_id) or {}
    outs = []
    for nid, o in (node.get("outputs") or {}).items():
        for key in ("images", "gifs", "videos", "video"):
            for f in (o.get(key) or []):
                if isinstance(f, dict) and f.get("filename"):
                    name = f["filename"]
                    kind = "video" if (key != "images" or name.lower().endswith(VID_EXT) and not name.lower().endswith(".webp")) else "image"
                    if key in ("gifs", "videos", "video"):
                        kind = "video"
                    outs.append({"kind": kind, "filename": name,
                                 "subfolder": f.get("subfolder") or "", "type": f.get("type") or "output",
                                 "node": nid})
    return outs, node.get("status") or {}


# ------------------------------------------------------------------ 注册
def _apply_models(graph, picked):
    """把 [{node, field, value}] 写回图；返回改动条数。"""
    n_ch = 0
    if not isinstance(picked, list):
        return 0
    for m in picked:
        if not isinstance(m, dict):
            continue
        nid, f, val = str(m.get("node") or ""), str(m.get("field") or ""), m.get("value")
        if nid in graph and f and isinstance(val, str) and val:
            graph[nid].setdefault("inputs", {})[f] = val
            n_ch += 1
    return n_ch


def _apply_loras(graph, lora_in):
    """把 [{node, strength_model, strength_clip}] 写回图；返回改动条数。"""
    n_ch = 0
    if not isinstance(lora_in, list):
        return 0
    for lo in lora_in:
        if not isinstance(lo, dict):
            continue
        nid = str(lo.get("node") or "")
        if nid not in graph:
            continue
        ins = graph[nid].setdefault("inputs", {})
        for f in ("strength_model", "strength_clip"):
            if lo.get(f) is None:
                continue
            try:
                ins[f] = float(lo[f])
                n_ch += 1
            except (TypeError, ValueError):
                pass
    return n_ch


def register(ctx):
    ctx.log("ComfyUI 工作流插件加载，ComfyUI=%s" % _base(ctx))

    # ---- 导入
    @ctx.route("import", ["POST"])
    def _import(body, query):
        raw = body.get("workflow")
        if raw is None:
            txt = str(body.get("json") or "").strip()
            if not txt:
                return {"ok": False, "error": "没有收到工作流内容"}
            try:
                raw = json.loads(txt)
            except ValueError as e:
                return {"ok": False, "error": "JSON 解析失败：%s（请确认是「导出（API）」得到的文件）" % e}
        if not isinstance(raw, dict) or not raw:
            return {"ok": False, "error": "工作流格式不对：需要在 ComfyUI 里用「导出（API）」得到 json"}
        # 兼容 {"prompt": {...}} 包了一层的写法
        if "prompt" in raw and isinstance(raw["prompt"], dict) and not any(
                isinstance(v, dict) and v.get("class_type") for v in raw.values()):
            raw = raw["prompt"]
        nodes = {k: v for k, v in raw.items() if isinstance(v, dict) and v.get("class_type")}
        if not nodes:
            return {"ok": False, "error": "这不是 API 格式工作流（节点没有 class_type）。请在 ComfyUI 菜单里选「导出（API）」"}
        info = detect(raw)
        name = str(body.get("name") or "").strip() or "工作流 %d" % (len(_load_index(ctx)) + 1)
        wid = _new_id(name)
        with open(_wf_path(ctx, wid), "w", encoding="utf-8") as f:
            json.dump(raw, f, ensure_ascii=False)
        item = {"id": wid, "name": name, "kind": info["kind"], "mode": info["mode"],
                "nodes": info["nodes"], "detect": info, "created": int(time.time())}
        items = _load_index(ctx)
        items.append(item)
        _save_index(ctx, items)
        ctx.log("导入工作流 %s（%s，%d 节点）" % (name, info["kind"], info["nodes"]))
        return {"ok": True, "item": item}

    @ctx.route("workflows", ["GET"])
    def _list(body, query):
        items = [_patch_detect(it) for it in _load_index(ctx)]
        return {"ok": True, "items": items, "count": len(items), "comfy": _base(ctx)}

    @ctx.route("detail", ["GET"])
    def _detail(body, query):
        wid = str(query.get("id") or "")
        for it in _load_index(ctx):
            if it["id"] == wid:
                return {"ok": True, "item": _patch_detect(it), "graph": _load_graph(ctx, wid)}
        return {"ok": False, "error": "没有这个工作流"}

    @ctx.route("save", ["POST"])
    def _save(body, query):
        wid = str(body.get("id") or "")
        items = _load_index(ctx)
        for it in items:
            if it["id"] != wid:
                continue
            if body.get("name"):
                it["name"] = str(body["name"]).strip()
            slots = body.get("slots")
            if isinstance(slots, dict):
                d = it.setdefault("detect", {})
                for k in ("prompt", "negative", "size", "length"):
                    if k in slots:
                        d[k] = slots[k]
                if body.get("mode"):
                    it["mode"] = str(body["mode"])
                    d["mode"] = str(body["mode"])
            _save_index(ctx, items)
            return {"ok": True, "item": it}
        return {"ok": False, "error": "没有这个工作流"}

    @ctx.route("delete", ["POST"])
    def _delete(body, query):
        wid = str(body.get("id") or "")
        items = [x for x in _load_index(ctx) if x["id"] != wid]
        _save_index(ctx, items)
        try:
            os.remove(_wf_path(ctx, wid))
        except OSError:
            pass
        return {"ok": True, "items": items}

    # ---- 运行
    @ctx.route("persist", ["POST"])
    def _persist(body, query):
        """把面板上改过的参数写回已保存的工作流文件（下次打开/生成沿用）。"""
        wid = str(body.get("id") or "")
        items = _load_index(ctx)
        item = next((x for x in items if x["id"] == wid), None)
        if not item:
            return {"ok": False, "error": "没有这个工作流"}
        try:
            graph = _load_graph(ctx, wid)
        except (OSError, ValueError) as e:
            return {"ok": False, "error": "读工作流失败：%s" % e}
        d = item.get("detect") or {}
        changed = []
        if body.get("prompt"):
            if _set_text(graph, d.get("prompt"), body["prompt"]):
                _sync_prompt_twin(graph, d.get("prompt"), body["prompt"])
                _open_switch(graph, d.get("prompt") or {}, "提示词", changed)
                changed.append("提示词")
        if body.get("negative"):
            if _set_text(graph, d.get("negative"), body["negative"]):
                changed.append("负向")
        w = body.get("width") or None
        h = body.get("height") or None
        if body.get("mp") and not (w and h):
            sz0 = d.get("size") or {}
            ratio = sz0.get("ratio") or (
                (float(sz0.get("width") or 1) / float(sz0.get("height") or 1)) if sz0.get("height") else 1.0)
            wh = _mp_size(body.get("mp"), ratio)
            if wh:
                w, h = wh
        if w and h and _set_size(graph, d.get("size"), w, h):
            _open_switch(graph, d.get("size") or {}, "latent", changed)
            changed.append("分辨率 %d×%d" % (int(w), int(h)))
        if body.get("duration") and _set_length(graph, d.get("length"), body.get("duration")):
            changed.append("时长")
        if body.get("seed") not in (None, "") and _set_seed(graph, d.get("samplers") or [], body["seed"]):
            changed.append("种子")
        n_ch = _apply_models(graph, body.get("models"))
        if n_ch:
            changed.append("模型×%d" % n_ch)
        n_ch = _apply_loras(graph, body.get("loras"))
        if n_ch:
            changed.append("LoRA 强度")

        if not changed:
            return {"ok": True, "changed": [], "item": item, "note": "没有需要保存的改动"}
        try:
            with open(_wf_path(ctx, wid), "w", encoding="utf-8") as f:
                json.dump(graph, f, ensure_ascii=False)
        except OSError as e:
            return {"ok": False, "error": "写工作流失败：%s" % e}
        info = detect(graph)
        item.update({"kind": info["kind"], "mode": info["mode"],
                     "nodes": info["nodes"], "detect": info, "saved": int(time.time())})
        _save_index(ctx, items)
        ctx.log("保存工作流改动 %s：%s" % (item.get("name"), "、".join(changed)))
        return {"ok": True, "changed": changed, "item": item}

    @ctx.route("run", ["POST"])
    def _run(body, query):
        wid = str(body.get("id") or "")
        items = _load_index(ctx)
        item = next((x for x in items if x["id"] == wid), None)
        if not item:
            return {"ok": False, "error": "没有这个工作流"}
        try:
            graph = _load_graph(ctx, wid)
        except (OSError, ValueError) as e:
            return {"ok": False, "error": "读工作流失败：%s" % e}
        d = item.get("detect") or {}
        used = []

        if body.get("prompt"):
            if _set_text(graph, d.get("prompt"), body["prompt"]):
                used.append("提示词")
                if _sync_prompt_twin(graph, d.get("prompt"), body["prompt"]):
                    used.append("同步提示词副本")
                _open_switch(graph, d.get("prompt") or {}, "提示词", used)
        neg = body.get("negative")
        if neg in (None, ""):
            neg = ctx.get("default_negative") or ""
        if neg:
            if _set_text(graph, d.get("negative"), neg):
                used.append("负向")
        if item.get("kind") == "video":
            if _set_length(graph, d.get("length"), body.get("duration")):
                used.append("时长")
        w = body.get("width") or None
        h = body.get("height") or None
        mp_from, sz = None, (d.get("size") or {})
        if body.get("mp") and not (w and h):
            ratio = sz.get("ratio") or (
                (float(sz.get("width") or 1) / float(sz.get("height") or 1)) if sz.get("height") else 1.0)
            wh = _mp_size(body.get("mp"), ratio)
            if wh:
                w, h = wh
                mp_from = float(body.get("mp"))
        if (w and h) and _set_size(graph, d.get("size"), w, h):
            used.append("像素 %.2fMP（%d×%d）" % (mp_from, w, h) if mp_from else "分辨率")
            _open_switch(graph, d.get("size") or {}, "latent", used)
            _sz = d.get("size") or {}
            if _sz.get("mode") == "ratio":
                # ResolutionSelector 只能按「比例 + 百万像素」算，回填它真正会算出的尺寸
                _rid = str(_sz.get("node") or "")
                _ins = (graph.get(_rid) or {}).get("inputs") or {}
                if _ins:
                    w, h = _ratio_size(_ins.get("aspect_ratio"),
                                       _ins.get("megapixels"), _ins.get("multiple"))
                    used.append("按比例算出 %d×%d" % (w, h))
        if body.get("seed") not in (None, ""):
            if _set_seed(graph, d.get("samplers") or [], body["seed"]):
                used.append("种子")

        n_ch = _apply_models(graph, body.get("models"))
        if n_ch:
            used.append("模型×%d" % n_ch)
        n_ch = _apply_loras(graph, body.get("loras"))
        if n_ch:
            used.append("LoRA 强度")

        # 参考图：优先按识别到的槽位顺序填（组·首帧/尾帧/参考图N），空槽新建 LoadImage
        imgs = body.get("images") or []
        refs = d.get("refs") or []
        loaders = d.get("load_images") or []
        up, filled, made = [], [], 0
        targets = refs if refs else [{"node": x["node"], "field": "image",
                                      "label": "图片 %s" % x["node"], "empty": False} for x in loaders]

        def _new_loader(graph_, host_id, host_field):
            nid = str(max([int(k) for k in graph_ if str(k).isdigit()] + [0]) + 1)
            graph_[nid] = {"class_type": "LoadImage", "inputs": {"image": "", "upload": "image"}}
            host = graph_.get(host_id) or {}
            host.setdefault("inputs", {})[host_field] = [nid, 0]
            return nid

        for i, im in enumerate(imgs[:max(1, len(targets))] if targets else []):
            if not isinstance(im, dict) or not im.get("data_url"):
                continue
            try:
                nm = _upload(ctx, im.get("name") or "ref%d" % (i + 1), im["data_url"])
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": "参考图上传失败：%s（ComfyUI 是否在运行？）" % e}
            up.append(nm)
            if i >= len(targets):
                continue
            t = targets[i]
            nid = t.get("node")
            if not nid:
                # 槽空着：给宿主组节点新建一个 LoadImage 并接连线
                host = t.get("host")
                if host and host in graph:
                    nid = _new_loader(graph, host, t.get("field") or "first_frame")
                    made += 1
                else:
                    continue
            if nid in graph:
                graph[nid].setdefault("inputs", {})["image"] = nm
                filled.append(t.get("label") or nid)
        if up:
            used.append("参考图×%d" % len(up))
            if filled:
                used.append("填入：" + "、".join(filled[:6]) + ("…" if len(filled) > 6 else ""))
            if made:
                used.append("新建图槽×%d" % made)

        try:
            res = _json(_base(ctx) + "/prompt",
                        {"prompt": graph, "client_id": "pm-" + uuid.uuid4().hex[:8]}, timeout=30)
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", "replace")[:600]
            except Exception:  # noqa: BLE001
                pass
            return {"ok": False, "error": "ComfyUI 拒绝了这次提交（HTTP %d）：%s" % (e.code, detail or e.reason)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "连不上 ComfyUI（%s）：%s。请先启动 ComfyUI，或在设置里改地址。" % (_base(ctx), e)}
        pid = res.get("prompt_id")
        if not pid:
            return {"ok": False, "error": "ComfyUI 没返回 prompt_id：%s" % json.dumps(res, ensure_ascii=False)[:300]}
        return {"ok": True, "prompt_id": pid, "id": wid, "used": used,
                "size": {"width": w, "height": h} if (w and h) else None,
                "frames": (d.get("length") or {}).get("frames") if body.get("duration") else None}

    @ctx.route("status", ["GET"])
    def _status(body, query):
        pid = str(query.get("prompt_id") or "")
        if not pid:
            return {"ok": False, "error": "缺少 prompt_id"}
        try:
            hist = _history(ctx, pid)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "查询进度失败：%s" % e}
        node = (hist or {}).get(pid)
        if not node:
            return {"ok": True, "state": "running", "outputs": []}
        outs, st = _outputs_from(hist, pid)
        state = "done" if outs else ("error" if str(st.get("status_str")) == "error" else "running")
        base = _base(ctx)
        if state == "done":
            try:
                _cache_output(ctx, pid, outs)
            except Exception as e:  # noqa: BLE001
                ctx.log("产物落盘失败：%s" % e)
        for o in outs:
            o["url"] = "/api/plugin/comfy_runner/view?" + urllib.parse.urlencode(
                {"prompt_id": pid, "filename": o["filename"],
                 "subfolder": o["subfolder"], "type": o["type"]})
        return {"ok": True, "state": state, "outputs": outs, "status": st, "comfy": base,
                "out_dir": os.path.join(ctx.data_dir, "out", pid) if state == "done" else ""}

    @ctx.route("view", ["GET"])
    def _view(body, query):
        name = os.path.basename(str(query.get("filename") or ""))
        pid = str(query.get("prompt_id") or "")
        ctype = _mime_of(name)
        # ① 本地缓存（生成完成时已落盘，ComfyUI 清了也能看）
        if pid and name:
            p = os.path.join(_out_dir(ctx, pid), name)
            if os.path.exists(p) and os.path.getsize(p) > 0:
                with open(p, "rb") as f:
                    return {"_raw": {"mime": ctype, "data": f.read()}}
        # ② 回源 ComfyUI
        qs = urllib.parse.urlencode({
            "filename": query.get("filename", ""),
            "subfolder": query.get("subfolder", ""),
            "type": query.get("type", "output"),
        })
        try:
            headers, data = _req(_base(ctx) + "/view?" + qs, timeout=120, raw=False)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "取文件失败：%s" % e}
        ctype = headers.get("Content-Type") or ctype
        if pid and name and data:
            try:
                with open(os.path.join(_out_dir(ctx, pid), name), "wb") as f:
                    f.write(data)
            except Exception:  # noqa: BLE001
                pass
        return {"_raw": {"mime": ctype, "data": data}}

    @ctx.route("options", ["GET"])
    def _options(body, query):
        cls = str(query.get("cls") or "").strip()
        field = str(query.get("field") or "").strip()
        if not cls or not field:
            return {"ok": False, "error": "需要 cls 与 field"}
        try:
            info = _json(_base(ctx) + "/object_info/" + urllib.parse.quote(cls), timeout=8)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": "连不上 ComfyUI（%s）：%s" % (_base(ctx), e)}
        node = info.get(cls) or {}
        spec = None
        for sec in ("required", "optional"):
            cur = ((node.get("input") or {}).get(sec) or {}).get(field)
            if cur:
                spec = cur
                break
        opts = []
        if isinstance(spec, list) and spec and isinstance(spec[0], list):
            opts = [str(x) for x in spec[0] if isinstance(x, (str, int, float))]
        return {"ok": True, "cls": cls, "field": field, "options": opts}

    @ctx.route("ping", ["GET"])
    def _ping(body, query):
        try:
            s = _json(_base(ctx) + "/system_stats", timeout=5)
            dev = (s.get("devices") or [{}])[0]
            return {"ok": True, "comfy": _base(ctx), "device": dev.get("name") or "",
                    "vram_total": dev.get("vram_total"), "vram_free": dev.get("vram_free")}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "comfy": _base(ctx), "error": str(e)}
