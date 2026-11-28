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

  /* 整页外壳：顶部工具条 + 左画布 + 右侧参数栏（inner 就是原来侧栏那一整套面板） */
  function SHELL(inner) {
    return '<div class="cv-app">' +
      '<div class="cv-bar">' +
      '<select class="cr-sel" id="crWf" title="选择工作流"></select>' +
      '<button class="cr-btn sm" id="crReload" title="重新读取工作流列表">刷新</button>' +
      '<button class="cr-btn sm" id="crImpBtn" title="导入 ComfyUI 的 api json">导入工作流</button>' +
      '<span class="cr-dot" id="crDot"></span><span class="mini" id="crConn">检测中…</span>' +
      '<span class="cv-sp"></span>' +
      '<span class="cv-seg"><button class="cr-btn sm on" id="cvGraphBtn">画布</button>' +
      '<button class="cr-btn sm" id="cvListBtn">列表</button></span>' +
      '<button class="cr-btn sm" id="cvZOut" title="缩小">－</button>' +
      '<i class="mini cv-zp" id="cvZpct">100%</i>' +
      '<button class="cr-btn sm" id="cvZIn" title="放大">＋</button>' +
      '<button class="cr-btn sm" id="cvFit" title="缩放到看得全">适应</button>' +
      '<button class="cr-btn sm" id="crSaveTop" title="把改动写回工作流 json">保存改动</button>' +
      '<button class="cr-btn primary" id="crRunTop" title="按当前参数生成">生成</button>' +
      '</div>' +
      '<div class="cv-wrap">' +
      '<div class="cv-main">' +
      '<div class="cv-canvas" id="cvCanvas">' +
      '<div class="cv-stage" id="cvStage">' +
      '<svg class="cv-edges" id="cvEdges"></svg>' +
      '<div class="cv-nodes" id="cvNodesBox"></div>' +
      '<div class="cv-groups" id="cvGroups"></div>' +
      '</div>' +
      '<div class="cv-empty" id="cvEmpty">先导入一个 ComfyUI 的 API 工作流，这里会画出节点图</div>' +
      '</div>' +
      '<div class="cv-listbox" id="cvList" style="display:none"></div>' +
      '</div>' +
      '<div class="cv-side">' + inner + '</div>' +
      '</div></div>';
  }

  function render(el, api) {
    var S = { items: [], cur: null, tab: "gen", busy: false, timer: null, last: null };
    var PICK = { models: {}, options: {}, lora: {}, nodeEdits: {}, nodeData: null, pmFiles: [] };

    el.innerHTML = SHELL(
      '<div class="cr-tabs">' +
      '  <button class="cr-tab on" data-tab="gen">生成参数</button>' +
      '  <button class="cr-tab" data-tab="imp">导入工作流</button>' +
      '</div>' +

      /* ---------------- 生成 ---------------- */
      '<div class="cr-pane" data-pane="gen">' +
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
      '</div>');

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
        '<div id="crRefs"></div></div>';
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
      // 主界面参考区 → 直接引用（先传到 ComfyUI，生成时用文件名，不重复上传）
      var pm = PICK.pmFiles || [];
      var nPm = (api.images ? api.images().length : 0);
      var pmLine = "";
      if (pm.length) {
        pmLine = '<div class="cr-pmline">已接主界面 ' + pm.length + " 张：" +
          pm.slice(0, 3).map(function (f, i) {
            return "图" + (i + 1) + "·" + esc(String(f.file).replace(/^pm_\d+_/, ""));
          }).join("、") + (pm.length > 3 ? "…" : "") +
          "（生成时直接用这几张，不再重复上传）</div>";
      } else if (nPm) {
        pmLine = '<div class="cr-pmline dim">主界面参考区有 ' + nPm + " 张图，点按钮直接引用</div>";
      }
      box.innerHTML =
        '<div class="cr-pmrow">' +
        '<button class="cr-btn sm" id="crUsePm">' +
        (pm.length ? "重新取主界面图" : "用主界面参考图") + (nPm ? "（" + nPm + "）" : "") +
        "</button>" +
        (pm.length ? '<button class="cr-btn sm" id="crClrPm">改回原图</button>' : "") +
        "</div>" + pmLine +
        '<div class="mini">' + esc(parts.join(" · ") || "—") + "</div>";
      var b = $("#crUsePm");
      if (b) b.onclick = usePm;
      var c = $("#crClrPm");
      if (c) c.onclick = function () {
        PICK.pmFiles = [];
        paintRefs();
        toast("已改回工作流原图", "", api);
      };
    }

    function usePm() {
      var imgs = (api.images && api.images()) || [];
      if (!imgs.length) { toast("先在左边「参考图」区拖几张图进来", "e", api); return; }
      var btn = $("#crUsePm");
      if (btn) { btn.disabled = true; btn.textContent = "上传中…"; }
      fetch(API + "stage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          images: imgs.map(function (im, i) {
            return { name: "pm" + (i + 1), data_url: im.data_url };
          })
        })
      }).then(function (r) { return r.json(); }).then(function (r) {
        if (!r || !r.ok) { toast((r && r.error) || "上传失败", "e", api); return; }
        PICK.pmFiles = r.files || [];
        toast("已接上 " + PICK.pmFiles.length + " 张主界面图", "", api);
      }).catch(function (e) {
        toast("上传失败：" + e.message, "e", api);
      }).then(function () { paintRefs(); });
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

    /* ================= 画布视图（节点图，样子照 ComfyUI） ================= */
    var CV = { s: 1, tx: 24, ty: 20, pos: {}, data: null, drag: null, pan: null, sel: "" };

    function cvApply() {
      var st = $("#cvStage");
      if (!st) return;
      st.style.transform = "translate(" + CV.tx + "px," + CV.ty + "px) scale(" + CV.s + ")";
      var p = $("#cvZpct");
      if (p) p.textContent = Math.round(CV.s * 100) + "%";
    }

    function cvHeight(n) {
      var h = 34 + 14;   // head + padding
      if (n.title && n.title !== n.class) h += 16;
      (n.inputs || []).forEach(function (i) {
        h += (i.type === "multiline" || i.type === "text") ? 44 : (i.type === "json" ? 30 : 24);
      });
      return h;
    }

    function cvRowHtml(nid, i, idx) {
      var k = 'data-nid="' + esc(nid) + '" data-nf="' + esc(i.name) + '"';
      var lab = '<label title="' + esc(i.name) + '">' + esc(i.name) + "</label>";
      var pin = '<span class="cv-pin in" title="' + esc(i.type) + '"></span>';
      if (i.type === "link") {
        return '<div class="cv-row link" data-row="' + idx + '">' + pin + lab +
          '<span class="cv-from" title="连线来自 #' + esc(i.from) + '">#' + esc(i.from) + "</span></div>";
      }
      var v = (i.value == null) ? "" : i.value;
      if (i.type === "json") {
        var js = i.json || {};
        var tip = (js.type === "array" ? "数组 " + js.count + " 项" : "对象 " + js.count + " 键") +
          (js.keys && js.keys.length ? "：" + js.keys.slice(0, 3).join("、") : "");
        return '<div class="cv-row json" data-row="' + idx + '">' + pin + lab +
          '<span class="cv-json" data-jbtn="' + esc(nid) + "|" + esc(i.name) + '" title="点开编辑这段 JSON">' +
          esc(tip) + "</span></div>";
      }
      if (i.type === "toggle") {
        var ck = (v === true || v === 1 || v === "1" || v === "true") ? " checked" : "";
        return '<div class="cv-row" data-row="' + idx + '">' + pin + lab +
          '<input type="checkbox" class="cv-ck" data-kind="toggle" ' + k + ck + "></div>";
      }
      if (i.type === "combo") {
        var opts = (i.options || []).slice();
        if (v !== "" && opts.indexOf(v) < 0) opts.unshift(v);
        return '<div class="cv-row" data-row="' + idx + '">' + pin + lab +
          '<select class="cv-sel" data-kind="combo" ' + k + ">" + opts.map(function (o) {
            return '<option value="' + esc(o) + '"' + (String(o) === String(v) ? " selected" : "") + ">" + esc(o) + "</option>";
          }).join("") + "</select></div>";
      }
      if (i.type === "number") {
        var vs = String(v), nv = Number(v);
        if (v !== "" && isFinite(nv) && !Number.isInteger(nv)) vs = String(parseFloat(nv.toFixed(6)));
        var mn = (i.min == null) ? "" : ' min="' + i.min + '"';
        var mx = (i.max == null) ? "" : ' max="' + i.max + '"';
        var st = (i.step == null) ? "" : ' step="' + i.step + '"';
        return '<div class="cv-row" data-row="' + idx + '">' + pin + lab +
          '<input class="cv-inp" type="number" data-kind="number" ' + k + mn + mx + st + ' value="' + esc(vs) + '"></div>';
      }
      if (i.type === "multiline" || i.type === "text") {
        return '<div class="cv-row" data-row="' + idx + '">' + pin + lab +
          '<textarea class="cv-ta" rows="2" data-kind="' + i.type + '" ' + k + ">" + esc(v) + "</textarea></div>";
      }
      return '<div class="cv-row" data-row="' + idx + '">' + pin + lab +
        '<input class="cv-inp" data-kind="text" ' + k + ' value="' + esc(v) + '"></div>';
    }

    function cvNodeHtml(n, p) {
      var rows = (n.inputs || []).map(function (i, idx) { return cvRowHtml(n.id, i, idx); }).join("");
      var outs = (n.outputs || []).map(function (o, i) {
        return '<i class="cv-pin out" data-out="' + i + '" title="' + esc(o.type) + '"></i>';
      }).join("");
      var sub = (n.title && n.title !== n.class) ? n.title : "";
      return '<div class="cv-node cat-' + esc(n.cat || "other") + (n.complex ? " cplx" : "") +
        '" data-nid="' + esc(n.id) + '" style="left:' + p.x + "px;top:" + p.y + "px;width:" + p.w + 'px">' +
        '<div class="cv-head"><span class="cv-dot"></span><b title="' + esc(n.class) + '">' + esc(n.class) + "</b>" +
        (n.complex ? '<i class="cv-badge">复合</i>' : "") +
        '<span class="cv-id">#' + esc(n.id) + '</span><span class="cv-outs">' + outs + "</span></div>" +
        (sub ? '<div class="cv-sub">' + esc(sub) + "</div>" : "") +
        '<div class="cv-rows">' + (rows || '<div class="cv-row"><span class="cv-pin in"></span><label>（没有输入）</label></div>') + "</div></div>";
    }

    function cvDraw(r) {
      if (!r) return;
      CV.data = r;
      var box = $("#cvNodesBox"), svg = $("#cvEdges"), grp = $("#cvGroups"), empty = $("#cvEmpty");
      if (!box || !svg) return;
      var nodes = r.nodes || [];
      if (!nodes.length) {
        box.innerHTML = ""; svg.innerHTML = "";
        if (grp) grp.innerHTML = "";
        if (empty) empty.style.display = "";
        return;
      }
      if (empty) empty.style.display = "none";
      var layers = (r.layers && r.layers.length) ? r.layers : [nodes.map(function (n) { return n.id; })];
      var W = 300, GX = 82, GY = 14, X0 = 24, Y0 = 20;
      var pos = {};
      layers.forEach(function (ids, li) {
        var y = Y0;
        ids.forEach(function (id) {
          var n = nodes.filter(function (x) { return x.id === id; })[0];
          if (!n) return;
          pos[id] = { x: X0 + li * (W + GX), y: y, w: W, h: cvHeight(n) };
          y += pos[id].h + GY;
        });
      });
      box.innerHTML = nodes.map(function (n) { return cvNodeHtml(n, pos[n.id] || { x: 0, y: 0, w: W }); }).join("");
      CV.pos = pos;
      cvMeasure(box, pos);
      cvRelayout(layers, pos);
      box.querySelectorAll(".cv-node").forEach(function (el) {
        var p = pos[el.dataset.nid];
        if (p) { el.style.left = p.x + "px"; el.style.top = p.y + "px"; }
      });
      cvGroups(nodes, pos, grp);
      cvEdges(r.edges || [], nodes, pos, svg, box);
      cvBind(box, pos);
      cvApply();
    }

    function cvMeasure(box, pos) {
      box.querySelectorAll(".cv-node").forEach(function (el) {
        var p = pos[el.dataset.nid];
        if (p && el.offsetHeight) p.h = el.offsetHeight;
      });
    }

    function cvRelayout(layers, pos) {
      layers.forEach(function (ids) {
        var y = 20;
        ids.forEach(function (id) {
          var p = pos[id];
          if (!p) return;
          p.y = y;
          y += p.h + 14;
        });
      });
    }

    function cvGroups(nodes, pos, host) {
      if (!host) return;
      var by = {};
      nodes.forEach(function (n) {
        if (n.group) (by[n.group] = by[n.group] || []).push(n.id);
      });
      host.innerHTML = Object.keys(by).map(function (g) {
        var ids = by[g], xs = [], ys = [], xe = [], ye = [];
        ids.forEach(function (id) {
          var p = pos[id];
          if (!p) return;
          xs.push(p.x); ys.push(p.y); xe.push(p.x + p.w); ye.push(p.y + p.h);
        });
        if (!xs.length) return "";
        var pad = 16;
        return '<div class="cv-group" style="left:' + (Math.min.apply(null, xs) - pad) + "px;top:" +
          (Math.min.apply(null, ys) - 26) + "px;width:" + (Math.max.apply(null, xe) - Math.min.apply(null, xs) + pad * 2) +
          "px;height:" + (Math.max.apply(null, ye) - Math.min.apply(null, ys) + pad + 26) + 'px">' +
          '<span class="cv-gt">组 ' + esc(g) + " · " + ids.length + " 个节点</span></div>";
      }).join("");
    }

    function cvEdges(edges, nodes, pos, svg, box) {
      var byId = {};
      nodes.forEach(function (n) { byId[n.id] = n; });
      var paths = [];
      edges.forEach(function (e) {
        var src = String(e[0]), dst = String(e[2]), di = e[3];
        var ps = pos[src], pd = pos[dst];
        if (!ps || !pd) return;
        var el = box.querySelector('.cv-node[data-nid="' + src.replace(/"/g, '\\"') + '"]');
        var x1 = ps.x + ps.w, y1 = ps.y + 17;
        if (el) {
          var out = el.querySelector('.cv-pin.out[data-out="' + (e[1] || 0) + '"]');
          if (out) {
            var ob = out.getBoundingClientRect(), sb = box.getBoundingClientRect(), sc = CV.s;
            y1 = (ob.top - sb.top) / sc + ob.height / (2 * sc);
            x1 = (ob.left - sb.left) / sc + ob.width / (2 * sc);
          }
        }
        var te = box.querySelector('.cv-node[data-nid="' + dst.replace(/"/g, '\\"') + '"] [data-row="' + di + '"]');
        var y2 = pd.y + 50 + (di || 0) * 24, x2 = pd.x;
        if (te) {
          var tb = te.getBoundingClientRect(), sb2 = box.getBoundingClientRect(), sc2 = CV.s;
          y2 = (tb.top - sb2.top) / sc2 + tb.height / (2 * sc2);
          x2 = (tb.left - sb2.left) / sc2;
        }
        var dx = Math.max(40, Math.abs(x2 - x1) * 0.45);
        paths.push('<path d="M' + x1.toFixed(1) + "," + y1.toFixed(1) + " C" + (x1 + dx).toFixed(1) + "," + y1.toFixed(1) +
          " " + (x2 - dx).toFixed(1) + "," + y2.toFixed(1) + " " + x2.toFixed(1) + "," + y2.toFixed(1) + '"></path>');
      });
      svg.innerHTML = paths.join("");
    }

    function cvBind(box, pos) {
      box.querySelectorAll("[data-nf]").forEach(function (el) {
        var kind = el.dataset.kind;
        el.addEventListener(kind === "toggle" ? "change" : "input", function () {
          var v = kind === "toggle" ? el.checked : el.value;
          if (kind === "number") v = el.value === "" ? "" : Number(el.value);
          addEdit(el.dataset.nid, el.dataset.nf, v);
          var nd = el.closest(".cv-node");
          if (nd) nd.classList.add("edited");
        });
      });
      box.querySelectorAll("[data-jbtn]").forEach(function (el) {
        el.onclick = function (ev) {
          ev.stopPropagation();
          var p = el.dataset.jbtn.split("|");
          cvJson(p[0], p[1]);
        };
      });
      box.querySelectorAll(".cv-node").forEach(function (el) {
        el.addEventListener("mousedown", function (ev) {
          if (ev.target.closest("input,textarea,select,label,.cv-json")) return;
          if (ev.target.closest(".cv-head")) {
            CV.drag = { id: el.dataset.nid, sx: ev.clientX, sy: ev.clientY,
              ox: pos[el.dataset.nid].x, oy: pos[el.dataset.nid].y };
            el.classList.add("dragging");
            ev.preventDefault();
            return;
          }
          CV.sel = el.dataset.nid;
          box.querySelectorAll(".cv-node.sel").forEach(function (x) { x.classList.remove("sel"); });
          el.classList.add("sel");
        });
      });
    }

    function cvJson(nid, field) {
      var n = ((CV.data || {}).nodes || []).filter(function (x) { return x.id === nid; })[0];
      if (!n) return;
      var it = (n.inputs || []).filter(function (i) { return i.name === field; })[0];
      if (!it) return;
      var val = typeof it.value === "string" ? it.value : JSON.stringify(it.value, null, 2);
      var mask = document.createElement("div");
      mask.className = "cv-mask";
      mask.innerHTML = '<div class="cv-dlg"><div class="cv-dlg-h"><b>#' + esc(nid) + " · " + esc(n.class) + " › " + esc(field) +
        '</b><button class="cr-btn sm" data-x>关闭</button></div>' +
        '<div class="mini">这是节点里的复合数据（' + (it.json ? (it.json.type === "array" ? "数组 " + it.json.count + " 项" : "对象 " + it.json.count + " 键") : "JSON") +
        "）。改完点「写回」，生成时会带上。</div>" +
        '<textarea class="cv-dlg-ta" spellcheck="false"></textarea>' +
        '<div class="cv-dlg-f"><button class="cr-btn sm" data-fmt>格式化</button><button class="cr-btn primary sm" data-save>写回</button></div></div>';
      var ta = mask.querySelector("textarea");
      ta.value = val;
      mask.querySelector("[data-x]").onclick = function () { mask.remove(); };
      mask.querySelector("[data-fmt]").onclick = function () {
        try { ta.value = JSON.stringify(JSON.parse(ta.value), null, 2); } catch (e) { toast("JSON 格式不对：" + e.message, "err", api); }
      };
      mask.querySelector("[data-save]").onclick = function () {
        var txt = ta.value;
        try { JSON.parse(txt); } catch (e) { toast("JSON 格式不对：" + e.message, "err", api); return; }
        addEdit(nid, field, txt);
        var el = $("#cvNodesBox .cv-node[data-nid=\"" + nid + "\"]");
        if (el) el.classList.add("edited");
        toast("已改 #" + nid + " 的 " + field + "，生成或保存时生效", "ok", api);
        mask.remove();
      };
      document.body.appendChild(mask);
    }

    function cvFit() {
      var box = $("#cvCanvas");
      if (!box || !Object.keys(CV.pos).length) return;
      var xs = [], ys = [], xe = [], ye = [];
      Object.keys(CV.pos).forEach(function (k) {
        var p = CV.pos[k];
        xs.push(p.x); ys.push(p.y); xe.push(p.x + p.w); ye.push(p.y + p.h);
      });
      var w = Math.max.apply(null, xe) - Math.min.apply(null, xs);
      var vw = box.clientWidth - 48;
      CV.s = Math.min(1.1, Math.max(0.6, vw / Math.max(1, w)));
      CV.tx = 16 - Math.min.apply(null, xs) * CV.s;
      CV.ty = 16 - Math.min.apply(null, ys) * CV.s;
      cvApply();
    }

    function cvView(mode) {
      var g = $("#cvCanvas"), l = $("#cvList");
      if (g) g.style.display = mode === "graph" ? "" : "none";
      if (l) l.style.display = mode === "graph" ? "none" : "";
      var b1 = $("#cvGraphBtn"), b2 = $("#cvListBtn");
      if (b1) b1.classList.toggle("on", mode === "graph");
      if (b2) b2.classList.toggle("on", mode !== "graph");
      try { localStorage.setItem("ps-comfy-view", mode); } catch (e) { }
    }

    function cvPaintList(r) {
      var box = $("#cvList");
      if (!box) return;
      var nodes = (r && r.nodes) || [];
      if (!nodes.length) { box.innerHTML = '<div class="mini">没有节点</div>'; return; }
      box.innerHTML = '<table class="cv-table"><thead><tr><th>#</th><th>节点</th><th>类别</th><th>可改</th><th>连线</th></tr></thead><tbody>' +
        nodes.map(function (n) {
          var w = (n.inputs || []).filter(function (i) { return i.type !== "link"; }).length;
          var k = (n.inputs || []).filter(function (i) { return i.type === "link"; }).length;
          return '<tr data-go="' + esc(n.id) + '"><td>#' + esc(n.id) + "</td><td><b>" + esc(n.class) + "</b>" +
            (n.complex ? ' <i class="cv-badge">复合</i>' : "") + "</td><td>" + esc((r.cats || {})[n.cat] || n.cat) +
            "</td><td>" + w + "</td><td>" + k + "</td></tr>";
        }).join("") + "</tbody></table>";
      box.querySelectorAll("[data-go]").forEach(function (tr) {
        tr.onclick = function () {
          cvView("graph");
          var el = $("#cvNodesBox .cv-node[data-nid=\"" + tr.dataset.go + "\"]");
          if (el) {
            var p = CV.pos[tr.dataset.go];
            CV.tx = 120 - p.x * CV.s; CV.ty = 80 - p.y * CV.s;
            cvApply();
            el.classList.add("sel");
            setTimeout(function () { el.classList.remove("sel"); }, 1400);
          }
        };
      });
    }

    async function cvPaint() {
      if (!PICK.nodeData || !S.cur) return;
      cvPaintList(PICK.nodeData);
      cvDraw(PICK.nodeData);
      cvFit();
    }

    /* 画布手势：平移 / 缩放 / 拖节点 */
    (function bindCanvasGestures() {
      var cv = $("#cvCanvas");
      if (!cv) return;
      cv.addEventListener("mousedown", function (ev) {
        if (ev.target.closest(".cv-node")) return;
        CV.pan = { sx: ev.clientX, sy: ev.clientY, tx: CV.tx, ty: CV.ty };
        cv.classList.add("panning");
      });
      window.addEventListener("mousemove", function (ev) {
        if (CV.drag) {
          var p = CV.pos[CV.drag.id];
          if (!p) return;
          p.x = CV.drag.ox + (ev.clientX - CV.drag.sx) / CV.s;
          p.y = CV.drag.oy + (ev.clientY - CV.drag.sy) / CV.s;
          var el = $("#cvNodesBox .cv-node[data-nid=\"" + CV.drag.id + "\"]");
          if (el) { el.style.left = p.x + "px"; el.style.top = p.y + "px"; }
          if (CV.data) cvEdges(CV.data.edges || [], CV.data.nodes || [], CV.pos, $("#cvEdges"), $("#cvNodesBox"));
          return;
        }
        if (CV.pan) {
          CV.tx = CV.pan.tx + (ev.clientX - CV.pan.sx);
          CV.ty = CV.pan.ty + (ev.clientY - CV.pan.sy);
          cvApply();
        }
      });
      window.addEventListener("mouseup", function () {
        if (CV.drag) {
          var el = $("#cvNodesBox .cv-node.dragging");
          if (el) el.classList.remove("dragging");
          CV.drag = null;
        }
        CV.pan = null;
        cv.classList.remove("panning");
      });
      cv.addEventListener("wheel", function (ev) {
        ev.preventDefault();
        var r = cv.getBoundingClientRect();
        var mx = ev.clientX - r.left, my = ev.clientY - r.top;
        var k = ev.deltaY < 0 ? 1.08 : 1 / 1.08;
        var s2 = Math.min(1.8, Math.max(0.3, CV.s * k));
        CV.tx = mx - (mx - CV.tx) * (s2 / CV.s);
        CV.ty = my - (my - CV.ty) * (s2 / CV.s);
        CV.s = s2;
        cvApply();
      }, { passive: false });
      var zin = $("#cvZIn"), zout = $("#cvZOut"), fit = $("#cvFit");
      if (zin) zin.onclick = function () { CV.s = Math.min(1.8, CV.s * 1.15); cvApply(); };
      if (zout) zout.onclick = function () { CV.s = Math.max(0.3, CV.s / 1.15); cvApply(); };
      if (fit) fit.onclick = cvFit;
      var b1 = $("#cvGraphBtn"), b2 = $("#cvListBtn");
      if (b1) b1.onclick = function () { cvView("graph"); };
      if (b2) b2.onclick = function () { cvView("list"); };
      try { cvView(localStorage.getItem("ps-comfy-view") || "graph"); } catch (e) { cvView("graph"); }
    })();

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
      /* 画布已经把这套节点摆出来了，右侧那份折叠列表就收起来（免得两处重复） */
      var cell = box.closest ? box.closest(".cr-cell") : null;
      if (cell && $("#cvCanvas")) { cell.style.display = "none"; }
      cvPaintList(PICK.nodeData);
      cvDraw(PICK.nodeData);
      if (!CV.fitted) { CV.fitted = true; setTimeout(cvFit, 30); }
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
      var pmImgs = (api.images && api.images()) || [];
      var needImg = NEED_IMG[body.mode] || (hasRefs && pmImgs.length);
      // 主界面参考图：先把图送进 ComfyUI 换文件名，生成时只传文件名（不重复上传整张图）
      if (needImg && pmImgs.length && !(PICK.pmFiles || []).length) {
        try {
          var st = await (await fetch(API + "stage", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              images: pmImgs.map(function (im, i) { return { name: "pm" + (i + 1), data_url: im.data_url }; })
            })
          })).json();
          if (st && st.ok) { PICK.pmFiles = st.files || []; paintRefs(); }
        } catch (e) { /* 上传失败就走下面的老路 */ }
      }
      var pm = PICK.pmFiles || [];
      if (pm.length) {
        body.files = pm.map(function (f) { return f.file; });
      } else if (needImg) {
        body.images = pmImgs.map(function (im, i) { return { name: "ref" + (i + 1), data_url: im.data_url }; });
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
    var topRun = $("#crRunTop"), topSave = $("#crSaveTop"), topImp = $("#crImpBtn");
    if (topRun) topRun.onclick = run;
    if (topSave) topSave.onclick = function () { saveEdits(true); };
    if (topImp) topImp.onclick = function () { switchTab("imp"); };
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
    mount: "page",
    render: render
  });
})();
