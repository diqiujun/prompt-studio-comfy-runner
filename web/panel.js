/* ComfyUI 工作流插件 · 面板脚本 */
(function () {
  if (!window.PSPlugin) return;

  var API = "/api/plugin/comfy_runner/";
  var KINDS = { video: "视频", image: "图片" };
  var MODES = [
    ["t2v", "文生视频"], ["i2v", "图生视频（首帧）"], ["fl2v", "首尾帧视频"],
    ["r2v", "参考主体生视频"], ["v2v", "视频转视频"], ["rv2v", "参考素材改视频"],
    ["mixed", "混合模式（按段）"],
    ["t2i", "文生图"], ["i2i", "图生图"]
  ];
  // 哪些模式需要用 PM 里的参考图
  var NEED_IMG = { i2v: 1, fl2v: 1, r2v: 1, v2v: 0, rv2v: 1, mixed: 1, i2i: 1 };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function q(sel, root) { return (root || document).querySelector(sel); }
  function toast(m, t, api) { (api || PSPlugin).toast(m, t); }

  function render(el, api) {
    var S = { items: [], cur: null, tab: "gen", busy: false, timer: null, last: null };
    var PICK = { models: {}, options: {}, lora: {}, nodeEdits: {}, nodeData: null };

    el.innerHTML =
      '<div class="cr-tabs">' +
      '  <button class="cr-tab on" data-tab="gen">生成</button>' +
      '  <button class="cr-tab" data-tab="imp">导入工作流</button>' +
      '  <span class="cr-dot" id="crDot" title="ComfyUI 连接状态"></span>' +
      '  <span class="mini" id="crConn">检测中…</span>' +
      '</div>' +

      /* ---------------- 生成 ---------------- */
      '<div class="cr-pane" data-pane="gen">' +
      '  <div class="cr-row">' +
      '    <select class="cr-sel" id="crWf"><option value="">（还没有导入工作流）</option></select>' +
      '    <button class="cr-btn sm" id="crReload" title="重新载入列表">刷新</button>' +
      '  </div>' +
      '  <div class="mini" id="crWfMeta"></div>' +
      '  <label class="cr-lb">提示词</label>' +
      '  <textarea class="cr-ta" id="crPrompt" rows="4" placeholder="写上这一张 / 这一段要什么画面。留空＝沿用工作流里的原文。"></textarea>' +
      '  <div class="mini" id="crWhere"></div>' +
      '  <div class="cr-row cr-picks"><button class="cr-btn sm" id="crFromDesc" title="把左边「内容描述」搬过来">取描述</button>' +
      '    <button class="cr-btn sm" id="crFromResult" title="把右边生成结果里的提示词搬过来">取结果</button>' +
      '    <button class="cr-btn sm" id="crFromHis" title="取历史里最近一条生成结果">取历史</button>' +
      '    <button class="cr-btn sm" id="crNegTg">负向提示词</button></div>' +
      '  <div id="crNegWrap" style="display:none"><textarea class="cr-ta" id="crNeg" rows="2" placeholder="负向词（留空＝不改工作流里的负向）"></textarea></div>' +
      '  <div class="cr-grid" id="crParams"></div>' +
      '  <div class="cr-row"><button class="cr-btn primary" id="crRun">生成</button>' +
      '    <span class="mini" id="crRunHint"></span></div>' +
      '  <div class="cr-prog" id="crProg" style="display:none"><i></i></div>' +
      '  <div class="cr-out" id="crOut"></div>' +
      '</div>' +

      /* ---------------- 导入 ---------------- */
      '<div class="cr-pane" data-pane="imp" style="display:none">' +
      '  <div class="mini">这里只放 ComfyUI 导出的 <b>API json</b>（ComfyUI 菜单 → 工作流 → 导出（API））。</div>' +
      '  <div class="mini" style="margin-top:2px">提示词不用在这里导入——到「生成」页把 PM 的提示词一键带过去（取描述 / 取结果 / 取历史），生成时它会写进工作流的提示词字段。</div>' +
      '  <div class="cr-drop" id="crDrop"><b>把 api json 拖到这里</b><span class="mini">或点此选择文件</span>' +
      '    <input type="file" id="crFile" accept=".json,application/json" style="display:none"></div>' +
      '  <textarea class="cr-ta" id="crPaste" rows="4" placeholder="也可以直接把 api json 内容粘到这里（粘提示词文本没用，那不是工作流）"></textarea>' +
      '  <div class="cr-row"><input class="cr-inp" id="crName" placeholder="给这个工作流起个名字（可留空）">' +
      '    <button class="cr-btn primary" id="crImport">解析并保存</button></div>' +
      '  <div id="crDetect"></div>' +
      '  <div id="crSaved"></div>' +
      '</div>';

    var $ = function (s) { return q(s, el); };

    /* ---------- 连接状态 ---------- */
    async function ping() {
      var dot0 = $("#crDot");
      if (!dot0 || !dot0.offsetParent) { return; }   // 面板没在显示就不发请求（省得每 15 秒白跑一次、也免得带着重排）
      try {
        var r = await (await fetch(API + "ping")).json();
        var dot = $("#crDot"), txt = $("#crConn");
        if (!dot || !txt) { return; }
        var cls, next, tip;
        if (r.ok) {
          cls = "cr-dot ok";
          next = (r.device || "ComfyUI") + (r.vram_total ? " · " + Math.round(r.vram_total / 1073741824) + " GB" : "");
          tip = r.comfy;
        } else {
          cls = "cr-dot err";
          next = "ComfyUI 未连接";
          tip = (r.comfy || "") + " — " + (r.error || "");
        }
        // 只在真变化时写 DOM：每 15 秒无条件重写文本会让这一行反复重排
        if (dot.className !== cls) { dot.className = cls; }
        if (txt.textContent !== next) { txt.textContent = next; }
        if (txt.title !== tip) { txt.title = tip; }
      } catch (e) { }
    }
    ping();
    setInterval(ping, 15000);

    /* ---------- 列表 ---------- */
    async function loadList() {
      var r = await (await fetch(API + "workflows")).json();
      S.items = r.items || [];
      var sel = $("#crWf");
      sel.innerHTML = S.items.length
        ? S.items.map(function (it) {
          return '<option value="' + esc(it.id) + '">' + esc(it.name) + "（" + (KINDS[it.kind] || it.kind) + "）</option>";
        }).join("")
        : '<option value="">（还没有导入工作流）</option>';
      if (S.cur) sel.value = S.cur.id;
      if (!S.items.length) { S.cur = null; paintParams(); }
      else pick(sel.value || S.items[0].id);
    }

    function pick(id) {
      S.cur = S.items.filter(function (x) { return x.id === id; })[0] || null;
      PICK.nodeData = null;
      PICK.nodeEdits = {};
      paintParams();
      renderSaved();
    }

    /* ---------- 参数区 ---------- */
    function paintParams() {
      var box = $("#crParams"), meta = $("#crWfMeta"), hint = $("#crRunHint");
      if (!S.cur) {
        box.innerHTML = "";
        meta.textContent = "先在「导入工作流」里导入一个 ComfyUI 的 api json";
        hint.textContent = "";
        return;
      }
      var d = S.cur.detect || {};
      var isVid = S.cur.kind === "video";
      var curMode = S.cur.mode || d.mode || (isVid ? "t2v" : "t2i");
      meta.innerHTML = "类型 <b>" + (KINDS[S.cur.kind] || S.cur.kind) + "</b> · " + (d.nodes || 0) + " 节点 · " +
        '提示词→<b>' + (d.prompt ? esc(d.prompt.node + "." + d.prompt.field) : "未识别") + "</b>" +
        (isVid && d.length ? " · 时长→<b>" + esc(d.length.node + "." + d.length.field) + "</b>（" + d.length.frames + " 帧 @ " + d.length.fps + "fps）" : "") +
        (d.size ? " · 分辨率→<b>" + esc(d.size.width + "×" + d.size.height) + "</b>" + (d.size.virtual ? "（可改）" : "") : "");
      var where = $("#crWhere");
      if (where) {
        var pr = d.prompt;
        where.innerHTML = pr
          ? "将写入：<b>" + esc(pr.node + "." + pr.field) + (pr.path ? " › " + esc(pr.path) : "") + "</b>" +
            (pr.path ? ' <span class="mini">（这个字段里存的是 json，插件只改其中这一段）</span>' : "") +
            (d.prompt && d.prompt.segments > 1 ? ' <span class="mini">· 时间轴共 ' + d.prompt.segments + ' 段，只写这一段</span>' : "")
          : "没识别到提示词位置：可在「导入工作流」页改选";
      }
      var html = '';
      var refs = d.refs || [];
      var filled = refs.filter(function (r) { return !r.empty; });
      html += '<div class="cr-cell"><label class="cr-lb">模式</label><select class="cr-sel" id="crMode">' +
        MODES.map(function (m) {
          var ok = isVid ? m[0].indexOf("v") >= 0 : m[0].indexOf("v") < 0;
          return '<option value="' + m[0] + '"' + (m[0] === curMode ? " selected" : "") + (ok ? "" : " hidden") + ">" + m[1] + "</option>";
        }).join("") + "</select></div>";
      if (isVid) {
        html += '<div class="cr-cell"><label class="cr-lb">时长（秒）</label><input class="cr-inp" id="crDur" type="number" step="0.5" min="0.5" value="' +
          (d.length ? d.length.duration : 5) + '"' + (d.length ? "" : " disabled") + "></div>";
      }
      var sw = d.size ? d.size.width : (isVid ? 1280 : 1024);
      var sh = d.size ? d.size.height : (isVid ? 720 : 1024);
      var presets = (d.presets || {})[isVid ? "video" : "image"] || [];
      var mpNow = (sw * sh / 1000000).toFixed(2);
      html += '<div class="cr-cell" style="grid-column:1/-1"><label class="cr-lb">分辨率 / 像素</label>' +
        '<div class="cr-line">' +
            '<select class="cr-sel" id="crPreset"><option value="">预设…</option>' +
            presets.map(function (p) {
              return '<option value="' + p[1] + "x" + p[2] + '">' + esc(p[0]) + "</option>";
            }).join("") +
            "</select>" +
          "</div>" +
          '<div class="cr-line">' +
            '<input class="cr-inp" id="crW" type="number" min="16" max="8192" step="8" value="' + sw + '">' +
            '<span class="cr-x">×</span>' +
            '<input class="cr-inp" id="crH" type="number" min="16" max="8192" step="8" value="' + sh + '">' +
            '<span class="cr-sep"></span>' +
            '<label class="cr-lb" style="margin:0">像素</label>' +
            '<input class="cr-inp cr-mp" id="crMp" type="number" min="0.05" max="32" step="0.1" value="' + mpNow + '">' +
            '<span class="mini">MP</span>' +
          "</div>" +
          '<div class="cr-line">' +
            '<span class="mini">比例</span>' +
            ["1:1", "3:4", "4:3", "2:3", "3:2", "9:16", "16:9", "21:9"].map(function (r) {
              return '<button class="cr-btn sm" data-ratio="' + r + '">' + r + "</button>";
            }).join("") +
          "</div>" +
          '<div class="mini" id="crResInfo">' + (sw * sh / 1000000).toFixed(2) + " MP · 比例 " + (sw / sh).toFixed(2) + "</div>" +
        '<div class="mini" id="crResHint">' +
        (d.size && d.size.virtual
          ? "工作流里没有分辨率节点：改这里会在每张参考图后插一个缩放，把图统一到这个尺寸"
          : (d.size ? "识别到：" + esc((d.size.class || "") + " 节点 " + d.size.node + " · " + d.size.width + "×" + d.size.height)
            : "未识别到分辨率节点")) +
        "</div></div>";
      html += '<div class="cr-cell"><label class="cr-lb">种子（留空＝工作流原值）</label><input class="cr-inp" id="crSeed" placeholder="随机"></div>';
      html += '<div class="cr-cell" style="grid-column:1/-1"><label class="cr-lb">参考图槽</label>' +
        '<div class="mini" id="crRefs"></div></div>';
      if (d.note) {
        html += '<div class="cr-cell" style="grid-column:1/-1"><div class="cr-note warn">' + esc(d.note) + "</div></div>";
      }
      html += modelsCell(d);
      html += loraCell(d);
      html += '<div class="cr-cell" style="grid-column:1/-1">' +
        '<div class="cr-sep">全部节点 · 可改的都在这儿</div>' +
        '<div class="cr-line"><input class="cr-inp" id="crNodeQ" placeholder="搜类名 / 编号（KSampler、19）">' +
        '<span class="mini" id="crNodeTip"></span></div>' +
        '<div class="cr-nodes" id="crNodes"><div class="mini">读取节点中…</div></div></div>';
      html += '<div class="cr-cell" style="grid-column:1/-1"><div class="cr-line">' +
        '<button class="cr-btn" id="crPersist" title="把上面改过的模型 / LoRA / 分辨率 / 时长 / 种子写回这份工作流">保存这些改动</button>' +
        '<label class="mini" style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="crAutoSave"> 生成后自动保存</label>' +
        '<span class="mini" id="crSaveTip"></span></div></div>';
      box.innerHTML = html;
      paintRefs();
      bindNodes();
      paintNodes();
      var modeSel = $("#crMode");
      if (modeSel) modeSel.onchange = function () { paintRefs(); };
      bindRes();
      bindPicks();
      var pb = $("#crPersist");
      if (pb) pb.onclick = function () { saveEdits(false); };
      var au = $("#crAutoSave");
      if (au) {
        try { au.checked = localStorage.getItem("ps-comfy-autosave") === "1"; } catch (e) {}
        au.onchange = function () {
          try { localStorage.setItem("ps-comfy-autosave", au.checked ? "1" : "0"); } catch (e) {}
          toast(au.checked ? "以后生成完自动保存改动" : "不再自动保存", "i", api);
        };
      }
      var steps = (d.samplers || [])[0];
      hint.textContent = steps && steps.steps
        ? "步数 " + steps.steps + " · cfg " + (Number(steps.cfg || 0).toFixed(2)) + " · " + (steps.sampler || "") + "（沿用工作流）"
        : "";
    }

    /* 参考图槽提示：识别到的槽位 + 当前模式要几张图 */
    function mpToSize(mp, r) {
      var w = Math.round(Math.sqrt(mp * 1000000 * r) / 8) * 8;
      var h = Math.round(w / r / 8) * 8;
      return [Math.max(16, w), Math.max(16, h)];
    }

    function setRes(w, h) {
      w = Math.max(16, Math.round(Number(w) / 8) * 8);
      h = Math.max(16, Math.round(Number(h) / 8) * 8);
      if ($("#crW")) $("#crW").value = w;
      if ($("#crH")) $("#crH").value = h;
      if ($("#crMp")) $("#crMp").value = (w * h / 1000000).toFixed(2);
      resInfo(w, h);
    }

    function resInfo(w, h) {
      var el = $("#crResInfo");
      if (el) el.textContent = (w * h / 1000000).toFixed(2) + " MP · 比例 " + (w / h).toFixed(2) +
        "（" + w + "×" + h + "）";
    }

    function curRatio() {
      var w = Number(($("#crW") || {}).value || 0), h = Number(($("#crH") || {}).value || 0);
      if (w > 0 && h > 0) return w / h;
      var sz = (S.cur && S.cur.detect && S.cur.detect.size) || {};
      return Number(sz.ratio || (sz.width && sz.height ? sz.width / sz.height : 1)) || 1;
    }

    function bindRes() {
      var pre = $("#crPreset");
      if (pre) pre.onchange = function () {
        if (!this.value) return;
        var p = String(this.value).split("x");
        setRes(p[0], p[1]);
        this.value = "";
      };
      var mp = $("#crMp");
      if (mp) mp.onchange = function () {
        var v = Number(this.value);
        if (!(v > 0)) return;
        var wh = mpToSize(v, curRatio());
        setRes(wh[0], wh[1]);
      };
      ["#crW", "#crH"].forEach(function (sel) {
        var el = $(sel);
        if (el) el.oninput = function () {
          var w = Number(($("#crW") || {}).value || 0), h = Number(($("#crH") || {}).value || 0);
          if (w > 0 && h > 0) {
            if ($("#crMp")) $("#crMp").value = (w * h / 1000000).toFixed(2);
            resInfo(w, h);
          }
        };
      });
      Array.prototype.forEach.call(document.querySelectorAll("[data-ratio]"), function (b) {
        b.onclick = function () {
          var r = String(b.getAttribute("data-ratio")).split(":");
          var ratio = Number(r[0]) / Number(r[1]);
          var v = Number(($("#crMp") || {}).value || 0);
          if (!(v > 0)) {
            var w0 = Number(($("#crW") || {}).value || 1024), h0 = Number(($("#crH") || {}).value || 1024);
            v = w0 * h0 / 1000000;
          }
          var wh = mpToSize(v, ratio);
          setRes(wh[0], wh[1]);
        };
      });
    }

    function mKey(m) { return m.node + "|" + m.field; }

    function modelsCell(d) {
      var ms = d.models || [];
      if (!ms.length) return "";
      var rows = ms.map(function (m) {
        var k = mKey(m);
        var v = PICK.models[k] != null ? PICK.models[k] : m.value;
        var extra = PICK.options[k] || [];
        var list = [v].concat(extra.filter(function (x) { return x !== v; }));
        return '<div class="cr-line"><select class="cr-sel cr-mdl" data-mdl="' + esc(k) + '" title="' + esc(v) + '">' +
          list.map(function (o) {
            return '<option value="' + esc(o) + '"' + (o === v ? " selected" : "") + ">" + esc(o) + "</option>";
          }).join("") + "</select>" +
          '<span class="mini">' + esc(m.kind + " · " + m.class + "." + m.field) + "</span></div>";
      }).join("");
      return '<div class="cr-cell" style="grid-column:1/-1"><label class="cr-lb">模型（' + ms.length + ' 个，取自工作流 / ComfyUI）</label>' +
        '<div id="crModels">' + rows + "</div>" +
        '<div class="cr-line"><button class="cr-btn sm" id="crMdlRef">从 ComfyUI 拉模型列表</button>' +
        '<span class="mini" id="crMdlHint"></span></div></div>';
    }

    function loraCell(d) {
      var ls = d.loras || [];
      if (!ls.length) {
        return '<div class="cr-cell" style="grid-column:1/-1"><label class="cr-lb">LoRA</label>' +
          '<div class="mini">这个工作流里没有 LoRA 节点</div></div>';
      }
      var rows = ls.map(function (l) {
        var k = String(l.node);
        var sm = PICK.lora[k + "|m"] != null ? PICK.lora[k + "|m"] : (l.strength_model != null ? l.strength_model : 1);
        var sc = PICK.lora[k + "|c"] != null ? PICK.lora[k + "|c"] : (l.strength_clip != null ? l.strength_clip : sm);
        return '<div class="cr-line"><span class="mini" style="flex:1 1 90px;overflow:hidden;text-overflow:ellipsis" title="' +
          esc(l.name) + '">' + esc(l.name) + "</span>" +
          '<input class="cr-inp cr-ls" data-lo="' + esc(k) + '" data-f="strength_model" type="number" step="0.05" min="-4" max="4" value="' + sm + '">' +
          '<input class="cr-inp cr-ls" data-lo="' + esc(k) + '" data-f="strength_clip" type="number" step="0.05" min="-4" max="4" value="' + sc + '">' +
          '<span class="mini">模型/文本</span></div>';
      }).join("");
      return '<div class="cr-cell" style="grid-column:1/-1"><label class="cr-lb">LoRA（' + ls.length + " 个，可改强度）</label>" +
        '<div id="crLoras">' + rows + "</div></div>";
    }

    function bindPicks() {
      Array.prototype.forEach.call(document.querySelectorAll(".cr-mdl"), function (el) {
        el.onchange = function () { PICK.models[this.getAttribute("data-mdl")] = this.value; };
      });
      Array.prototype.forEach.call(document.querySelectorAll(".cr-ls"), function (el) {
        el.onchange = function () {
          var k = this.getAttribute("data-lo") + "|" +
            (this.getAttribute("data-f") === "strength_model" ? "m" : "c");
          PICK.lora[k] = Number(this.value);
        };
      });
      var btn = $("#crMdlRef");
      if (btn) btn.onclick = refreshModels;
    }

    function refreshModels() {
      var ms = (S.cur && S.cur.detect && S.cur.detect.models) || [];
      var hint = $("#crMdlHint");
      if (!ms.length) return;
      if (hint) hint.textContent = "拉取中…";
      var left = ms.length, got = 0;
      ms.forEach(function (m) {
        fetch(API + "options?cls=" + encodeURIComponent(m["class"]) + "&field=" + encodeURIComponent(m.field))
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.ok && j.options && j.options.length) { PICK.options[mKey(m)] = j.options; got++; }
          })
          .catch(function () {})
          .then(function () {
            left--;
            if (left > 0) return;
            if (hint) hint.textContent = got
              ? ("已拉到 " + got + " 个槽的列表")
              : "拉不到（ComfyUI 没启动？）只有工作流里的现值";
            paintParams();
          });
      });
    }

    function paintRefs() {
      var box = $("#crRefs");
      if (!box || !S.cur) return;
      var d = S.cur.detect || {};
      var refs = d.refs || [];
      var mode = ($("#crMode") || {}).value || d.mode || "";
      var need = d.mode_desc && d.mode === mode ? d.mode_desc
        : ({ t2v: "不需要图片", i2v: "1 张首帧图", fl2v: "2 张（首帧+尾帧）",
             r2v: "1–9 张参考图，提示词用 <Picture 1>… 指代",
             v2v: "需要源视频（图片另可给）", rv2v: "源视频 + 可选参考图",
             mixed: "按段落各自要", t2i: "不需要图片", i2i: "1 张以上参考图" }[mode] || "");
      // 一句话：已接图的槽列名字，空槽聚合成一句（不逐个列）
      var parts = [];
      if (refs.length) {
        var used = refs.filter(function (r) { return !r.empty; });
        var empties = refs.filter(function (r) { return r.empty; });
        var names = used.slice(0, 6).map(function (r) {
          return r.label + (r.orig ? "←" + String(r.orig).split(/[\\/]/).pop() : "");
        }).join("、") + (used.length > 6 ? "…" : "");
        if (used.length) {
          parts.push("你上传的图会按顺序替换这 " + used.length + " 个槽：" + names);
        }
        if (empties.length) {
          parts.push("另有 " + empties.length + " 个空槽可继续加图（这个工作流最多 "
            + refs.length + " 张）");
        }
        if (!used.length) parts.push("这个工作流还没有接图，上传后自动接上");
      } else if (NEED_IMG[mode]) {
        parts.push("这个工作流没有独立图槽，上传的图会跳过");
      }
      box.textContent = parts.join(" · ") || "—";
    }

    /* ---------- 全部节点 ---------- */
    function nodeKey(nid, field) { return nid + "|" + field; }

    function countEdits() {
      var n = Object.keys(PICK.nodeEdits).length;
      var tip = $("#crNodeTip");
      if (tip) tip.textContent = n ? "改动 " + n + " 项" : "";
    }

    function addEdit(nid, field, val) {
      PICK.nodeEdits[nodeKey(nid, field)] = val;
      countEdits();
    }

    function bindNodes() {
      var qel = $("#crNodeQ");
      if (qel) {
        var m = /[?&]q=([^&]*)/.exec(location.search);
        if (m) { try { qel.value = decodeURIComponent(m[1]); } catch (e) { qel.value = m[1]; } }
        qel.oninput = function () { filterNodes(qel.value); };
      }
      countEdits();
    }

    function filterNodes(kw) {
      var box = $("#crNodes");
      if (!box) return;
      var q = String(kw || "").trim().toLowerCase();
      box.querySelectorAll(".cr-nod").forEach(function (el) {
        var hay = (el.dataset.k || "").toLowerCase();
        el.style.display = (!q || hay.indexOf(q) >= 0) ? "" : "none";
      });
      box.querySelectorAll(".cr-ncat").forEach(function (h) {
        var n = h.nextElementSibling, vis = 0;
        while (n && !n.classList.contains("cr-ncat")) {
          if (n.classList.contains("cr-nod") && n.style.display !== "none") vis++;
          n = n.nextElementSibling;
        }
        h.style.display = vis ? "" : "none";
      });
    }

    async function paintNodes() {
      var box = $("#crNodes");
      if (!box || !S.cur) return;
      var wid = S.cur.id;
      if (!PICK.nodeData || PICK.nodeData.id !== wid) {
        try {
          var r = await (await fetch(API + "nodes?id=" + encodeURIComponent(wid))).json();
          if (!r || !r.ok) {
            box.innerHTML = '<div class="mini">读不到节点：' + esc((r && r.error) || "未知错误") + "</div>";
            return;
          }
          r.id = wid;
          PICK.nodeData = r;
        } catch (e) {
          box.innerHTML = '<div class="mini">读不到节点：' + esc(e) + "</div>";
          return;
        }
      }
      drawNodes(PICK.nodeData);
    }

    function drawNodes(r) {
      var box = $("#crNodes");
      if (!box) return;
      var cats = r.cats || {};
      var order = ["input", "text", "loader", "sampler", "output", "other"];
      var byCat = {};
      (r.nodes || []).forEach(function (n) { (byCat[n.cat] = byCat[n.cat] || []).push(n); });
      var html = "";
      var first = true;
      var openAll = /[?&]allnodes=1/.test(location.search);
      if (openAll) box.style.maxHeight = "none";
      order.forEach(function (c) {
        var list = byCat[c];
        if (!list || !list.length) return;
        html += '<div class="cr-ncat">' + esc(cats[c] || c) + " · " + list.length + "</div>";
        list.forEach(function (n) { html += nodeRow(n, first || openAll); first = false; });
      });
      box.innerHTML = html || '<div class="mini">这个工作流没有节点</div>';
      box.querySelectorAll("[data-nf]").forEach(function (el) {
        var nid = el.dataset.nid, f = el.dataset.nf, kind = el.dataset.kind;
        el.addEventListener(kind === "toggle" ? "change" : "input", function () {
          var v = kind === "toggle" ? el.checked : el.value;
          if (kind === "number") v = el.value === "" ? "" : Number(el.value);
          addEdit(nid, f, v);
        });
      });
      filterNodes(($("#crNodeQ") || {}).value || "");
      var tip = $("#crNodeTip");
      if (tip) {
        tip.title = r.online
          ? "已连 ComfyUI：" + r.online + " 个节点拿到官方定义（" + (r.writable || 0) + " 个可改值）"
          : "ComfyUI 没连上：类型是按值猜的，连上后下拉框才有官方选项";
      }
    }

    function nodeRow(n, open) {
      var ins = (n.inputs || []).map(function (i) { return inputRow(n.id, i); }).join("");
      var key = n.id + " " + n.class + " " + (n.title || "");
      var sub = (n.title && n.title !== n.class) ? n.title : "";
      return '<details class="cr-nod" data-k="' + esc(key) + '"' + (open ? " open" : "") + '><summary>' +
        '<span class="cr-nid">#' + esc(n.id) + "</span><b>" + esc(n.class) + "</b>" +
        (sub ? '<span class="cr-cat">' + esc(sub) + "</span>" : "") +
        "</summary>" +
        (ins || '<div class="cr-ni"><span></span><span class="mini">没有可改的输入</span></div>') +
        "</details>";
    }

    function inputRow(nid, i) {
      var k = 'data-nid="' + esc(nid) + '" data-nf="' + esc(i.name) + '"';
      var lab = '<label title="' + esc(i.name) + '">' + esc(i.name) + "</label>";
      if (i.type === "link") {
        return '<div class="cr-ni">' + lab + '<span class="cr-link" title="连线来自节点 #' + esc(i.from) +
          '，不能在这里改">⇢ #' + esc(i.from) + "</span></div>";
      }
      var v = (i.value == null) ? "" : i.value;
      if (i.type === "toggle") {
        var ck = (v === true || v === 1 || v === "1" || v === "true") ? " checked" : "";
        return '<div class="cr-ni">' + lab +
          '<label class="cr-inl"><input type="checkbox" data-kind="toggle" ' + k + ck + "></label></div>";
      }
      if (i.type === "combo") {
        var opts = (i.options || []).slice();
        if (v !== "" && opts.indexOf(v) < 0) opts.unshift(v);
        return '<div class="cr-ni">' + lab + '<select class="cr-sel" data-kind="combo" ' + k + ">" +
          opts.map(function (o) {
            return '<option value="' + esc(o) + '"' + (String(o) === String(v) ? " selected" : "") +
              ">" + esc(o) + "</option>";
          }).join("") + "</select></div>";
      }
      if (i.type === "number") {
        var vs = String(v);
        var nv = Number(v);
        if (v !== "" && isFinite(nv) && !Number.isInteger(nv)) vs = String(parseFloat(nv.toFixed(6)));
        var mn = (i.min == null) ? "" : ' min="' + i.min + '"';
        var mx = (i.max == null) ? "" : ' max="' + i.max + '"';
        var st = (i.step == null) ? "" : ' step="' + i.step + '"';
        return '<div class="cr-ni">' + lab + '<input class="cr-inp" type="number" data-kind="number" ' +
          k + mn + mx + st + ' value="' + esc(vs) + '"></div>';
      }
      if (i.type === "multiline") {
        return '<div class="cr-ni">' + lab + '<textarea class="cr-ta" rows="2" data-kind="multiline" ' +
          k + ">" + esc(v) + "</textarea></div>";
      }
      return '<div class="cr-ni">' + lab + '<input class="cr-inp" data-kind="text" ' + k +
        ' value="' + esc(v) + '"></div>';
    }

    function collectNodeEdits() {
      var out = [];
      Object.keys(PICK.nodeEdits).forEach(function (k) {
        var p = k.split("|");
        if (p.length === 2) out.push({ node: p[0], field: p[1], value: PICK.nodeEdits[k] });
      });
      return out;
    }

    /* ---------- 已存映射 ---------- */
    function renderSaved() {
      var box = $("#crSaved");
      if (!S.items.length) { box.innerHTML = ""; return; }
      box.innerHTML = '<div class="cr-sep">已导入的工作流</div>' + S.items.map(function (it) {
        return '<div class="cr-wf"><b>' + esc(it.name) + "</b>" +
          '<span class="mini">' + (KINDS[it.kind] || it.kind) + " · " + (it.nodes || 0) + " 节点</span>" +
          '<span style="flex:1"></span>' +
          '<button class="cr-btn sm" data-go="' + esc(it.id) + '">去生成</button>' +
          '<button class="cr-btn sm danger" data-del="' + esc(it.id) + '">删除</button></div>';
      }).join("");
      box.querySelectorAll("[data-go]").forEach(function (b) {
        b.onclick = function () { switchTab("gen"); $("#crWf").value = b.dataset.go; pick(b.dataset.go); };
      });
      box.querySelectorAll("[data-del]").forEach(function (b) {
        b.onclick = async function () {
          if (!confirm("删除这个工作流？（只删 PM 里的副本）")) return;
          await fetch(API + "delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: b.dataset.del }) });
          toast("已删除", "", api);
          loadList();
        };
      });
    }

    /* ---------- 生成 ---------- */
    /* 收集面板上可保存的改动（模型 / LoRA / 分辨率 / 时长 / 种子 / 提示词） */
    function collectEdits(withText) {
      var body = { id: (S.cur || {}).id };
      if (withText) {
        body.prompt = ($("#crPrompt") || {}).value ? $("#crPrompt").value.trim() : "";
        var negEl = $("#crNeg");
        if (negEl && negEl.value.trim()) body.negative = negEl.value.trim();
      }
      var durEl = $("#crDur");
      var dur = durEl ? Number(durEl.value || 0) : 0;
      if (dur > 0) body.duration = dur;
      var w = Number(($("#crW") || {}).value || 0);
      var h = Number(($("#crH") || {}).value || 0);
      if (w >= 16 && h >= 16) { body.width = Math.round(w); body.height = Math.round(h); }
      var seedEl = $("#crSeed");
      if (seedEl && seedEl.value !== "" && seedEl.value != null) body.seed = Number(seedEl.value);
      var mdl = [];
      Object.keys(PICK.models).forEach(function (k) {
        var p = k.split("|");
        if (p.length === 2 && PICK.models[k]) mdl.push({ node: p[0], field: p[1], value: PICK.models[k] });
      });
      if (mdl.length) body.models = mdl;
      var lora = [];
      Object.keys(PICK.lora).forEach(function (k) {
        var p = k.split("|");
        if (p.length < 2) return;
        var it = lora.filter(function (x) { return x.node === p[0]; })[0];
        if (!it) { it = { node: p[0] }; lora.push(it); }
        it[p[1] === "m" ? "strength_model" : "strength_clip"] = PICK.lora[k];
      });
      if (lora.length) body.loras = lora;
      var ne = collectNodeEdits();
      if (ne.length) body.nodes = ne;
      return body;
    }

    /* 保存改动到工作流文件 */
    function autoSaveOn() {
      try { return localStorage.getItem("ps-comfy-autosave") === "1"; } catch (e) { return false; }
    }

    async function saveEdits(withText) {
      if (!S.cur) { toast("先导入工作流", "e", api); return null; }
      var body = collectEdits(withText !== false);
      var tip = $("#crSaveTip");
      if (tip) tip.textContent = "保存中…";
      try {
        var r = await (await fetch(API + "persist", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        })).json();
        if (!r || !r.ok) {
          if (tip) tip.textContent = "";
          toast("保存失败：" + ((r && r.error) || "未知错误"), "e", api);
          return null;
        }
        var ch = r.changed || [];
        var msg = ch.length ? "已保存：" + ch.join("、") : (r.note || "没有改动");
        if (tip) tip.textContent = msg;
        if (r.item) {
          var i = S.items.indexOf(S.items.filter(function (x) { return x.id === r.item.id; })[0]);
          if (i >= 0) S.items[i] = r.item;
          S.cur = r.item;
        }
        toast(msg, "s", api);
        return r;
      } catch (e) {
        if (tip) tip.textContent = "";
        toast("保存失败：" + e, "e", api);
        return null;
      }
    }

    async function run() {
      if (S.busy) return;
      if (!S.cur) { toast("先导入工作流", "e", api); return; }
      var body = collectEdits(true);
      body.mode = ($("#crMode") || {}).value || "";
      // 需要图片的模式（含导演台的参考主体/混合模式）：把 PM 里的参考图带过去
      var d = S.cur.detect || {};
      var hasRefs = (d.refs || []).length > 0;
      if (NEED_IMG[body.mode] || (hasRefs && (api.images && api.images().length))) {
        var imgs = (api.images && api.images()) || [];
        body.images = imgs.map(function (im, i) { return { name: "ref" + (i + 1), data_url: im.data_url }; });
      }

      S.busy = true;
      $("#crRun").disabled = true;
      $("#crProg").style.display = "block";
      var cnt = 0;
      var tick = setInterval(function () {
        cnt++;
        $("#crProg").firstChild.style.width = Math.min(95, 6 + cnt * 4) + "%";
      }, 1000);
      $("#crOut").innerHTML = '<div class="mini">已提交，等待 ComfyUI 出图…</div>';
      try {
        var r = await (await fetch(API + "run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
        if (!r.ok) {
          $("#crOut").innerHTML = '<div class="cr-err">' + esc(r.error || "提交失败") + "</div>";
          toast("提交失败", "e", api);
          return;
        }
        S.last = r;
        poll(r.prompt_id, tick);
        return;
      } catch (e) {
        $("#crOut").innerHTML = '<div class="cr-err">' + esc(e.message) + "</div>";
      } finally {
        if (!S.last || !S.last.prompt_id) finishRun(tick);
      }
    }

    function finishRun(tick) {
      clearInterval(tick);
      S.busy = false;
      $("#crRun").disabled = false;
      $("#crProg").style.display = "none";
      $("#crProg").firstChild.style.width = "0";
    }

    async function poll(promptId, tick) {
      var t0 = Date.now();
      while (Date.now() - t0 < 20 * 60 * 1000) {
        await new Promise(function (r) { setTimeout(r, 2000); });
        var r;
        try {
          r = await (await fetch(API + "status?prompt_id=" + encodeURIComponent(promptId))).json();
        } catch (e) { continue; }
        if (!r.ok) { $("#crOut").innerHTML = '<div class="cr-err">' + esc(r.error) + "</div>"; break; }
        if (r.state === "done") {
          $("#crProg").firstChild.style.width = "100%";
          renderOutputs(r.outputs || [], Date.now() - t0);
          toast("生成完成", "", api);
          if (autoSaveOn()) saveEdits(false);
          break;
        }
        if (r.state === "error") {
          $("#crOut").innerHTML = '<div class="cr-err">生成失败：' + esc(JSON.stringify(r.status || {}).slice(0, 300)) + "</div>";
          break;
        }
      }
      finishRun(tick);
    }

    function renderOutputs(outs, ms) {
      if (!outs.length) { $("#crOut").innerHTML = '<div class="mini">完成了，但没有找到产物文件。</div>'; return; }
      $("#crOut").innerHTML = '<div class="mini">用时 ' + (ms / 1000).toFixed(1) + "s · 产物 " + outs.length + " 个</div>" +
        outs.map(function (o, i) {
          var media = o.kind === "video"
            ? '<video class="cr-media" controls loop src="' + esc(o.url) + '"></video>'
            : '<img class="cr-media" style="cursor:zoom-in" data-big="' + i + '" src="' + esc(o.url) + '" alt="">';
          return '<div class="cr-item">' + media +
            '<div class="cr-acts"><span class="mini">' + esc(o.filename) + "</span><span style=\"flex:1\"></span>" +
            (o.kind === "video" ? "" : '<button class="cr-btn sm" data-ref="' + i + '">存为参考图</button>') +
            '<a class="cr-btn sm" href="' + esc(o.url) + '" download="' + esc(o.filename) + '">下载</a></div></div>';
        }).join("");
      $("#crOut").querySelectorAll("[data-big]").forEach(function (b) {
        b.onclick = function () { window.open(outs[Number(b.dataset.big)].url, "_blank"); };
      });
      $("#crOut").querySelectorAll("[data-ref]").forEach(function (b) {
        b.onclick = async function () {
          try {
            await api.insertImage(outs[Number(b.dataset.ref)].url, "参考图");
            toast("已加入参考图", "", api);
          } catch (e) { toast(e.message, "e", api); }
        };
      });
    }

    /* ---------- 导入 ---------- */
    function showDetect(item) {
      var d = item.detect || {};
      var encSlot = function (t) { return t.node + "|" + t.field + "|" + (t.path || ""); };
      var slotLabel = function (t) {
        var where = t.node + "." + t.field + (t.path ? " › " + t.path : "");
        return where + "（" + (t.class || "") + "，" + (t.chars || 0) + " 字）";
      };
      var nodeOpts = function (sel, field) {
        return (d.texts || []).map(function (t) {
          var on = sel && String(sel.node) === String(t.node) && sel.field === t.field
            && (sel.path || "") === (t.path || "") ? " selected" : "";
          return '<option value="' + esc(encSlot(t)) + '"' + on + ">" + esc(slotLabel(t)) + "</option>";
        }).join("");
      };
      $("#crDetect").innerHTML =
        '<div class="cr-sep">检测结果</div>' +
        '<div class="cr-kv"><span>类型</span><b>' + (KINDS[item.kind] || item.kind) + "</b>" +
        "<span>模式</span><b>" + esc(d.mode || item.mode) + "</b>" +
        "<span>节点</span><b>" + (item.nodes || 0) + "</b></div>" +
        '<div class="cr-note ' + (d.note && d.note.indexOf("未识别") >= 0 ? "warn" : "") + '">' + esc(d.note || "") + "</div>" +
        '<label class="cr-lb">正向提示词位置</label>' +
        '<select class="cr-sel" id="crDPos">' + (nodeOpts(d.prompt) || '<option value="">（没找到文本节点）</option>') + "</select>" +
        (d.negative ? '<label class="cr-lb">负向提示词位置</label><select class="cr-sel" id="crDNeg">' + nodeOpts(d.negative) + "</select>" : "") +
        (d.size ? '<div class="mini">分辨率：' + esc((d.size.class || "") + " " + (d.size.node || "（无节点，可改）") + " · " + d.size.width + "×" + d.size.height) + "</div>" : "") +
        (d.length ? '<div class="mini">时长：' + esc(d.length.node + "." + d.length.field + " = " + d.length.frames + " 帧 @ " + d.length.fps + "fps ≈ " + d.length.duration + "s") + "</div>" : "") +
        '<div class="cr-row"><button class="cr-btn primary" id="crSaveMap">保存这个工作流</button>' +
        '<span class="mini">保存后可在「生成」里选它</span></div>';
      $("#crSaveMap").onclick = async function () {
        var mk = function (v) {
          var p = String(v || "").split("|");
          if (p.length < 2 || !p[0] || !p[1]) return null;
          return { node: p[0], field: p[1], path: p[2] || null };
        };
        var pv = ($("#crDPos") || {}).value || "";
        var nv = ($("#crDNeg") || {}).value || "";
        var slots = { prompt: mk(pv) };
        if (nv) slots.negative = mk(nv);
        var payload = { id: (S.pending || item).id, name: ($("#crName").value || "").trim() || item.name, slots: slots };
        var r = await (await fetch(API + "save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).json();
        if (r.ok) { toast("已保存", "", api); S.pending = r.item; await loadList(); switchTab("gen"); }
        else toast(r.error || "保存失败", "e", api);
      };
      S.pending = item;
    }

    async function doImport(text, name) {
      $("#crDetect").innerHTML = '<div class="mini">解析中…</div>';
      var r = await (await fetch(API + "import", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ json: text, name: name || $("#crName").value })
      })).json();
      if (!r.ok) { $("#crDetect").innerHTML = '<div class="cr-err">' + esc(r.error) + "</div>"; return; }
      showDetect(r.item);
      await loadList();
      toast("已解析：" + (KINDS[r.item.kind] || r.item.kind), "", api);
    }

    /* ---------- 交互 ---------- */
    function switchTab(tab) {
      S.tab = tab;
      el.querySelectorAll(".cr-tab").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === tab); });
      el.querySelectorAll(".cr-pane").forEach(function (p) { p.style.display = p.dataset.pane === tab ? "" : "none"; });
    }
    el.querySelectorAll(".cr-tab").forEach(function (b) { b.onclick = function () { switchTab(b.dataset.tab); }; });

    $("#crWf").onchange = function () { pick(this.value); };
    $("#crReload").onclick = loadList;
    $("#crRun").onclick = run;
    $("#crFromDesc").onclick = function () {
      var src = document.querySelector("#content");
      if (!src || !src.value.trim()) { toast("左边「内容描述」是空的", "e", api); return; }
      $("#crPrompt").value = src.value.trim();
      toast("已取「内容描述」", "", api);
    };
    $("#crFromResult").onclick = function () {
      var box = document.querySelector("#result");
      var txt = (box && box.textContent || "").trim();
      if (!txt) { toast("右边还没有生成结果", "e", api); return; }
      $("#crPrompt").value = txt;
      toast("已取生成结果（" + txt.length + " 字）", "", api);
    };
    $("#crFromHis").onclick = async function () {
      try {
        var r = await (await fetch("/api/history")).json();
        var list = (r && r.history) || [];
        if (!list.length) { toast("历史是空的", "e", api); return; }
        var it = list[0];
        $("#crPrompt").value = (it.output || "").trim();
        toast("已取历史（" + (it.label || it.template || "") + "）", "", api);
      } catch (e) { toast("取历史失败：" + e.message, "e", api); }
    };
    $("#crNegTg").onclick = function () {
      var w = $("#crNegWrap");
      w.style.display = w.style.display === "none" ? "" : "none";
    };

    var drop = $("#crDrop"), file = $("#crFile");
    drop.onclick = function () { file.click(); };
    file.onchange = function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { $("#crName").value = f.name.replace(/\.json$/i, ""); doImport(fr.result, f.name.replace(/\.json$/i, "")); };
      fr.readAsText(f);
    };
    drop.ondragover = function (e) { e.preventDefault(); drop.classList.add("hot"); };
    drop.ondragleave = function () { drop.classList.remove("hot"); };
    drop.ondrop = function (e) {
      e.preventDefault(); drop.classList.remove("hot");
      var f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () { $("#crName").value = f.name.replace(/\.json$/i, ""); doImport(fr.result, f.name.replace(/\.json$/i, "")); };
      fr.readAsText(f);
    };
    $("#crImport").onclick = function () {
      var t = $("#crPaste").value.trim();
      if (!t) { toast("先选文件或粘贴 json", "e", api); return; }
      doImport(t, "");
    };

    loadList();
  }

  PSPlugin.addPanel({
    id: "comfy_runner",
    title: "ComfyUI 工作流",
    mount: "sidebar",
    render: render
  });
})();
