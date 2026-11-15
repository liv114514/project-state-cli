/*
 * project-state dashboard — vanilla JS, zero dependencies, read-only.
 * Consumes JSON produced by the project-state CLI (see data/sample-data.js header).
 * Every value taken from data is HTML-escaped before rendering.
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ vocabulary
  var LAYERS = ["git", "deps", "runtime", "config", "docker", "database"];
  var LAYER_LABEL = { git: "Git", deps: "依赖", runtime: "运行时", config: "配置", docker: "Docker", database: "数据库" };
  var KIND_LABEL = { named: "命名", safety: "安全点", auto: "自动", hook: "钩子" };
  var STATE = {
    verified: { label: "已验证", mk: "ok", tone: "" },
    "diagnostic-only": { label: "仅诊断 v1", mk: "outline", tone: "" },
    invalid: { label: "无效", mk: "bad", tone: "bad" },
    incomplete: { label: "不完整", mk: "bad", tone: "bad" },
    unknown: { label: "无法读取", mk: "unknown", tone: "unknown" },
    missing: { label: "缺失", mk: "unknown", tone: "unknown" }
  };
  var STATE_RANK = { invalid: 0, incomplete: 1, unknown: 2, missing: 3, "diagnostic-only": 4, verified: 5 };
  var CHECK = {
    ok: { label: "正常", mk: "ok", tone: "" },
    ready: { label: "就绪", mk: "ok", tone: "" },
    issue: { label: "问题", mk: "bad", tone: "bad" },
    blocked: { label: "阻断", mk: "bad", tone: "bad" },
    unknown: { label: "未知", mk: "unknown", tone: "unknown" },
    "not-applicable": { label: "不适用", mk: "outline", tone: "unknown" }
  };
  var CHECK_RANK = { issue: 0, blocked: 0, unknown: 1, "not-applicable": 2, ok: 3, ready: 3 };
  var REASON = {
    SNAPSHOT_INTEGRITY_FAILED: "制品摘要校验失败",
    SNAPSHOT_POINTER_MISSING: "缺少 current.json 指针，可能是未完成的写入",
    SNAPSHOT_ACCESS_DENIED: "访问被拒绝，内容未读取",
    SNAPSHOT_METADATA_INVALID: "元数据无效",
    SNAPSHOT_SCHEMA_UNSUPPORTED: "不支持的 schema 版本",
    SNAPSHOT_PATH_UNSAFE: "路径包含链接或重解析点",
    SNAPSHOT_PATH_TYPE_INVALID: "路径类型无效",
    SNAPSHOT_READ_FAILED: "读取失败",
    SNAPSHOT_NOT_FOUND: "未找到",
    SNAPSHOT_NAME_INVALID: "名称无效",
    SNAPSHOT_INSPECTION_UNAVAILABLE: "无法完成检查",
    LEGACY_V1_DIAGNOSTIC_ONLY: "schema v1，只能诊断，不能作为恢复来源"
  };
  var CMP_ORDER = ["git", "config", "deps", "runtime", "database", "docker"];
  var CMP_KIND = { "=": "same", "~": "changed", "+": "added", "-": "removed", "!": "alert", "?": "unknown" };
  var NOTES = [
    ["no", "Git checkout 应用", "仅提供只读预览；即使附加 --yes 也会拒绝。"],
    ["no", "prune 删除与 hook 生命周期", "Python 候选中未实现，调用时 fail-closed。"],
    ["no", "覆盖已存在的 SQLite", "数据库恢复只在目标文件与全部 sidecar 都不存在时创建。"],
    ["no", "Node 与 Python 并发写同一项目", "两套运行时的锁与日志格式互不兼容，必须串行使用。"],
    ["unverified", "Linux 与 macOS", "当前候选仅在 Windows + CPython 3.12 上验证。"],
    ["unverified", "断电持久性与 ACL 变体", "未做物理断电测试，也未覆盖完整 ACL 矩阵。"],
    ["unverified", "应用健康与自动重启", "恢复只校验文件字节与完整性，不会启动或探测应用。"],
    ["unverified", "Docker 服务对比", "只记录服务名与状态，对比尚未实现。"],
    ["note", "私有制品为明文存储", "未加密；文件系统访问控制不在本工具的检查范围内。"]
  ];

  // ------------------------------------------------------------------ helpers
  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };
  function esc(v) {
    return String(v == null ? "" : v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function count(arr, fn) { var n = 0; for (var i = 0; i < arr.length; i++) if (fn(arr[i])) n++; return n; }
  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function parseTime(iso) { var d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d : null; }
  function fmtTime(iso, year) {
    var d = parseTime(iso);
    if (!d) return "—";
    var s = pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
    return year ? d.getFullYear() + "-" + s : s;
  }
  function shortId(id) { return id ? String(id).slice(0, 8) : "—"; }
  function kindOf(s) { return /^safety-/.test(s.name || "") ? "safety" : (s.kind || "unknown"); }
  function stateOf(s) { return STATE[s.state] || { label: s.state || "未知", mk: "unknown", tone: "unknown" }; }
  function status(info) {
    return '<span class="st' + (info.tone ? " st-" + info.tone : "") + '"><i class="mk mk-' + info.mk + '"></i>' + esc(info.label) + "</span>";
  }
  function reasonText(code) { return REASON[code] || ""; }
  function plural(n, unit) { return n + " " + unit; }
  function isAttention(s) { return ["invalid", "incomplete", "unknown", "missing"].indexOf(s.state) >= 0; }

  // ------------------------------------------------------------------ data
  function emptyBundle() {
    return { bundleSchema: "project-state-dashboard/1", meta: { source: "imported" },
      list: null, doctor: { general: null, tasks: [] }, compares: [], operations: [], demo: null };
  }
  function fillBundle(b) {
    var out = emptyBundle();
    b = b || {};
    out.meta = Object.assign({}, out.meta, b.meta || {});
    out.list = b.list || null;
    out.doctor = { general: (b.doctor && b.doctor.general) || null, tasks: (b.doctor && b.doctor.tasks) || [] };
    out.compares = Array.isArray(b.compares) ? b.compares : [];
    out.operations = Array.isArray(b.operations) ? b.operations : [];
    out.demo = b.demo || null;
    return out;
  }
  /** Accept a full bundle or a single raw CLI JSON output; raw outputs merge into `base`. */
  function mergeInput(raw, base) {
    if (!raw || typeof raw !== "object") throw new Error("不是 JSON 对象");
    if (raw.bundleSchema || raw.list || raw.compares) {
      var b = fillBundle(raw);
      b.meta.source = b.meta.source === "live" ? "live" : "imported";
      return b;
    }
    var next = fillBundle(base);
    next.meta = Object.assign({}, next.meta, { source: "imported" });
    if (raw.command === "list" && Array.isArray(raw.snapshots)) {
      next.list = raw;
      next.meta.toolVersion = raw.toolVersion || next.meta.toolVersion;
    } else if (raw.command === "show" && raw.snapshot) {
      var snaps = ((next.list && next.list.snapshots) || []).filter(function (s) { return s.name !== raw.snapshot.name; });
      snaps.unshift(raw.snapshot);
      next.list = { resultSchemaVersion: 2, toolVersion: raw.toolVersion, command: "list",
        inventory: { state: "available", snapshotCount: snaps.length, diagnosticCount: 0, unrecognizedEntryCount: 0 },
        snapshots: snaps, diagnostics: [] };
    } else if (raw.command === "doctor" && raw.task) {
      next.doctor.tasks = next.doctor.tasks.filter(function (t) { return t.task !== raw.task; }).concat([raw]);
    } else if (raw.command === "demo") {
      next.demo = raw;
    } else if (raw.operationId) {
      next.operations = next.operations.filter(function (o) { return o.operationId !== raw.operationId; }).concat([raw]);
    } else {
      throw new Error("无法识别：需要 collect_data.py 生成的数据包，或 list / show / doctor --task / recover --inspect / demo 的 JSON 输出");
    }
    return next;
  }

  var DEFAULT_DATA = fillBundle(window.PROJECT_STATE_DATA || window.PROJECT_STATE_SAMPLE);
  if (window.PROJECT_STATE_DATA && !DEFAULT_DATA.meta.source) DEFAULT_DATA.meta.source = "live";
  var data = DEFAULT_DATA;

  var view = { q: "", state: "all", kind: "all", sort: "createdAt", dir: "desc", cmp: 0, onlyDiff: false, selected: null };

  function snapshots() { return (data.list && data.list.snapshots) || []; }
  function verified() { return snapshots().filter(function (s) { return s.state === "verified"; }); }
  function liveCompare() { return data.compares.filter(function (c) { return !c.b; })[0] || null; }

  // ------------------------------------------------------------------ copy / toast
  var toastTimer = null;
  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (_) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }
  function copyText(text) {
    var done = function (ok) { toast(ok ? "已复制：" + text : "复制失败，请手动选择命令文本"); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else {
      done(fallbackCopy(text));
    }
  }
  function copyBtn(cmd, label) {
    return '<button type="button" class="btn btn-quiet btn-small" data-copy="' + esc(cmd) + '">' + esc(label || "复制") + "</button>";
  }

  // ------------------------------------------------------------------ masthead
  function renderMast() {
    var m = data.meta || {};
    var src = m.source || "imported";
    var srcLabel = { sample: "合成示例数据", live: "本地采集", imported: "手动导入" }[src] || src;
    var rows = [
      ["项目", m.projectLabel || "—"],
      ["工具版本", m.toolVersion || (data.list && data.list.toolVersion) || "—"],
      ["数据来源", '<span class="src-' + esc(src) + '">' + esc(srcLabel) + "</span>", true],
      ["生成时间", fmtTime(m.generatedAt, true)]
    ];
    $("#mastMeta").innerHTML = rows.map(function (r) {
      return "<dt>" + esc(r[0]) + "</dt><dd>" + (r[2] ? r[1] : esc(r[1])) + "</dd>";
    }).join("");
  }

  // ------------------------------------------------------------------ lead
  function attentionItems() {
    var items = [];
    data.operations.forEach(function (o) {
      var open = ["completed", "rolled-back", "cancelled"].indexOf(o.status) < 0;
      if (!open && o.classification !== "uncertain") return;
      items.push({ level: "bad", rank: 0,
        title: "恢复操作 " + shortId(o.operationId) + " 尚未结束",
        detail: "目标 " + esc(o.target || "—") + "，阶段 " + esc(o.phase || "—") + "，判定 " + esc(o.classification || "—") +
          "。在它被继续或回滚之前，新的快照与恢复都会被拒绝。",
        cmd: "project-state recover " + o.operationId + " --inspect", jump: "#op-" + o.operationId });
    });
    snapshots().forEach(function (s) {
      if (!isAttention(s)) return;
      var bad = s.state === "invalid" || s.state === "incomplete";
      var r = reasonText(s.reasonCode);
      items.push({ level: bad ? "bad" : "unknown", rank: bad ? 1 : 4,
        title: "快照 " + esc(s.name) + " " + esc(stateOf(s).label),
        detail: (r ? esc(r) + "。" : "") + (bad ? "保留原状，不要用作恢复来源。" : "工具未能读取其内容，请人工检查访问权限。") +
          (s.reasonCode ? ' <span class="code">' + esc(s.reasonCode) + "</span>" : ""),
        snap: s.name });
    });
    var inv = (data.list && data.list.inventory) || {};
    if (inv.unrecognizedEntryCount) {
      items.push({ level: "unknown", rank: 5, title: "快照目录中有 " + inv.unrecognizedEntryCount + " 个无法识别的条目",
        detail: "名称不符合快照命名规则，工具没有读取其内容。" });
    }
    (data.doctor.tasks || []).forEach(function (t) {
      if (!t.summary || t.summary.state !== "blocked") return;
      var codes = (t.checks || []).filter(function (c) { return c.required && c.state === "issue"; })
        .map(function (c) { return '<span class="code">' + esc(c.reasonCode) + "</span>"; }).join(" ");
      items.push({ level: "bad", rank: 2, title: "任务 " + esc(t.task) + (t.snapshot ? "（" + esc(t.snapshot) + "）" : "") + " 被阻断",
        detail: "必需检查未通过：" + codes, jump: "#diagnostics" });
    });
    var g = data.doctor.general;
    if (g) (g.checks || []).forEach(function (c) {
      if (c.state !== "issue") return;
      items.push({ level: "warn", rank: 3, title: "诊断：" + esc(c.id),
        detail: esc(c.detail || "") + ' <span class="code">' + esc(c.reasonCode) + "</span>", jump: "#diagnostics" });
    });
    var live = liveCompare();
    if (live) {
      var p = parseCompare(live.text);
      if (p.differences) {
        items.push({ level: "warn", rank: 3, title: "工作区相对 " + esc(live.a) + " 有 " + p.differences + " 处受支持的差异",
          detail: "包括 Git、配置、依赖元数据与运行时 pin；私有值不显示。", jump: "#changes", cmp: data.compares.indexOf(live) });
      }
    }
    return items.sort(function (a, b) { return a.rank - b.rank; });
  }

  function renderLead() {
    var all = snapshots(), ver = verified();
    var items = attentionItems();
    var m = data.meta || {};
    $("#eyebrow").textContent = "概况" + (m.generatedAt ? "　截至 " + fmtTime(m.generatedAt, true) : "");

    var head;
    if (!all.length) head = "还没有找到任何快照。";
    else head = '<span class="num">' + ver.length + "</span> / " + all.length + " 份快照通过完整性校验" +
      (items.length ? '，<span class="hl">' + items.length + " 项</span>需要处理。" : "，没有待处理事项。");
    $("#headline").innerHTML = head;

    var sf = [];
    var latest = ver.slice().sort(function (a, b) { return (parseTime(b.createdAt) || 0) - (parseTime(a.createdAt) || 0); })[0];
    if (latest) {
      var collected = count(latest.layers || [], function (l) { return l.status === "collected"; });
      sf.push("最新的已验证快照是 <b>" + esc(latest.name) + "</b>，创建于 " + esc(fmtTime(latest.createdAt)) +
        "，采集了 " + collected + " / " + LAYERS.length + " 个层。");
    }
    var live = liveCompare();
    if (live) {
      var d = parseCompare(live.text).differences;
      sf.push(d ? "与当前工作区相比有 " + d + " 处差异。" : "当前工作区与它一致。");
    }
    var g = data.doctor.general;
    if (g) {
      var iss = count(g.checks || [], function (c) { return c.state === "issue"; });
      var unk = count(g.checks || [], function (c) { return c.state === "unknown"; });
      sf.push("只读诊断发现 " + iss + " 项问题、" + unk + " 项无法确定。");
    }
    $("#standfirst").innerHTML = sf.join("");

    $("#queue").innerHTML = items.length ? items.map(function (it, i) {
      var acts = [];
      if (it.snap) acts.push('<button type="button" class="btn btn-quiet btn-small" data-snap="' + esc(it.snap) + '">查看快照</button>');
      if (it.jump) acts.push('<button type="button" class="btn btn-quiet btn-small" data-jump="' + esc(it.jump) + '"' +
        (it.cmp != null ? ' data-cmp-go="' + it.cmp + '"' : "") + ">前往</button>");
      if (it.cmd) acts.push(copyBtn(it.cmd, "复制命令"));
      return '<li class="q-item q-' + it.level + '"><span class="q-no">' + pad(i + 1) + "</span>" +
        '<div class="q-title"><i class="mk mk-' + it.level + '"></i><span>' + it.title + "</span></div>" +
        '<div class="q-act">' + acts.join("") + "</div>" +
        '<div class="q-detail">' + it.detail + (it.cmd ? '<br><code class="cmd">' + esc(it.cmd) + "</code>" : "") + "</div></li>";
    }).join("") : '<li class="q-empty">没有需要处理的事项。</li>';

    // Ledger of key figures
    var diag = count(all, function (s) { return s.state === "diagnostic-only"; });
    var att = count(all, isAttention);
    var complete = count(ver, function (s) { return s.inputCompleteness === "complete"; });
    var arts = [];
    ver.forEach(function (s) { arts = arts.concat(s.artifacts || []); });
    var sup = count(arts, function (a) { return a.restoreClass === "supported"; });
    var priv = count(arts, function (a) { return a.privacy === "private"; });
    var ops = data.operations;
    var open = count(ops, function (o) { return ["completed", "rolled-back"].indexOf(o.status) < 0; });
    var figs = [
      ["快照", all.length, "已验证 " + ver.length + " · 仅诊断 " + diag + " · 异常 " + att, att > 0 && false],
      ["输入完整", complete + "<small>/ " + ver.length + "</small>", ver.length - complete ? "其余 " + (ver.length - complete) + " 份已验证快照有采集层被跳过" : "所有已验证快照的六个层均已采集"],
      ["已验证制品", arts.length, "可恢复 " + sup + " · 仅记录 " + (arts.length - sup) + " · 私有 " + priv],
      ["未结束的恢复", open, "共 " + ops.length + " 条恢复日志", open > 0]
    ];
    if (g) {
      var gi = count(g.checks || [], function (c) { return c.state === "issue"; });
      figs.push(["诊断问题", gi, "未知 " + count(g.checks || [], function (c) { return c.state === "unknown"; }) +
        " · 正常 " + count(g.checks || [], function (c) { return c.state === "ok"; }), false]);
    }
    if (data.demo) {
      figs.push(["内置演示", data.demo.state === "passed" ? "通过" : esc(data.demo.state),
        esc((data.demo.stages || []).join(" → ")) + (data.demo.durationMs != null ? " · " + data.demo.durationMs + " ms" : ""), data.demo.state !== "passed"]);
    }
    $("#figures").innerHTML = figs.map(function (f) {
      return '<div class="fig"><dt>' + esc(f[0]) + '</dt><dd><span class="v' + (f[3] ? " is-bad" : "") + '">' + f[1] +
        '</span><span class="note">' + esc(f[2]).replace(/&amp;rarr;/g, "→") + "</span></dd></div>";
    }).join("");

    var note = "本页只显示工具已验证的证据。应用健康未测试，恢复前置条件未检查，私有值不在本页显示。";
    if (m.source === "sample") note += "<br><b>当前为合成示例数据。</b>运行 <code>tools/collect_data.py</code> 或导入 JSON 以查看真实项目。";
    if (Array.isArray(m.errors) && m.errors.length) {
      note += "<br>采集时有 " + m.errors.length + " 条命令未返回可用结果：" + m.errors.map(function (e) { return "<code>" + esc(e.command) + "</code>"; }).join("、");
    }
    $("#leadNote").innerHTML = note;
  }

  // ------------------------------------------------------------------ snapshots
  function filtered() {
    var q = view.q.trim().toLowerCase();
    return snapshots().filter(function (s) {
      if (view.state === "verified" && s.state !== "verified") return false;
      if (view.state === "attention" && !isAttention(s)) return false;
      if (view.state === "legacy" && s.state !== "diagnostic-only") return false;
      if (view.kind !== "all" && kindOf(s) !== view.kind) return false;
      if (q && (String(s.name).toLowerCase().indexOf(q) < 0) && (String(s.reasonCode || "").toLowerCase().indexOf(q) < 0)) return false;
      return true;
    });
  }
  function sortValue(s, key) {
    if (key === "name") return String(s.name || "");
    if (key === "createdAt") { var d = parseTime(s.createdAt); return d ? +d : null; }
    if (key === "state") return STATE_RANK[s.state] != null ? STATE_RANK[s.state] : 9;
    if (key === "artifacts") return s.artifacts ? s.artifacts.length : null;
    return null;
  }
  function sorted(rows) {
    var key = view.sort, dir = view.dir === "asc" ? 1 : -1;
    return rows.slice().sort(function (a, b) {
      var va = sortValue(a, key), vb = sortValue(b, key);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;           // empty values always last
      if (vb == null) return -1;
      return (va < vb ? -1 : va > vb ? 1 : 0) * dir;
    });
  }

  function layerCells(s) {
    var byId = {};
    (s.layers || []).forEach(function (l) { byId[l.id] = l; });
    var cells = "", dots = "";
    LAYERS.forEach(function (id) {
      var l = byId[id];
      if (!l) {
        cells += '<td class="lc lc-none" title="' + esc(LAYER_LABEL[id]) + '：无层元数据">·</td>';
        dots += '<i class="n" title="' + esc(LAYER_LABEL[id]) + '：无元数据"></i>';
      } else if (l.status === "collected") {
        var t = LAYER_LABEL[id] + "：已采集 " + l.artifactCount + " 个制品（可恢复 " + l.supportedArtifactCount + "，私有 " + l.privateArtifactCount + "）";
        cells += '<td class="lc" title="' + esc(t) + '">' + esc(l.artifactCount) + "</td>";
        dots += '<i title="' + esc(t) + '"></i>';
      } else {
        cells += '<td class="lc lc-skip" title="' + esc(LAYER_LABEL[id]) + '：跳过（不代表干净）">—</td>';
        dots += '<i class="s" title="' + esc(LAYER_LABEL[id]) + '：跳过"></i>';
      }
    });
    return { cells: cells, dots: dots };
  }

  function renderSnapshots() {
    var all = snapshots();
    var rows = sorted(filtered());
    $("#snapCount").textContent = "显示 " + rows.length + " / " + all.length;
    $$(".snaps thead th[data-key]").forEach(function (th) {
      if (th.getAttribute("data-key") === view.sort) th.setAttribute("aria-sort", view.dir === "asc" ? "ascending" : "descending");
      else th.removeAttribute("aria-sort");
    });
    $$("#stateFilter button").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute("data-state") === view.state)); });

    if (!rows.length) {
      $("#snapRows").innerHTML = '<tr><td colspan="13" class="empty">' + (all.length ? "没有符合筛选条件的快照。" : "没有快照数据。") + "</td></tr>";
    } else {
      $("#snapRows").innerHTML = rows.map(function (s) {
        var info = stateOf(s), lc = layerCells(s), arts = s.artifacts || [];
        var ver = s.state === "verified";
        var sub = [KIND_LABEL[kindOf(s)] || s.kind || "未知类型"];
        if (s.inputCompleteness === "complete") sub.push("完整");
        else if (s.inputCompleteness === "partial") sub.push('<span class="partial">部分采集</span>');
        var subLine = s.reasonCode && !ver ? '<span class="sub code">' + esc(s.reasonCode) + "</span>" : '<span class="sub">' + sub.join(" · ") + "</span>";
        return '<tr data-row="' + esc(s.name) + '"' + (view.selected === s.name ? ' class="is-selected"' : "") + ">" +
          '<td><button type="button" class="name-btn" data-snap="' + esc(s.name) + '">' + esc(s.name) + "</button>" + subLine + "</td>" +
          "<td>" + status(info) + "</td>" +
          '<td class="num c-time">' + esc(fmtTime(s.createdAt)) + "</td>" +
          lc.cells +
          '<td class="col-compact"><span class="dots">' + lc.dots + "</span></td>" +
          '<td class="num">' + (ver ? arts.length : "—") + "</td>" +
          '<td class="num c-sub">' + (ver ? count(arts, function (a) { return a.restoreClass === "supported"; }) : "—") + "</td>" +
          '<td class="num c-sub">' + (ver ? count(arts, function (a) { return a.privacy === "private"; }) : "—") + "</td></tr>";
      }).join("");
    }

    var ver = verified();
    var arts = [];
    ver.forEach(function (s) { arts = arts.concat(s.artifacts || []); });
    $("#snapFoot").innerHTML = ver.length ? '<tr><td colspan="3">已验证快照的层覆盖</td>' + LAYERS.map(function (id) {
      var n = count(ver, function (s) { return (s.layers || []).some(function (l) { return l.id === id && l.status === "collected"; }); });
      var pct = Math.round(n / ver.length * 100);
      return '<td class="lc" title="' + esc(LAYER_LABEL[id]) + "：" + n + " / " + ver.length + "（" + pct + '%）">' + n + "/" + ver.length +
        '<div class="cov"><span style="width:' + pct + '%"></span></div></td>';
    }).join("") + '<td class="col-compact"></td><td class="num">' + arts.length + '</td><td class="num c-sub">' +
      count(arts, function (a) { return a.restoreClass === "supported"; }) + '</td><td class="num c-sub">' +
      count(arts, function (a) { return a.privacy === "private"; }) + "</td></tr>" : "";
  }

  // Timeline strip: one tick per snapshot; height ~ artifact count.
  function renderStrip() {
    var host = $("#strip");
    var all = snapshots();
    if (!all.length) { host.innerHTML = ""; return; }
    var dated = all.filter(function (s) { return parseTime(s.createdAt); });
    var undated = all.filter(function (s) { return !parseTime(s.createdAt); });
    var W = Math.max(host.clientWidth || 800, 300);
    var H = 76, base = 50, undW = undated.length ? Math.min(140, 34 + undated.length * 12) : 0;
    var plotR = W - (undW ? undW + 20 : 0);
    var times = dated.map(function (s) { return +parseTime(s.createdAt); });
    var t0 = times.length ? Math.min.apply(null, times) : Date.now();
    var t1 = times.length ? Math.max.apply(null, times) : Date.now();
    var span = Math.max(t1 - t0, 6 * 3600e3);
    t0 -= span * .03; t1 += span * .03;
    var x = function (t) { return 6 + (t - t0) / (t1 - t0) * (plotR - 12); };
    var maxA = Math.max.apply(null, all.map(function (s) { return (s.artifacts || []).length; }).concat([1]));

    function tick(s, tx) {
      var cls = s.state === "verified" ? "ok" : s.state === "diagnostic-only" ? "legacy" : isAttention(s) && (s.state === "invalid" || s.state === "incomplete") ? "bad" : "unknown";
      var h = s.state === "verified" ? 12 + 28 * ((s.artifacts || []).length / maxA) : 18;
      var w = cls === "unknown" || cls === "legacy" ? 5 : 3;
      var partial = s.state === "verified" && s.inputCompleteness === "partial";
      return '<g class="tick tick-' + cls + (partial ? " tick-partial" : "") + '" data-snap="' + esc(s.name) + '" tabindex="0" role="button" aria-label="' +
        esc(s.name + "，" + stateOf(s).label + "，" + fmtTime(s.createdAt)) + '">' +
        '<rect class="hit" x="' + (tx - 6) + '" y="' + (base - 44) + '" width="12" height="46"></rect>' +
        '<rect class="bar" x="' + (tx - w / 2) + '" y="' + (base - h) + '" width="' + w + '" height="' + h + '"></rect>' +
        '<rect class="cap" x="' + (tx - 3) + '" y="' + (base - h - 5) + '" width="6" height="2"></rect></g>';
    }

    var svg = ['<svg viewBox="0 0 ' + W + " " + H + '" role="group" aria-label="快照时间分布">'];
    // day grid
    var day = 864e5, spanDays = (t1 - t0) / day;
    var steps = [0.25, 0.5, 1, 2, 3, 7, 14, 30, 60], step = steps[steps.length - 1];
    for (var i = 0; i < steps.length; i++) { if (spanDays / steps[i] <= Math.max(2, plotR / 96)) { step = steps[i]; break; } }
    var start = new Date(t0); start.setHours(0, 0, 0, 0);
    for (var t = +start; t <= t1; t += step * day) {
      if (t < t0) continue;
      var gx = x(t), d = new Date(t);
      svg.push('<line class="grid" x1="' + gx + '" x2="' + gx + '" y1="' + (base - 44) + '" y2="' + base + '"></line>');
      svg.push('<text class="axis" x="' + gx + '" y="' + (base + 18) + '" text-anchor="middle">' +
        (step < 1 ? pad(d.getHours()) + ":00" : pad(d.getMonth() + 1) + "-" + pad(d.getDate())) + "</text>");
    }
    svg.push('<line class="base" x1="0" x2="' + plotR + '" y1="' + base + '" y2="' + base + '"></line>');
    dated.forEach(function (s) { svg.push(tick(s, x(+parseTime(s.createdAt)))); });
    if (undated.length) {
      var zx = W - undW;
      svg.push('<rect class="zone" x="' + zx + '" y="' + (base - 44) + '" width="' + undW + '" height="44"></rect>');
      svg.push('<text class="axis" x="' + (zx + undW / 2) + '" y="' + (base + 18) + '" text-anchor="middle">无创建时间</text>');
      undated.forEach(function (s, k) { svg.push(tick(s, zx + 16 + k * 12)); });
    }
    svg.push("</svg>");
    host.innerHTML = svg.join("");
  }

  // ------------------------------------------------------------------ compare
  function parseCompare(text) {
    var sections = {}, order = [], current = null, total = null;
    function get(id) {
      if (!sections[id]) { sections[id] = { id: id, lines: [] }; order.push(id); }
      return sections[id];
    }
    String(text || "").split(/\r?\n/).forEach(function (raw) {
      var line = raw.trim();
      if (!line) return;
      var head = line.match(/^\[([\w-]+)\]$/);
      if (head) { current = get(head[1]); return; }
      if (/^Comparison completed:/.test(line)) { total = line; return; }
      var sym = line.charAt(0), kind = CMP_KIND[sym] || "info";
      var body = kind === "info" ? line : line.slice(1).trim();
      // The CLI prints config lines inside [git]; give them their own group.
      var sec = /^config\s/.test(body) ? get("config") : (current || get("other"));
      sec.lines.push({ kind: kind, sym: kind === "info" ? "·" : (sym === "-" ? "−" : sym), text: body });
    });
    order.sort(function (a, b) {
      var ia = CMP_ORDER.indexOf(a), ib = CMP_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var m = total && total.match(/(\d+)\s+supported difference/);
    return { sections: order.map(function (id) { return sections[id]; }), total: total, differences: m ? +m[1] : null };
  }
  function diffText(text) {
    return esc(text).replace(/\s*\(([^()]*(?:withheld|not compared)[^()]*)\)/g, function (_, inner) {
      var label = /withheld/.test(inner) ? "值已隐藏" : "内容未比较";
      return '<span class="withheld" title="' + inner + '">' + label + "</span>";
    });
  }

  function renderCompare() {
    var list = data.compares;
    var idx = $("#cmpIndex"), viewEl = $("#cmpView");
    if (!list.length) {
      idx.innerHTML = "";
      viewEl.innerHTML = '<p class="empty">没有对比数据。collect_data.py 会对“最新快照与当前工作区”和“相邻两份快照”执行只读 compare。</p>';
      return;
    }
    if (view.cmp >= list.length) view.cmp = 0;
    idx.innerHTML = list.map(function (c, i) {
      var d = parseCompare(c.text).differences;
      return '<li><button type="button" data-cmp="' + i + '" aria-current="' + (i === view.cmp) + '">' +
        '<span class="pair"><span>' + esc(c.a) + '</span><span class="to">' + esc(c.b || "当前工作区") + "</span></span>" +
        '<span class="d' + (d ? "" : " zero") + '" title="受支持的差异数">' + (d == null ? "?" : d) + "</span></button></li>";
    }).join("");
    drawCompare(list[view.cmp]);
  }

  function drawCompare(c) {
    var p = parseCompare(c.text);
    var all = [];
    p.sections.forEach(function (s) { all = all.concat(s.lines); });
    var n = function (k) { return count(all, function (l) { return l.kind === k; }); };
    var head = '<div class="cmp-head"><div><h3 class="cmp-title">' + esc(c.a) + '<span class="of">对比</span>' + esc(c.b || "当前工作区") + "</h3>" +
      '<p class="cmp-tally">变化 <b>' + (n("changed") + n("added") + n("removed")) + "</b>　一致 <b>" + n("same") + "</b>　未比较 <b>" + n("unknown") +
      "</b>　内部不一致 <b>" + n("alert") + "</b>" + (c.exitCode ? "　退出码 <b>" + esc(c.exitCode) + "</b>" : "") + "</p></div>" +
      '<label class="toggle"><input type="checkbox" id="onlyDiff"' + (view.onlyDiff ? " checked" : "") + ">只看变化与未比较项</label></div>";
    var rows = [];
    p.sections.forEach(function (s) {
      var lines = s.lines.filter(function (l) { return !view.onlyDiff || l.kind !== "same"; });
      lines.forEach(function (l, i) {
        rows.push('<tr class="k-' + l.kind + (i === 0 ? " grp" : "") + '"><td class="layer">' + (i === 0 ? esc(LAYER_LABEL[s.id] || s.id) : "") +
          '</td><td class="sym">' + esc(l.sym) + '</td><td class="txt">' + diffText(l.text) + "</td></tr>");
      });
    });
    var body = rows.length ? '<table class="tbl diff"><caption class="visually-hidden">对比结果</caption><tbody>' + rows.join("") + "</tbody></table>"
      : '<p class="empty">所有受支持的项目都一致。</p>';
    $("#cmpView").innerHTML = head + body + (p.total ? '<p class="cmp-foot">' + esc(p.total) + "</p>" : "");
  }

  // ------------------------------------------------------------------ diagnostics
  function checkInfo(state) { return CHECK[state] || { label: state || "未知", mk: "unknown", tone: "unknown" }; }
  function renderDoctor() {
    var g = data.doctor.general;
    var html = "";
    if (!g) {
      html = '<div class="subhead"><h3>通用诊断</h3></div><p class="empty">未采集（project-state doctor）。</p>';
    } else {
      var checks = (g.checks || []).slice().sort(function (a, b) { return (CHECK_RANK[a.state] || 9) - (CHECK_RANK[b.state] || 9); });
      var iss = count(checks, function (c) { return c.state === "issue"; });
      var unk = count(checks, function (c) { return c.state === "unknown"; });
      var tools = g.tools || {};
      html = '<div class="subhead"><h3>通用诊断</h3><span class="aside">结论 ' + status(checkInfo(g.verdict)) + "　" + iss + " 项问题 · " + unk + " 项未知</span></div>" +
        '<p class="tools">' + Object.keys(tools).map(function (k) {
          return "<span><em>" + esc(k) + "</em>" + esc(tools[k] || "不可用") + "</span>";
        }).join("") + "</p>" +
        '<table class="tbl doc"><thead><tr><th class="c-check">检查项</th><th class="c-res">结果</th><th>说明</th></tr></thead><tbody>' +
        checks.map(function (c) {
          return '<tr><td class="c-check">' + esc(c.id) + '<span class="sub code">' + esc(c.reasonCode) + "</span></td><td>" + status(checkInfo(c.state)) +
            '</td><td><span class="detail">' + esc(c.detail || c.message || "") + "</span></td></tr>";
        }).join("") + "</tbody></table>";
      if (data.demo) {
        html += '<p class="demo-line">内置演示 ' + status(checkInfo(data.demo.state === "passed" ? "ok" : "issue")) + " " +
          esc((data.demo.stages || []).join(" → ")) + '<span class="code">' + esc(data.demo.fixture || "") +
          (data.demo.durationMs != null ? " · " + esc(data.demo.durationMs) + " ms" : "") + "</span></p>";
      }
    }
    $("#docGeneral").innerHTML = html;

    var tasks = data.doctor.tasks || [];
    $("#docTasks").innerHTML = tasks.length ? tasks.map(function (t) {
      var st = t.summary && t.summary.state;
      return '<div class="task"><div class="subhead"><h3>' + esc(t.task) + "</h3>" + status(checkInfo(st)) + "</div>" +
        (t.snapshot ? '<p class="sub">快照 <span class="code">' + esc(t.snapshot) + "</span></p>" : "") +
        '<ul class="task-list">' + (t.checks || []).map(function (c) {
          var info = checkInfo(c.state);
          return '<li><i class="mk mk-' + info.mk + '" title="' + esc(info.label) + '"></i><span>' + esc(c.id) +
            ' <span class="code">' + esc(c.reasonCode) + '</span></span><span class="req">' + (c.required ? "必需" : "可选") +
            '</span><span class="msg">' + esc(c.message || "") + "</span></li>";
        }).join("") + "</ul></div>";
    }).join("") : '<div class="subhead"><h3>任务就绪度</h3></div><p class="empty">未采集（doctor --task … --json）。</p>';
  }

  // ------------------------------------------------------------------ recovery
  var STEPS = [["prepared", "准备"], ["published", "发布"], ["verified", "验证"], ["rolled-back", "回滚"], ["cancelled", "取消"]];
  function stepState(o) {
    if (o.status === "completed") return ["done", "done", "done", "", ""];
    if (o.status === "rolled-back") return ["done", "done", "done", "rb", ""];
    if (o.status === "cancelled") return ["done", "", "", "", "done"];
    if (o.status === "rolling-back") return ["done", "done", "done", "current", ""];
    var idx = { prepared: 0, "displace-intent": 0, "publish-intent": 1, published: 1,
      verified: 2, completed: 2, "rollback-intent": 3, "rollback-displace-intent": 3,
      "rollback-publish-intent": 3, "rollback-published": 3 }[o.phase];
    var out = ["", "", "", "", ""];
    if (idx == null) return out;
    for (var i = 0; i < idx; i++) out[i] = "done";
    out[idx] = "current";
    return out;
  }
  function renderOps() {
    var ops = data.operations;
    var host = $("#ops");
    if (!ops.length) { host.innerHTML = '<p class="empty">没有恢复日志。可用 collect_data.py --operation &lt;id&gt; 采集 recover --inspect 的结果。</p>'; return; }
    var order = function (o) { return ["completed", "rolled-back", "cancelled"].indexOf(o.status) < 0 ? 0 : 1; };
    host.innerHTML = ops.slice().sort(function (a, b) { return order(a) - order(b); }).map(function (o) {
      var st = stepState(o), src = o.source || {}, safety = o.safety || {};
      var cls = o.classification || o.status;
      var tone = cls === "completed" ? { label: "已完成", mk: "ok", tone: "" } : cls === "rolled-back" ? { label: "已回滚", mk: "outline", tone: "" } :
        cls === "cancelled-not-applied" || cls === "cancelled-not-published" || o.status === "cancelled" ? { label: "已取消（未恢复）", mk: "outline", tone: "" } :
        cls === "uncertain" ? { label: "状态不确定", mk: "bad", tone: "bad" } : { label: cls, mk: "bad", tone: "bad" };
      var inspect = "project-state recover " + o.operationId + " --inspect";
      var actions = (o.recoveryActions || []).map(function (a) {
        var cmd = "project-state recover " + o.operationId + " " + a + " --yes";
        return '<div class="cmdrow"><code class="cmd">' + esc(cmd) + "</code>" + copyBtn(cmd) + "</div>";
      }).join("");
      return '<article class="op" id="op-' + esc(o.operationId) + '"><div class="op-head"><span class="op-id">' + esc(o.operationId) + "</span>" + status(tone) + "</div>" +
        '<div><ol class="steps">' + STEPS.map(function (s, i) { return '<li class="' + st[i] + '">' + s[1] + "</li>"; }).join("") + "</ol>" +
        '<dl class="kv"><dt>目标</dt><dd>' + esc(o.target || "—") + "</dd>" +
        "<dt>来源快照</dt><dd>" + esc(src.snapshot || src.name || "—") + (src.generation ? ' <span class="code">' + esc(shortId(src.generation)) + "</span>" : "") + "</dd>" +
        "<dt>安全快照</dt><dd>" + esc(safety.name || "—") + "</dd>" +
        "<dt>状态 / 阶段</dt><dd>" + esc(o.status) + " / " + esc(o.phase) + "</dd>" +
        "<dt>暂存完整性</dt><dd>" + esc(o.stageIntegrity || "—") + "</dd>" +
        "<dt>resolver</dt><dd>" + esc(o.resolver || "—") + "</dd></dl></div>" +
        '<div class="op-next">' + (actions ? "<p>可执行的恢复动作（会写入项目，需人工审阅后执行）：</p>" + actions
          : "<p>没有待处理的恢复动作。</p>") +
        '<p>只读检查：</p><div class="cmdrow"><code class="cmd">' + esc(inspect) + "</code>" + copyBtn(inspect) + "</div></div></article>";
    }).join("");
  }

  // ------------------------------------------------------------------ notes
  function renderNotes() {
    var cat = { no: ["不支持", "cat-no"], unverified: ["未验证", ""], note: ["注意", ""] };
    $("#notesList").innerHTML = NOTES.map(function (n, i) {
      return '<li><span class="n">' + pad(i + 1) + "</span><div><strong>" + esc(n[1]) + '</strong><span class="cat ' + cat[n[0]][1] + '">' + cat[n[0]][0] +
        "</span><br>" + esc(n[2]) + "</div></li>";
    }).join("");
  }

  // ------------------------------------------------------------------ drawer
  var drawer = $("#drawer"), lastFocus = null;
  function openSnapshot(name) {
    var s = snapshots().filter(function (x) { return x.name === name; })[0];
    if (!s) return;
    view.selected = name;
    var info = stateOf(s);
    var html = ['<p class="d-kicker">快照</p><h2 class="d-title" id="drawerTitle">' + esc(s.name) + "</h2>",
      '<p class="d-status">' + status(info) + "<span>" + esc(KIND_LABEL[kindOf(s)] || s.kind || "未知类型") + "</span>" +
      (s.schemaVersion ? "<span>schema v" + esc(s.schemaVersion) + "</span>" : "") +
      (s.inputCompleteness ? "<span>" + (s.inputCompleteness === "complete" ? "输入完整" : s.inputCompleteness === "partial" ? "部分采集" : "完整度未知") + "</span>" : "") + "</p>"];

    html.push('<div class="d-sec"><h3>概要</h3><dl class="kv"><dt>generation</dt><dd>' + esc(s.generation || "—") + "</dd><dt>创建时间</dt><dd>" + esc(fmtTime(s.createdAt, true)) + "</dd>" +
      (s.reasonCode ? "<dt>原因</dt><dd>" + esc(s.reasonCode) + (reasonText(s.reasonCode) ? "<br>" + esc(reasonText(s.reasonCode)) : "") + "</dd>" : "") +
      (s.environment ? "<dt>恢复前置条件</dt><dd>" + esc(s.environment.restorePrerequisites) + "</dd><dt>应用健康</dt><dd>" + esc(s.environment.applicationHealth) + "</dd>" : "") + "</dl></div>");

    var integ = s.integrity;
    if (integ && integ.requiredArtifacts != null) {
      var pct = integ.requiredArtifacts ? integ.requiredVerified / integ.requiredArtifacts * 100 : 0;
      html.push('<div class="d-sec"><h3>完整性</h3><div class="integrity">' + esc(integ.requiredVerified) + " / " + esc(integ.requiredArtifacts) +
        " 个必需制品已验证，共 " + esc(integ.totalArtifacts) + " 个，缺失 " + esc(integ.missingArtifacts) +
        '<div class="bar"><span style="width:' + pct + '%"></span></div></div></div>');
    }
    if (s.checks && s.checks.length) {
      html.push('<div class="d-sec"><h3>检查项</h3><table class="tbl"><tbody>' + s.checks.map(function (c) {
        return "<tr><td>" + esc(c.id) + '<span class="sub code">' + esc(c.reasonCode) + "</span></td><td>" + status(checkInfo(c.state)) + "</td></tr>";
      }).join("") + "</tbody></table></div>");
    }
    if (s.layers && s.layers.length) {
      html.push('<div class="d-sec"><h3>采集层</h3><table class="tbl"><thead><tr><th>层</th><th>状态</th><th class="num">制品</th><th class="num">可恢复</th><th class="num">私有</th></tr></thead><tbody>' +
        s.layers.map(function (l) {
          var on = l.status === "collected";
          return "<tr><td>" + esc(LAYER_LABEL[l.id] || l.id) + "</td><td>" + status(on ? CHECK.ok : { label: "跳过", mk: "unknown", tone: "unknown" }).replace("正常", "已采集") +
            '</td><td class="num">' + esc(l.artifactCount) + '</td><td class="num">' + esc(l.supportedArtifactCount) + '</td><td class="num">' + esc(l.privateArtifactCount) + "</td></tr>";
        }).join("") + "</tbody></table></div>");
    }
    if (s.artifacts && s.artifacts.length) {
      html.push('<div class="d-sec"><h3>制品</h3><table class="tbl"><thead><tr><th>目标</th><th>层 / 类型</th><th>隐私</th><th>恢复</th></tr></thead><tbody>' +
        s.artifacts.map(function (a) {
          return '<tr><td class="code" style="color:var(--ink)">' + esc(a.target || a.id) + "</td><td>" + esc(LAYER_LABEL[a.layer] || a.layer) + ' <span class="code">' + esc(a.kind) +
            "</span></td><td>" + (a.privacy === "private" ? "私有" : '<span class="st-unknown">公开</span>') + "</td><td>" +
            (a.restoreClass === "supported" ? "可恢复" : '<span class="st-unknown">仅记录</span>') + "</td></tr>";
        }).join("") + "</tbody></table></div>");
    }
    var cmds = [["查看完整校验结果（只读）", "project-state show " + s.name + " --json"]];
    if (s.state === "verified") {
      cmds.push(["与当前工作区对比（只读）", "project-state compare " + s.name]);
      cmds.push(["配置恢复预检（只读）", "project-state doctor --task config-restore --snapshot " + s.name + " --json"]);
      cmds.push(["配置恢复预览（不写入）", "project-state restore " + s.name + " --only config"]);
    }
    html.push('<div class="d-sec"><h3>相关命令</h3><ul class="cmd-list">' + cmds.map(function (c) {
      return '<li><span class="what">' + esc(c[0]) + '</span><code class="cmd">' + esc(c[1]) + "</code>" + copyBtn(c[1]) + "</li>";
    }).join("") + "</ul></div>");
    if (s.limitations && s.limitations.length) {
      html.push('<div class="d-sec"><h3>工具声明的限制</h3><ul class="limits">' + s.limitations.map(function (l) { return "<li>" + esc(l) + "</li>"; }).join("") + "</ul></div>");
    }
    $("#drawerBody").innerHTML = html.join("");
    $$("#snapRows tr").forEach(function (tr) { tr.classList.toggle("is-selected", tr.getAttribute("data-row") === name); });
    if (!drawer.classList.contains("open")) lastFocus = document.activeElement;
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    $(".drawer-panel").scrollTop = 0;
    $(".drawer-panel").focus();
    history.replaceState(null, "", "#snapshot/" + encodeURIComponent(name));
  }
  function closeDrawer() {
    if (!drawer.classList.contains("open")) return;
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
    view.selected = null;
    $$("#snapRows tr.is-selected").forEach(function (tr) { tr.classList.remove("is-selected"); });
    history.replaceState(null, "", location.pathname + location.search);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function trapFocus(e) {
    var f = $$(".drawer-panel button, .drawer-panel [href], .drawer-panel [tabindex]:not([tabindex='-1'])");
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === $(".drawer-panel"))) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------------------ tooltip
  var tip = $("#tooltip");
  function showTip(s, x, y) {
    tip.innerHTML = '<div class="t1">' + esc(s.name) + '</div><div class="t2">' + esc(stateOf(s).label) + " · " + esc(KIND_LABEL[kindOf(s)] || s.kind || "") +
      " · " + esc(fmtTime(s.createdAt, true)) + "</div>" +
      (s.state === "verified" ? '<div class="t2">' + (s.artifacts || []).length + " 个制品 · " + (s.inputCompleteness === "partial" ? "部分采集" : "完整") + "</div>" : "") +
      (s.reasonCode ? '<div class="t2 code">' + esc(s.reasonCode) + "</div>" : "");
    tip.classList.add("show");
    var r = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - r.width - 8)) + "px";
    tip.style.top = (y + 16 + r.height > window.innerHeight ? y - r.height - 12 : y + 16) + "px";
  }
  function hideTip() { tip.classList.remove("show"); }
  function highlight(name) {
    $("#strip").classList.toggle("has-hl", !!name);
    $$("#strip .tick").forEach(function (g) { g.classList.toggle("hl", g.getAttribute("data-snap") === name); });
    $$("#snapRows tr").forEach(function (tr) { tr.classList.toggle("hl", tr.getAttribute("data-row") === name); });
  }

  // ------------------------------------------------------------------ render
  function renderAll() {
    renderMast();
    renderLead();
    renderStrip();
    renderSnapshots();
    renderCompare();
    renderDoctor();
    renderOps();
    renderNotes();
  }

  // ------------------------------------------------------------------ events
  document.addEventListener("click", function (e) {
    var t = e.target;
    var el;
    if ((el = t.closest("[data-copy]"))) { copyText(el.getAttribute("data-copy")); return; }
    if ((el = t.closest("[data-snap]"))) { hideTip(); openSnapshot(el.getAttribute("data-snap")); return; }
    if (t.closest("[data-close]")) { closeDrawer(); return; }
    if ((el = t.closest("[data-cmp]"))) { view.cmp = +el.getAttribute("data-cmp"); renderCompare(); return; }
    if ((el = t.closest("[data-jump]"))) {
      if (el.hasAttribute("data-cmp-go")) { view.cmp = +el.getAttribute("data-cmp-go"); renderCompare(); }
      var target = document.querySelector(el.getAttribute("data-jump"));
      if (target) { target.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }); }
      return;
    }
    if ((el = t.closest("[data-sort]"))) {
      var key = el.getAttribute("data-sort");
      if (view.sort === key) view.dir = view.dir === "asc" ? "desc" : "asc";
      else { view.sort = key; view.dir = key === "name" ? "asc" : "desc"; }
      renderSnapshots();
      return;
    }
    if ((el = t.closest("[data-state]"))) { view.state = el.getAttribute("data-state"); renderSnapshots(); }
  });
  document.addEventListener("change", function (e) {
    if (e.target.id === "onlyDiff") { view.onlyDiff = e.target.checked; drawCompare(data.compares[view.cmp]); }
    if (e.target.id === "kindFilter") { view.kind = e.target.value; renderSnapshots(); }
  });
  $("#search").addEventListener("input", function () { view.q = this.value; renderSnapshots(); });

  document.addEventListener("keydown", function (e) {
    if (drawer.classList.contains("open")) {
      if (e.key === "Escape") { e.preventDefault(); closeDrawer(); }
      else if (e.key === "Tab") trapFocus(e);
      return;
    }
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
    if (e.key === "/" && !typing) { e.preventDefault(); $("#search").focus(); }
    var tk = e.target.closest && e.target.closest("#strip .tick");
    if (tk && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openSnapshot(tk.getAttribute("data-snap")); }
  });

  function snapByName(n) { return snapshots().filter(function (s) { return s.name === n; })[0]; }
  $("#strip").addEventListener("mouseover", function (e) {
    var g = e.target.closest(".tick");
    if (!g) return;
    var s = snapByName(g.getAttribute("data-snap"));
    if (s) { showTip(s, e.clientX, e.clientY); highlight(s.name); }
  });
  $("#strip").addEventListener("mouseout", function (e) { if (e.target.closest(".tick")) { hideTip(); highlight(null); } });
  $("#strip").addEventListener("focusin", function (e) {
    var g = e.target.closest(".tick");
    if (!g) return;
    var s = snapByName(g.getAttribute("data-snap")), r = g.getBoundingClientRect();
    if (s) { showTip(s, r.left, r.bottom); highlight(s.name); }
  });
  $("#strip").addEventListener("focusout", function () { hideTip(); highlight(null); });
  $("#snapRows").addEventListener("mouseover", function (e) {
    var tr = e.target.closest("tr[data-row]");
    if (!tr) return;
    $("#strip").classList.add("has-hl");
    $$("#strip .tick").forEach(function (g) { g.classList.toggle("hl", g.getAttribute("data-snap") === tr.getAttribute("data-row")); });
  });
  $("#snapRows").addEventListener("mouseleave", function () { highlight(null); });

  // Theme: ?theme= override > saved choice > default warm paper light
  var THEME_KEY = "project-state-dashboard-theme";
  function applyTheme(t) {
    document.documentElement.setAttribute("data-theme", t);
    var b = $("#themeBtn");
    b.textContent = t === "dark" ? "浅色" : "深色";
    b.setAttribute("aria-pressed", String(t === "dark"));
  }
  (function initTheme() {
    var q = (location.search.match(/[?&]theme=(light|dark)/) || [])[1];
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (_) { saved = null; }
    applyTheme(q || saved || "light");
  })();
  $("#themeBtn").addEventListener("click", function () {
    var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* storage unavailable */ }
    renderStrip();
  });

  // Import
  function importText(text, name) {
    try {
      data = mergeInput(JSON.parse(text), data);
      view.cmp = 0; view.selected = null;
      closeDrawer();
      renderAll();
      toast("已导入：" + (name || "JSON"));
    } catch (err) {
      toast("导入失败：" + (err && err.message ? err.message : err));
    }
  }
  function readFile(file) {
    var reader = new FileReader();
    reader.onload = function () { importText(reader.result, file.name); };
    reader.readAsText(file);
  }
  $("#fileInput").addEventListener("change", function () {
    if (this.files && this.files[0]) readFile(this.files[0]);
    this.value = "";
  });
  $("#resetBtn").addEventListener("click", function () {
    data = DEFAULT_DATA; view.cmp = 0; closeDrawer(); renderAll(); toast("已恢复为内置数据");
  });
  var dragDepth = 0;
  window.addEventListener("dragenter", function (e) { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", function () { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", function (e) { e.preventDefault(); });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove("dragging");
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });

  // Current section in nav
  if ("IntersectionObserver" in window) {
    var links = $$("#nav a");
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.setAttribute("aria-current", String(a.getAttribute("href") === "#" + en.target.id)); });
      });
    }, { rootMargin: "-30% 0px -60% 0px" });
    $$("#summary, main .sec").forEach(function (s) { io.observe(s); });
  }

  var resizeTimer = null;
  window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderStrip, 120); });

  renderAll();

  // Deep link: #snapshot/<name> opens the detail panel.
  var deep = location.hash.match(/^#snapshot\/(.+)$/);
  if (deep) openSnapshot(decodeURIComponent(deep[1]));
})();
