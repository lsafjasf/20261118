(function () {
  "use strict";

  const TC = globalThis.TimecodeMath;
  const MAP = globalThis.MappingMath;
  const DEMO = globalThis.SyncDemo;
  const DOMAIN_ORDER = ["camera", "audio", "timeline"];
  const MAPPING_ORDER = [
    "camera->timeline",
    "audio->timeline",
    "camera->audio",
    "timeline->camera",
    "timeline->audio",
    "audio->camera"
  ];
  const MAPPING_CARDS = ["camera->timeline", "audio->timeline", "camera->audio"];
  const DOMAIN_NAMES = { camera: "摄像机", audio: "音频", timeline: "剪辑时间线" };
  const DOMAIN_CODES = { camera: "CAM", audio: "AUD", timeline: "TL" };
  const DOMAIN_COLORS = { camera: "var(--camera)", audio: "var(--audio)", timeline: "var(--timeline)" };

  const state = {
    domains: clone(DEMO.DEMO_DOMAINS),
    rows: clone(DEMO.DEMO_SYNC_POINTS),
    tolerance: 1,
    inspection: "camera->timeline",
    parsed: null,
    mappings: null,
    tableRows: [],
    tableConfig: null,
    nextRowId: 1,
    toastTimer: null,
    convertTimer: null
  };

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function signed(value, digits) {
    if (!Number.isFinite(value)) {
      return "—";
    }
    const places = digits == null ? 2 : digits;
    return `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(places)}`;
  }

  function frameLabel(value) {
    return `${signed(value, 2)} fr`;
  }

  function rateTitle(domain) {
    const normalized = TC.normalizeRate(domain.rate);
    return domain.dropFrame ? "DROP FRAME" : "NON-DROP";
  }

  function exactRateLabel(domain) {
    const normalized = TC.normalizeRate(domain.rate);
    if (normalized.ntsc) {
      return `${normalized.nominal * 1000}/1001 fps`;
    }
    return `${normalized.actual.toFixed(3)} fps`;
  }

  function optionList(keys, labels) {
    return keys.map((key) => `<option value="${key}">${escapeHtml(labels[key])}</option>`).join("");
  }

  function mappingLabel(key) {
    const [source, target] = key.split("->");
    return `${DOMAIN_NAMES[source]} → ${DOMAIN_NAMES[target]}`;
  }

  function renderRateGrid() {
    const grid = byId("rateGrid");
    grid.innerHTML = DOMAIN_ORDER.map((key, index) => {
      const domain = state.domains[key];
      const supportsDf = TC.supportsDropFrame(domain.rate);
      const actual = TC.normalizeRate(domain.rate);
      const frameCount = Math.round(actual.actual * 60 * 60);
      return `
        <article class="rate-card" data-domain="${key}" style="--domain-color: ${DOMAIN_COLORS[key]}">
          <div class="rate-card-header">
            <div class="domain-name"><span class="domain-dot"></span>${DOMAIN_NAMES[key]}</div>
            <span class="rate-index">${DOMAIN_CODES[key]} / 0${index + 1}</span>
          </div>
          <div class="rate-controls">
            <label class="rate-number">
              <input class="rate-input" data-domain="${key}" type="number" min="1" max="240" step="0.001"
                value="${escapeHtml(domain.rate)}" aria-label="${DOMAIN_NAMES[key]}帧率">
            </label>
            <label class="drop-toggle">
              <input class="drop-input" data-domain="${key}" type="checkbox" ${domain.dropFrame ? "checked" : ""} ${supportsDf ? "" : "disabled"}>
              DF
            </label>
          </div>
          <div class="rate-actual">
            <span>${exactRateLabel(domain)}</span>
            <strong>${frameCount.toLocaleString("en-US")} fr/h · ${rateTitle(domain)}</strong>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderSyncTable() {
    const body = byId("syncBody");
    body.innerHTML = state.rows.map((row, index) => `
      <tr data-row="${index}">
        <td>
          <span class="point-number" data-point-number="${index + 1}">SYNC ${String(index + 1).padStart(2, "0")}</span>
        </td>
        <td><input class="timecode-input" data-row="${index}" data-domain="camera" type="text"
          inputmode="numeric" spellcheck="false" aria-label="同步点 ${index + 1} 摄像机时间码"
          value="${escapeHtml(row.camera)}"></td>
        <td><input class="timecode-input" data-row="${index}" data-domain="audio" type="text"
          inputmode="numeric" spellcheck="false" aria-label="同步点 ${index + 1} 音频时间码"
          value="${escapeHtml(row.audio)}"></td>
        <td><input class="timecode-input" data-row="${index}" data-domain="timeline" type="text"
          inputmode="numeric" spellcheck="false" aria-label="同步点 ${index + 1} 剪辑时间线时间码"
          value="${escapeHtml(row.timeline)}"></td>
        <td>
          <button class="icon-button remove-row" type="button" data-row="${index}"
            aria-label="删除同步点 ${index + 1}" ${state.rows.length <= 1 ? "disabled" : ""}>×</button>
        </td>
      </tr>
    `).join("");
    updateValidation();
  }

  function updateValidation() {
    const errors = state.parsed ? state.parsed.rowErrors : {};
    document.querySelectorAll(".timecode-input").forEach((input) => {
      const key = `${state.rows[Number(input.dataset.row)].id}:${input.dataset.domain}`;
      input.setAttribute("aria-invalid", errors[key] ? "true" : "false");
      if (errors[key]) {
        input.title = errors[key];
      } else {
        input.removeAttribute("title");
      }
    });

    const errorBox = byId("syncError");
    const entries = Object.entries(errors);
    if (!entries.length) {
      errorBox.hidden = true;
      errorBox.textContent = "";
      return;
    }
    errorBox.hidden = false;
    errorBox.textContent = entries.slice(0, 3).map(([key, message]) => {
      const [rowId, domain] = key.split(":");
      const rowIndex = state.rows.findIndex((row) => row.id === rowId);
      return `同步点 #${rowIndex + 1} ${DOMAIN_NAMES[domain]}：${message}`;
    }).join(" · ");
  }

  function resetToRows(rows, domains) {
    state.domains = clone(domains);
    state.rows = clone(rows);
    state.inspection = "camera->timeline";
    renderRateGrid();
    renderSyncTable();
    byId("inspectionSelect").value = state.inspection;
    recompute();
  }

  function attachCoreEvents() {
    byId("rateGrid").addEventListener("input", (event) => {
      const rateInput = event.target.closest(".rate-input");
      if (!rateInput) {
        return;
      }
      const domainKey = rateInput.dataset.domain;
      const value = Number.parseFloat(rateInput.value);
      if (!Number.isFinite(value) || value <= 0) {
        return;
      }
      state.domains[domainKey].rate = value;
      const toggle = rateInput.closest(".rate-card").querySelector(".drop-input");
      const allowsDrop = TC.supportsDropFrame(value);
      toggle.disabled = !allowsDrop;
      if (!allowsDrop) {
        state.domains[domainKey].dropFrame = false;
        toggle.checked = false;
      }
      recompute();
    });

    byId("rateGrid").addEventListener("change", (event) => {
      const rateInput = event.target.closest(".rate-input");
      if (!rateInput) {
        return;
      }
      renderRateGrid();
      recompute();
    });

    byId("rateGrid").addEventListener("change", (event) => {
      const dropInput = event.target.closest(".drop-input");
      if (!dropInput) {
        return;
      }
      state.domains[dropInput.dataset.domain].dropFrame = dropInput.checked;
      recompute();
    });

    byId("syncBody").addEventListener("input", (event) => {
      const input = event.target.closest(".timecode-input");
      if (!input) {
        return;
      }
      state.rows[Number(input.dataset.row)][input.dataset.domain] = input.value;
      recompute();
    });

    byId("syncBody").addEventListener("click", (event) => {
      const remove = event.target.closest(".remove-row");
      if (!remove) {
        return;
      }
      state.rows.splice(Number(remove.dataset.row), 1);
      renderSyncTable();
      recompute();
    });

    byId("addPointButton").addEventListener("click", () => {
      state.rows.push({
        id: `manual-${Date.now()}-${state.nextRowId++}`,
        camera: "",
        audio: "",
        timeline: ""
      });
      renderSyncTable();
      recompute();
      const inputs = document.querySelectorAll(`#syncBody tr[data-row="${state.rows.length - 1}"] input`);
      if (inputs.length) {
        inputs[0].focus();
        inputs[0].select();
      }
    });

    byId("loadDemoButton").addEventListener("click", () => {
      resetToRows(DEMO.DEMO_SYNC_POINTS, DEMO.DEMO_DOMAINS);
      byId("tableStart").value = DEMO.DEMO_TABLE.startTimecode;
      byId("tableEnd").value = DEMO.DEMO_TABLE.endTimecode;
      byId("tableStep").value = DEMO.DEMO_TABLE.stepSeconds;
      byId("tableSource").value = DEMO.DEMO_TABLE.sourceKey;
      generateTable(false);
      showToast("已载入跨整点 29.97 DF 三点样片");
    });

    byId("loadConflictButton").addEventListener("click", () => {
      resetToRows(DEMO.CONFLICT_SYNC_POINTS, DEMO.DEMO_DOMAINS);
      showToast("已载入冲突样例，请查看同步点审计", true);
    });

    byId("toleranceInput").addEventListener("input", () => {
      const value = Number.parseFloat(byId("toleranceInput").value);
      state.tolerance = Number.isFinite(value) && value >= 0 ? value : MAP.DEFAULT_TOLERANCE_FRAMES;
      recompute();
    });

    byId("inspectionSelect").addEventListener("change", () => {
      state.inspection = byId("inspectionSelect").value;
      renderAnalysis();
    });
  }

  function renderHero() {
    const validCount = state.parsed ? state.parsed.points.length : 0;
    const mappings = state.mappings ? Object.values(state.mappings) : [];
    const comparable = mappings.filter((mapping) => Number.isFinite(mapping.driftPpm));
    const maxDrift = comparable.length
      ? comparable.reduce((max, mapping) => Math.max(max, Math.abs(mapping.driftPpm)), 0)
      : null;
    const hasParseError = state.parsed && state.parsed.hasError;
    const hasConflict = mappings.some((mapping) => mapping.conflict);
    let statusText = "待补同步点";
    let statusClass = "status-neutral";
    let metricText = "数据不足";

    if (validCount >= 2 && hasConflict) {
      statusText = "映射冲突";
      statusClass = "status-conflict";
      metricText = "发现冲突";
    } else if (validCount >= 2 && hasParseError) {
      statusText = "含无效时间码";
      statusClass = "status-neutral";
      metricText = "部分无效";
    } else if (validCount >= 2) {
      statusText = "映射一致";
      statusClass = "status-ok";
      metricText = "全部一致";
    }

    const status = byId("globalStatus");
    status.textContent = statusText;
    status.className = `status-pill ${statusClass}`;
    byId("metricPoints").textContent = String(validCount).padStart(2, "0");
    byId("metricDrift").textContent = maxDrift == null ? "—" : maxDrift.toFixed(1);
    const metricStatus = byId("metricStatus");
    metricStatus.textContent = metricText;
    metricStatus.style.color = hasConflict ? "var(--danger)" : (validCount >= 2 ? "var(--accent)" : "var(--text)");
    byId("metricTolerance").textContent = `容差 ${state.tolerance.toFixed(2)} 帧`;

    const selected = state.mappings ? state.mappings[state.inspection] : null;
    byId("footerFormula").textContent = selected && selected.equation
      ? selected.equation
      : "T(TL) = a × T(CAM) + b";
  }

  function renderMappingCards() {
    const container = byId("mappingCards");
    container.innerHTML = MAPPING_CARDS.map((key) => {
      const mapping = state.mappings ? state.mappings[key] : null;
      const [source, target] = key.split("->");
      if (!mapping || mapping.status === "insufficient" || !Number.isFinite(mapping.slope)) {
        return `
          <article class="mapping-card">
            <div class="mapping-route"><strong>${DOMAIN_NAMES[source]} → ${DOMAIN_NAMES[target]}</strong>${DOMAIN_CODES[source]} / ${DOMAIN_CODES[target]}</div>
            <div class="empty-state">需要至少两个有效同步点</div>
            <div class="mapping-health"><span class="health-dot">待计算</span></div>
          </article>
        `;
      }

      const driftClass = mapping.driftPpm >= 0 ? "positive" : "negative";
      const bad = mapping.conflict;
      return `
        <article class="mapping-card">
          <div class="mapping-route">
            <strong>${DOMAIN_NAMES[source]} → ${DOMAIN_NAMES[target]}</strong>
            ${DOMAIN_CODES[source]} / ${DOMAIN_CODES[target]} · ${mapping.sampleCount} POINTS
            <div class="mapping-equation">${escapeHtml(mapping.equation)}</div>
          </div>
          <div class="mapping-values">
            <div class="mapping-value">
              <span>漂移率</span>
              <strong class="${driftClass}">${signed(mapping.driftPpm, 2)} ppm</strong>
            </div>
            <div class="mapping-value">
              <span>零时偏移</span>
              <strong>${escapeHtml(mapping.offsetTimecode)}</strong>
            </div>
          </div>
          <div class="mapping-health">
            <span class="health-dot ${bad ? "is-bad" : ""}">${bad ? "冲突" : "一致"}</span>
            <span class="health-error">RMS ${mapping.rmsFrames.toFixed(2)} fr<br>MAX ${mapping.maxErrorFrames.toFixed(2)} fr</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function updateConflictMarkers(mapping) {
    const conflictPoints = mapping ? mapping.conflictPair || [] : [];
    document.querySelectorAll("[data-point-number]").forEach((element) => {
      const pointNumber = Number(element.dataset.pointNumber);
      element.classList.toggle("is-conflict", conflictPoints.includes(pointNumber));
    });
  }

  function residualRows(mapping) {
    if (!mapping || !mapping.residuals.length) {
      return "";
    }
    const maxError = Math.max(0.0001, ...mapping.residuals.map((item) => Math.abs(item.errorFrames)));
    return `
      <div class="residual-list">
        ${mapping.residuals.map((item) => {
          const bad = Math.abs(item.errorFrames) > state.tolerance;
          const width = Math.max(3, Math.min(100, (Math.abs(item.errorFrames) / maxError) * 100));
          return `
            <div class="residual-row ${bad ? "is-bad" : ""}" title="输入 ${escapeHtml(item.actualTimecode)} / 拟合 ${escapeHtml(item.predictedTimecode)}">
              <span class="point-name">SYNC ${String(item.pointNumber).padStart(2, "0")}</span>
              <span class="residual-bar" style="--bar-width:${width.toFixed(1)}%"><i></i></span>
              <span class="residual-value">${frameLabel(item.errorFrames)}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
  }

  function pairAuditRows(mapping) {
    if (!mapping || !mapping.pairAudits.length) {
      return "";
    }
    const shown = mapping.conflict
      ? mapping.pairAudits.slice(0, 4)
      : mapping.pairAudits.slice(0, 3);
    return `
      <p class="pair-audit-label">PAIRWISE LEAVE-ONE-OUT CHECK</p>
      ${shown.map((audit) => `
        <div class="pair-audit-line ${audit.conflict ? "is-bad" : ""}">
          <strong>#${audit.pairNumbers[0]} + #${audit.pairNumbers[1]}</strong>
          → #${audit.atPointNumber == null ? "—" : audit.atPointNumber}
          ${audit.atPointNumber == null ? "直接确定" : `${frameLabel(audit.signedErrorFrames)}`}
        </div>
      `).join("")}
    `;
  }

  function renderConflict() {
    const container = byId("conflictContent");
    const mapping = state.mappings ? state.mappings[state.inspection] : null;
    if (!mapping || mapping.status === "insufficient") {
      container.innerHTML = `
        <div class="audit-summary">
          <span class="audit-kicker">WAITING FOR DATA</span>
          <h3>至少需要两个同步点</h3>
          <p>补齐摄像机和音频时间码后，系统会检查它们能否被同一条线性漂移映射同时满足。</p>
        </div>
      `;
      updateConflictMarkers(null);
      return;
    }

    const bad = mapping.conflict;
    const title = bad
      ? `同步点 #${mapping.conflictPair[0]} 与 #${mapping.conflictPair[1]} 无法同时满足`
      : `${mapping.sampleCount} 个同步点一致`;
    const detail = bad
      ? `${mapping.sourceLabel} → ${mapping.targetLabel} 的残差超过 ${state.tolerance.toFixed(2)} 帧。下方列出输入位置与拟合位置之间的偏差。`
      : `最大残差 ${mapping.maxErrorFrames.toFixed(2)} 帧，漂移率 ${signed(mapping.driftPpm, 2)} ppm。`;
    container.innerHTML = `
      <div class="audit-summary ${bad ? "is-bad" : ""}">
        <span class="audit-kicker">${bad ? "MAPPING CONFLICT" : "MAPPING CONSISTENT"}</span>
        <h3>${escapeHtml(title)}</h3>
        <p>${escapeHtml(detail)}</p>
      </div>
      ${residualRows(mapping)}
      ${pairAuditRows(mapping)}
    `;
    updateConflictMarkers(mapping);
  }

  function renderAnalysis() {
    renderHero();
    renderMappingCards();
    renderConflict();
  }

  function recompute() {
    state.parsed = MAP.parseSyncRows(state.rows, state.domains);
    if (state.parsed.points.length >= 2) {
      state.mappings = MAP.analyzeAllMappings(
        state.parsed.points,
        state.domains,
        state.tolerance
      );
    } else {
      state.mappings = null;
    }
    updateValidation();
    renderAnalysis();
    renderConversion();
    generateTable(false);
  }

  function renderConversion() {
    const sourceKey = byId("convertSource").value || "timeline";
    const input = byId("convertTimecode");
    const errorBox = byId("convertError");
    const resultsBox = byId("convertResults");

    if (!state.mappings) {
      input.setAttribute("aria-invalid", "false");
      errorBox.hidden = true;
      resultsBox.innerHTML = `<div class="empty-state">补齐至少两个有效同步点后即可换算。</div>`;
      return;
    }

    let results;
    try {
      results = MAP.convertToAll(input.value, sourceKey, state.domains, state.mappings);
      input.setAttribute("aria-invalid", "false");
      errorBox.hidden = true;
    } catch (error) {
      input.setAttribute("aria-invalid", "true");
      errorBox.hidden = false;
      errorBox.textContent = `时间码无法换算：${error.message}`;
      resultsBox.innerHTML = "";
      return;
    }

    resultsBox.innerHTML = DOMAIN_ORDER.map((key) => {
      const result = results[key];
      const isSource = key === sourceKey;
      const domain = state.domains[key];
      return `
        <article class="convert-card ${isSource ? "is-source" : ""}" data-domain="${key}">
          <div class="convert-card-header">
            <span>${DOMAIN_NAMES[key]} · ${DOMAIN_CODES[key]}</span>
            <span>${rateTitle(domain)}</span>
          </div>
          <strong>${escapeHtml(result ? result.targetTimecode : "—")}</strong>
          <div class="convert-card-footer">
            <span>${result ? `FRAME ${result.targetFrames.toLocaleString("en-US")}` : "NO MAPPING"}</span>
            <span>${result && Number.isFinite(result.targetSeconds) ? `${result.targetSeconds.toFixed(3)} s` : "—"}</span>
          </div>
          <div class="convert-card-footer">
            <span>${isSource ? "SOURCE CLOCK" : `Δ ${signed(result.offsetMilliseconds, 1)} ms`}</span>
            <span>${exactRateLabel(domain)}</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderTablePreview() {
    const body = byId("tablePreviewBody");
    if (!state.tableRows.length) {
      body.innerHTML = `<tr><td colspan="7"><div class="empty-state">尚无换算数据</div></td></tr>`;
      return;
    }
    body.innerHTML = state.tableRows.map((row) => {
      const camera = row.domains.camera;
      const audio = row.domains.audio;
      const timeline = row.domains.timeline;
      return `
        <tr>
          <td>${String(row.index).padStart(2, "0")}</td>
          <td>${escapeHtml(camera ? camera.timecode : "—")}</td>
          <td>${escapeHtml(audio ? audio.timecode : "—")}</td>
          <td>${escapeHtml(timeline ? timeline.timecode : "—")}</td>
          <td>${camera && Number.isFinite(camera.seconds) ? camera.seconds.toFixed(3) : "—"}</td>
          <td>${audio && Number.isFinite(audio.seconds) ? audio.seconds.toFixed(3) : "—"}</td>
          <td>${timeline && Number.isFinite(timeline.seconds) ? timeline.seconds.toFixed(3) : "—"}</td>
        </tr>
      `;
    }).join("");
  }

  function generateTable(showToastMessage) {
    const errorBox = byId("tableError");
    const meta = byId("tableMeta");
    const sourceKey = byId("tableSource").value || "timeline";
    const startTimecode = byId("tableStart").value;
    const endTimecode = byId("tableEnd").value;
    const stepSeconds = Number.parseFloat(byId("tableStep").value);

    if (!state.mappings) {
      state.tableRows = [];
      renderTablePreview();
      meta.textContent = "";
      errorBox.hidden = false;
      errorBox.textContent = "需要至少两个有效同步点才能生成换算表。";
      return false;
    }
    if (!Number.isFinite(stepSeconds) || stepSeconds <= 0) {
      errorBox.hidden = false;
      errorBox.textContent = "步长必须是大于 0 的秒数。";
      return false;
    }

    try {
      state.tableRows = MAP.buildConversionTable({
        sourceKey,
        startTimecode,
        endTimecode,
        stepSeconds,
        domains: state.domains,
        mappings: state.mappings
      });
      state.tableConfig = {
        sourceKey,
        startTimecode,
        endTimecode,
        stepSeconds
      };
      errorBox.hidden = true;
      renderTablePreview();
      const domainSummary = DOMAIN_ORDER
        .map((key) => `${DOMAIN_CODES[key]} ${TC.describeRate(state.domains[key].rate)} ${state.domains[key].dropFrame ? "DF" : "NDF"}`)
        .join(" · ");
      meta.textContent = `${state.tableRows.length} 行 · 基准 ${DOMAIN_NAMES[sourceKey]} · ${stepSeconds} 秒步长 · ${domainSummary}`;
      if (showToastMessage) {
        showToast(`已生成 ${state.tableRows.length} 行换算表`);
      }
      return true;
    } catch (error) {
      state.tableRows = [];
      renderTablePreview();
      meta.textContent = "";
      errorBox.hidden = false;
      errorBox.textContent = error.message;
      return false;
    }
  }

  function downloadTable() {
    if (!generateTable(false)) {
      showToast("换算表参数无效，暂不能导出", true);
      return;
    }
    const config = state.tableConfig;
    const rates = {};
    const ratesCn = {};
    DOMAIN_ORDER.forEach((key) => {
      rates[key] = `${TC.describeRate(state.domains[key].rate)} ${state.domains[key].dropFrame ? "DF" : "NDF"}`;
      ratesCn[key] = rates[key];
    });
    const selected = state.mappings[state.inspection];
    const csv = MAP.conversionTableToCsv(state.tableRows, {
      title: "SYNC / TC 多域时间码换算表",
      rates: ratesCn,
      sourceKey: config.sourceKey,
      notes: [
        `实际帧率：29.97 = 30000/1001，59.94 = 60000/1001；DF 仅跳过标签，不丢实际帧。`,
        selected ? `${selected.sourceLabel} → ${selected.targetLabel}：${selected.equation}；漂移 ${signed(selected.driftPpm, 3)} ppm` : "",
        `冲突容差：${state.tolerance.toFixed(2)} 帧`
      ]
    });
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `sync-tc-${config.sourceKey}-${stamp}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast(`已导出 ${state.tableRows.length} 行 CSV`);
  }

  function showToast(message, isError) {
    const toast = byId("toast");
    toast.textContent = message;
    toast.className = `toast is-visible ${isError ? "is-error" : ""}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      toast.className = "toast";
    }, 2800);
  }

  function populateSelects() {
    byId("inspectionSelect").innerHTML = MAPPING_ORDER
      .map((key) => `<option value="${key}">${escapeHtml(mappingLabel(key))}</option>`)
      .join("");
    byId("inspectionSelect").value = state.inspection;

    const domainOptions = optionList(DOMAIN_ORDER, DOMAIN_NAMES);
    byId("convertSource").innerHTML = domainOptions;
    byId("tableSource").innerHTML = domainOptions;
    byId("convertSource").value = "timeline";
    byId("tableSource").value = DEMO.DEMO_TABLE.sourceKey;
    byId("tableStart").value = DEMO.DEMO_TABLE.startTimecode;
    byId("tableEnd").value = DEMO.DEMO_TABLE.endTimecode;
    byId("tableStep").value = DEMO.DEMO_TABLE.stepSeconds;
  }

  function attachOutputEvents() {
    byId("convertSource").addEventListener("change", renderConversion);
    byId("convertButton").addEventListener("click", renderConversion);
    byId("convertTimecode").addEventListener("input", () => {
      clearTimeout(state.convertTimer);
      state.convertTimer = setTimeout(renderConversion, 180);
    });
    byId("convertTimecode").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        renderConversion();
      }
    });

    byId("generateTableButton").addEventListener("click", () => generateTable(true));
    byId("exportButton").addEventListener("click", downloadTable);
    byId("exportTopButton").addEventListener("click", downloadTable);
    ["tableSource", "tableStart", "tableEnd", "tableStep"].forEach((id) => {
      byId(id).addEventListener("input", () => generateTable(false));
      byId(id).addEventListener("change", () => generateTable(false));
    });
  }

  function init() {
    populateSelects();
    renderRateGrid();
    renderSyncTable();
    attachCoreEvents();
    attachOutputEvents();
    recompute();
  }

  init();
})();
