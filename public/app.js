/* Dewu dual-shop search — plain script (no module) */
(function () {
  const JWT_KEY = 'dewu_jwt'

  function getJwt() {
    return localStorage.getItem(JWT_KEY) || ''
  }

  function clearAuthAndRedirect() {
    try {localStorage.removeItem(JWT_KEY)} catch (_) { /* ignore */}
    location.replace('/login.html')
  }

  function authHeaders(extra) {
    const headers = {...(extra || {})}
    const token = getJwt()
    if (token) headers.Authorization = `Bearer ${token}`
    return headers
  }

  async function apiFetch(url, options) {
    const opts = {...(options || {})}
    const baseHeaders = opts.body instanceof FormData
      ? {}
      : {'Content-Type': 'application/json'}
    opts.headers = authHeaders({...baseHeaders, ...(opts.headers || {})})
    if (opts.body instanceof FormData) {
      delete opts.headers['Content-Type']
    }
    const res = await fetch(url, opts)
    if (res.status === 401) {
      clearAuthAndRedirect()
      throw new Error('登录已失效，请重新登录')
    }
    return res
  }

  if (!getJwt()) {
    clearAuthAndRedirect()
    return
  }

  const $ = (id) => document.getElementById(id)
  const els = {
    startDate: $('startDate'),
    endDate: $('endDate'),
    spuid: $('spuid'),
    sku: $('sku'),
    shop: $('shop'),
    searchBtn: $('searchBtn'),
    resetBtn: $('resetBtn'),
    categoryTrigger: $('categoryTrigger'),
    categoryPanel: $('categoryPanel'),
    categoryTree: $('categoryTree'),
    categoryLabel: $('categoryLabel'),
    categorySearch: $('categorySearch'),
    categoryEmpty: $('categoryEmpty'),
    catSelectAll: $('catSelectAll'),
    catClear: $('catClear'),
    categoryPresetList: $('categoryPresetList'),
    categoryPresetEmpty: $('categoryPresetEmpty'),
    categoryPresetSaveBtn: $('categoryPresetSaveBtn'),
    categoryPresetMenu: $('categoryPresetMenu'),
    categoryPresetModal: $('categoryPresetModal'),
    categoryPresetModalTitle: $('categoryPresetModalTitle'),
    categoryPresetModalHint: $('categoryPresetModalHint'),
    categoryPresetNameInput: $('categoryPresetNameInput'),
    categoryPresetModalConfirm: $('categoryPresetModalConfirm'),
    metaHint: $('metaHint'),
    commitId: $('commitId'),
    board: $('board'),
    metrics: $('metrics'),
    resultMeta: $('resultMeta'),
    tableSection: $('tableSection'),
    tableBody: $('tableBody'),
    emptyState: $('emptyState'),
    toast: $('toast'),
    inlineProgress: $('inlineProgress'),
    progressFill: $('progressFill'),
    progressMeta: $('progressMeta'),
    serverStatus: $('serverStatus'),
    exportBoardBtn: $('exportBoardBtn'),
    exportDetailBtn: $('exportDetailBtn'),
    openUploadBtn: $('openUploadBtn'),
    closeUploadBtn: $('closeUploadBtn'),
    uploadModal: $('uploadModal'),
    uploadToken: $('uploadToken'),
    uploadFiles: $('uploadFiles'),
    uploadPickBtn: $('uploadPickBtn'),
    uploadFileMeta: $('uploadFileMeta'),
    uploadBtn: $('uploadBtn'),
    uploadList: $('uploadList'),
    openPromoUploadBtn: $('openPromoUploadBtn'),
    closePromoUploadBtn: $('closePromoUploadBtn'),
    promoUploadModal: $('promoUploadModal'),
    promoUploadToken: $('promoUploadToken'),
    promoUploadFiles: $('promoUploadFiles'),
    promoUploadPickBtn: $('promoUploadPickBtn'),
    promoUploadFileMeta: $('promoUploadFileMeta'),
    promoUploadBtn: $('promoUploadBtn'),
    promoUploadList: $('promoUploadList'),
    periodHint: $('periodHint'),
    compareLegend: $('compareLegend'),
    presetDay: $('presetDay'),
    presetWeek: $('presetWeek'),
    presetMonth: $('presetMonth'),
  }

  let meta = null
  let selectedCategories = new Set()
  let categoryTree = []
  /** @type {any[]} */
  let filteredCategoryTree = []
  let lastSummary = null
  let lastCompare = null
  let lastResultMeta = null
  let lastRows = []
  let sortKey = 'payAmount'
  let sortDir = 'desc'
  let categoryFetchToken = 0
  let toastTimer = 0
  let progressTimer = 0
  let searching = false
  let categoryKeyword = ''
  /** @type {{ file: File, name: string, ok: boolean, msg: string }[]} */
  let pendingUploads = []
  let uploading = false
  let deploying = false
  /** @type {{ file: File, name: string, ok: boolean, msg: string, start?: string, end?: string }[]} */
  let pendingPromoUploads = []
  let promoUploading = false
  /** @type {string|null} */
  let activeCategoryPresetId = null
  /** @type {'save'|'rename'|null} */
  let categoryPresetModalMode = null
  /** @type {string|null} */
  let categoryPresetContextId = null
  const CATEGORY_PRESET_KEY = 'dewu_category_presets_v1'

  function readCategoryPresets() {
    try {
      const raw = localStorage.getItem(CATEGORY_PRESET_KEY)
      if (!raw) return []
      const list = JSON.parse(raw)
      if (!Array.isArray(list)) return []
      return list
        .filter((p) => p && typeof p.name === 'string' && Array.isArray(p.categories))
        .map((p) => ({
          id: String(p.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
          name: String(p.name).trim(),
          categories: p.categories.map((c) => String(c)),
          updatedAt: Number(p.updatedAt) || Date.now(),
        }))
        .filter((p) => p.name)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  function writeCategoryPresets(list) {
    try {
      localStorage.setItem(CATEGORY_PRESET_KEY, JSON.stringify(list))
    } catch (err) {
      showToast('无法写入本机配置（浏览器存储可能已满）')
      console.warn(err)
    }
  }

  function hideCategoryPresetMenu() {
    if (!els.categoryPresetMenu) return
    els.categoryPresetMenu.hidden = true
    categoryPresetContextId = null
  }

  function showCategoryPresetMenu(id, clientX, clientY) {
    if (!els.categoryPresetMenu) return
    categoryPresetContextId = id
    const menu = els.categoryPresetMenu
    menu.hidden = false
    const pad = 8
    const mw = menu.offsetWidth
    const mh = menu.offsetHeight
    let left = clientX
    let top = clientY
    if (left + mw > window.innerWidth - pad) left = window.innerWidth - mw - pad
    if (top + mh > window.innerHeight - pad) top = window.innerHeight - mh - pad
    if (left < pad) left = pad
    if (top < pad) top = pad
    menu.style.left = `${left}px`
    menu.style.top = `${top}px`
  }

  function renderCategoryPresets() {
    if (!els.categoryPresetList) return
    const presets = readCategoryPresets()
    if (els.categoryPresetEmpty) {
      els.categoryPresetEmpty.hidden = presets.length > 0
    }
    const frag = document.createDocumentFragment()
    presets.forEach((preset) => {
      const tag = document.createElement('button')
      tag.type = 'button'
      tag.className = 'cat-preset-tag' + (preset.id === activeCategoryPresetId ? ' is-active' : '')
      const count = preset.categories.length
      tag.textContent = count ? `${preset.name}（${count}）` : `${preset.name}（全部）`
      tag.title = (count ? preset.categories.join('、') : '全部类目') + ' · 右键可重命名/删除'
      tag.addEventListener('click', () => {
        hideCategoryPresetMenu()
        applyCategoryPreset(preset.id)
      })
      tag.addEventListener('contextmenu', (e) => {
        e.preventDefault()
        e.stopPropagation()
        showCategoryPresetMenu(preset.id, e.clientX, e.clientY)
      })
      frag.appendChild(tag)
    })
    els.categoryPresetList.replaceChildren(frag)
  }

  function applyCategoryPreset(id) {
    const preset = readCategoryPresets().find((p) => p.id === id)
    if (!preset) {
      showToast('配置不存在或已删除')
      renderCategoryPresets()
      return
    }
    const leaves = new Set(collectLeafValues(categoryTree))
    if (!preset.categories.length) {
      selectedCategories.clear()
    } else {
      selectedCategories = new Set(preset.categories.filter((v) => leaves.has(v)))
      if (!selectedCategories.size && preset.categories.length) {
        showToast('该配置中的类目已失效，请重新勾选后保存')
      }
    }
    activeCategoryPresetId = preset.id
    refreshCategoryView()
    renderCategoryPresets()
    showToast(`已应用「${preset.name}」`)
  }

  function deleteCategoryPreset(id) {
    const presets = readCategoryPresets()
    const target = presets.find((p) => p.id === id)
    if (!target) return
    if (!window.confirm(`确定删除类目配置「${target.name}」？`)) return
    const next = presets.filter((p) => p.id !== id)
    writeCategoryPresets(next)
    if (activeCategoryPresetId === id) activeCategoryPresetId = null
    renderCategoryPresets()
    showToast(`已删除「${target.name}」`)
  }

  function openCategoryPresetModal(mode, presetId) {
    if (!els.categoryPresetModal) return
    categoryPresetModalMode = mode
    categoryPresetContextId = mode === 'rename' ? presetId : null
    const isRename = mode === 'rename'
    if (els.categoryPresetModalTitle) {
      els.categoryPresetModalTitle.textContent = isRename ? '重命名类目配置' : '保存类目配置'
    }
    if (els.categoryPresetModalHint) {
      els.categoryPresetModalHint.textContent = isRename
        ? '修改本机已保存配置的名称'
        : '将当前勾选的类目保存到本机浏览器'
    }
    let initial = ''
    if (isRename) {
      const preset = readCategoryPresets().find((p) => p.id === presetId)
      if (!preset) {
        showToast('配置不存在或已删除')
        return
      }
      initial = preset.name
    }
    if (els.categoryPresetNameInput) {
      els.categoryPresetNameInput.value = initial
    }
    els.categoryPresetModal.hidden = false
    document.body.classList.add('modal-open')
    window.setTimeout(() => {
      els.categoryPresetNameInput?.focus()
      els.categoryPresetNameInput?.select()
    }, 0)
  }

  function closeCategoryPresetModal() {
    if (!els.categoryPresetModal) return
    els.categoryPresetModal.hidden = true
    categoryPresetModalMode = null
    if (
      (!els.uploadModal || els.uploadModal.hidden) &&
      (!els.promoUploadModal || els.promoUploadModal.hidden)
    ) {
      document.body.classList.remove('modal-open')
    }
  }

  function confirmCategoryPresetModal() {
    const name = String(els.categoryPresetNameInput?.value || '').trim()
    if (!name) {
      showToast('请填写配置名称')
      els.categoryPresetNameInput?.focus()
      return
    }
    if (categoryPresetModalMode === 'rename') {
      renameCategoryPreset(categoryPresetContextId, name)
      return
    }
    saveCategoryPresetWithName(name)
  }

  function renameCategoryPreset(id, name) {
    const presets = readCategoryPresets()
    const target = presets.find((p) => p.id === id)
    if (!target) {
      showToast('配置不存在或已删除')
      closeCategoryPresetModal()
      renderCategoryPresets()
      return
    }
    const clash = presets.find((p) => p.id !== id && p.name === name)
    if (clash) {
      showToast(`已存在同名配置「${name}」`)
      els.categoryPresetNameInput?.focus()
      return
    }
    target.name = name
    target.updatedAt = Date.now()
    writeCategoryPresets(presets)
    closeCategoryPresetModal()
    renderCategoryPresets()
    showToast(`已重命名为「${name}」`)
  }

  function saveCategoryPresetWithName(name) {
    const categories = Array.from(selectedCategories)
    const presets = readCategoryPresets()
    const existed = presets.find((p) => p.name === name)
    if (existed) {
      if (!window.confirm(`已存在配置「${name}」，是否覆盖其类目？`)) return
      existed.categories = categories
      existed.updatedAt = Date.now()
      activeCategoryPresetId = existed.id
      writeCategoryPresets(presets)
      closeCategoryPresetModal()
      renderCategoryPresets()
      showToast(`已更新配置「${name}」`)
      return
    }
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      categories,
      updatedAt: Date.now(),
    }
    presets.unshift(item)
    activeCategoryPresetId = item.id
    writeCategoryPresets(presets)
    closeCategoryPresetModal()
    renderCategoryPresets()
    showToast(`已保存配置「${name}」`)
  }

  function pad2(n) {
    return String(n).padStart(2, '0')
  }

  function ymdToInput(ymd) {
    if (!ymd || ymd.length !== 8) return ''
    return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
  }

  function inputToYmd(value) {
    return value ? String(value).replaceAll('-', '') : ''
  }

  function formatNumber(n) {
    if (n == null || Number.isNaN(n)) return '0'
    const num = Number(n)
    // 不使用千分位逗号，保留最多两位小数并去掉末尾无意义的 0
    return String(parseFloat(num.toFixed(2)))
  }

  function ymdToDate(ymd) {
    return new Date(Number(ymd.slice(0, 4)), Number(ymd.slice(4, 6)) - 1, Number(ymd.slice(6, 8)))
  }

  function dateToYmd(dt) {
    const y = dt.getFullYear()
    const m = String(dt.getMonth() + 1).padStart(2, '0')
    const d = String(dt.getDate()).padStart(2, '0')
    return `${y}${m}${d}`
  }

  function detectPeriodType(startYmd, endYmd) {
    if (!startYmd || !endYmd) return null
    if (startYmd === endYmd) return 'day'
    const s = ymdToDate(startYmd)
    const e = ymdToDate(endYmd)
    const diff = Math.round((e - s) / 86400000)
    if (diff === 6 && s.getDay() === 1 && e.getDay() === 0) return 'week'
    const last = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate()
    if (
      s.getDate() === 1
      && e.getDate() === last
      && s.getFullYear() === e.getFullYear()
      && s.getMonth() === e.getMonth()
    ) return 'month'
    return null
  }

  function updatePeriodHint() {
    const start = inputToYmd(els.startDate.value)
    const end = inputToYmd(els.endDate.value)
    const type = detectPeriodType(start, end)
    const labels = {day: '单日', week: '整周', month: '整月'}
    if (els.presetDay) els.presetDay.classList.toggle('is-active', type === 'day')
    if (els.presetWeek) els.presetWeek.classList.toggle('is-active', type === 'week')
    if (els.presetMonth) els.presetMonth.classList.toggle('is-active', type === 'month')
    if (!els.periodHint) return
    if (type) {
      els.periodHint.textContent = `当前为${labels[type]}搜索，汇总看板将展示环比（上一周期）与同比（去年同期）`
      els.periodHint.classList.add('is-match')
    } else {
      els.periodHint.textContent = '单日 / 整周（周一至周日）/ 整月 时，汇总看板会显示环比与同比'
      els.periodHint.classList.remove('is-match')
    }
  }

  function calcChangeRate(current, previous) {
    if (previous == null || Number.isNaN(previous)) return null
    if (previous === 0) return current === 0 ? 0 : null
    return ((Number(current) - Number(previous)) / Math.abs(Number(previous))) * 100
  }

  function formatRate(rate) {
    if (rate == null || Number.isNaN(rate)) return {text: '—', cls: 'cmp-na'}
    const rounded = Math.round(rate * 10) / 10
    if (rounded === 0) return {text: '0%', cls: 'cmp-flat'}
    const sign = rounded > 0 ? '+' : ''
    return {
      text: `${sign}${parseFloat(rounded.toFixed(1))}%`,
      cls: rounded > 0 ? 'cmp-up' : 'cmp-down',
    }
  }

  function pickCompareValue(summary, metricKey, laneKind) {
    if (!summary || !summary[metricKey]) return null
    if (laneKind === 'sum') return summary[metricKey]['总和']
    if (laneKind === 'big') return summary[metricKey]['大店']
    if (laneKind === 'small') return summary[metricKey]['小店']
    return null
  }

  function buildCompareRow(metricKey, laneKind, currentValue) {
    if (!lastCompare || !lastCompare.type) return null
    const yoyVal = pickCompareValue(lastCompare.yoy && lastCompare.yoy.summary, metricKey, laneKind)
    const popVal = pickCompareValue(lastCompare.pop && lastCompare.pop.summary, metricKey, laneKind)
    const yoy = formatRate(calcChangeRate(currentValue, yoyVal))
    const pop = formatRate(calcChangeRate(currentValue, popVal))
    const wrap = document.createElement('div')
    wrap.className = 'lane-compare'
    wrap.innerHTML = `
      <span class="cmp ${pop.cls}" title="环比：对比上一周期">环比 ${pop.text}</span>
      <span class="cmp ${yoy.cls}" title="同比：对比去年同期">同比 ${yoy.text}</span>
    `
    return wrap
  }

  function showToast(message) {
    if (!els.toast) return
    els.toast.hidden = false
    els.toast.textContent = message
    window.clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => {
      els.toast.hidden = true
    }, 2200)
  }

  function setProgress(percent, detail) {
    const p = Math.max(0, Math.min(100, Math.round(percent)))
    if (els.progressFill) els.progressFill.style.width = `${p}%`
    if (els.progressMeta) {
      els.progressMeta.textContent = detail ? `${p}% · ${detail}` : `${p}%`
    }
  }

  function startProgress(label) {
    if (els.inlineProgress) els.inlineProgress.hidden = false
    setProgress(2, label || '开始检索')
    window.clearInterval(progressTimer)
    let fake = 2
    progressTimer = window.setInterval(() => {
      // 假进度：在真实结果返回前缓慢爬到 88%
      if (fake < 88) {
        fake += Math.max(0.4, (88 - fake) * 0.04)
        setProgress(fake, label || '正在读取本地表格…')
      }
    }, 200)
  }

  function stopProgress(success) {
    window.clearInterval(progressTimer)
    progressTimer = 0
    setProgress(success ? 100 : 0, success ? '完成' : '失败')
    window.setTimeout(() => {
      if (els.inlineProgress) els.inlineProgress.hidden = true
      setProgress(0, '')
    }, success ? 400 : 1600)
  }

  function renderMetricCard(title, lanes, options = {}) {
    const card = document.createElement('article')
    card.className = 'metric-card' + (options.merged ? ' is-merged' : '')
    if (title && !options.hideTitle) {
      const h = document.createElement('h3')
      h.className = 'metric-title'
      h.textContent = title
      card.appendChild(h)
    } else {
      card.classList.add('is-untitled')
    }
    const list = document.createElement('div')
    list.className = 'lanes'
    lanes.forEach((lane) => {
      const row = document.createElement('div')
      row.className = `lane ${lane.kind}`

      const main = document.createElement('div')
      main.className = 'lane-main'
      const tag = document.createElement('span')
      tag.className = 'lane-tag'
      tag.textContent = lane.label
      const val = document.createElement('span')
      val.className = 'lane-value'
      val.textContent = formatNumber(lane.value)
      main.append(tag, val)
      row.appendChild(main)

      const metricKey = lane.metricKey
      const compareKind = lane.compareKind || lane.kind
      if (metricKey && lastCompare && lastCompare.type) {
        const cmp = buildCompareRow(metricKey, compareKind, lane.value)
        if (cmp) row.appendChild(cmp)
      }

      list.appendChild(row)
    })
    card.appendChild(list)
    return card
  }

  function sumPromoFromDetailRows(rows) {
    let pay = 0
    let cost = 0
    for (const row of rows || []) {
      pay += Number(row.recommendPayAmount) || 0
      cost += Number(row.recommendCost) || 0
    }
    return {
      recommendPayAmount: Math.round(pay * 100) / 100,
      recommendCost: Math.round(cost * 100) / 100,
    }
  }

  function renderSummary(summary, compare, detailRows = []) {
    // 得物推看板 = 明细清单「推荐直接支付金额 / 推荐消耗」列累加
    const promo = sumPromoFromDetailRows(detailRows)
    lastSummary = {
      ...summary,
      recommendPayAmount: {总和: promo.recommendPayAmount},
      recommendCost: {总和: promo.recommendCost},
    }
    lastCompare = compare || null
    els.metrics.replaceChildren()
    if (els.compareLegend) {
      els.compareLegend.hidden = !(compare && compare.type)
      if (compare && compare.type) {
        const yoyRange = compare.yoy ? `${compare.yoy.startDate}~${compare.yoy.endDate}` : ''
        const popRange = compare.pop ? `${compare.pop.startDate}~${compare.pop.endDate}` : ''
        els.compareLegend.textContent = `${compare.label || ''}环比同比`
        els.compareLegend.title = `环比区间 ${popRange}；同比区间 ${yoyRange}`
      }
    }
    const promoPay = lastSummary.recommendPayAmount['总和']
    const promoCost = lastSummary.recommendCost['总和']
    els.metrics.append(
      renderMetricCard('支付金额', [
        {kind: 'sum', label: '总和', value: summary.payAmount['总和'], metricKey: 'payAmount'},
        {kind: 'big', label: '大店', value: summary.payAmount['大店'], metricKey: 'payAmount'},
        {kind: 'small', label: '小店', value: summary.payAmount['小店'], metricKey: 'payAmount'},
      ]),
      renderMetricCard('支付用户数', [
        {kind: 'sum', label: '总和', value: summary.payUsers['总和'], metricKey: 'payUsers'},
        {kind: 'big', label: '大店', value: summary.payUsers['大店'], metricKey: 'payUsers'},
        {kind: 'small', label: '小店', value: summary.payUsers['小店'], metricKey: 'payUsers'},
      ]),
      renderMetricCard('', [
        {
          kind: 'plain',
          label: '商详访问人数',
          value: summary.detailVisitors?.['大店'] ?? 0,
          metricKey: 'detailVisitors',
          compareKind: 'big',
        },
        {
          kind: 'plain',
          label: '收藏用户数',
          value: summary.favorites?.['大店'] ?? 0,
          metricKey: 'favorites',
          compareKind: 'big',
        },
        {
          kind: 'plain promo',
          label: '推荐直接支付金额',
          value: promoPay,
        },
        {
          kind: 'plain promo',
          label: '推荐消耗',
          value: promoCost,
        },
      ], {merged: true, hideTitle: true}),
    )
  }

  function rateExportValue(current, previous) {
    const rate = calcChangeRate(current, previous)
    if (rate == null || Number.isNaN(rate)) return ''
    return parseFloat(Number(rate).toFixed(1))
  }

  function ensureXlsx() {
    if (window.XLSX) return Promise.resolve(window.XLSX)
    return new Promise((resolve, reject) => {
      const script = document.createElement('script')
      script.src = '/vendor/xlsx/xlsx.full.min.js'
      script.onload = () => {
        if (window.XLSX) resolve(window.XLSX)
        else reject(new Error('XLSX 加载失败'))
      }
      script.onerror = () => reject(new Error('无法加载 Excel 导出库'))
      document.head.appendChild(script)
    })
  }

  function buildBoardExportRows() {
    const hasCompare = !!(lastCompare && lastCompare.type)
    const dimensions = [
      {label: '总和', kind: 'sum'},
      {label: '大店', kind: 'big'},
      {label: '小店', kind: 'small'},
    ]

    function metricValue(metricKey, laneKind) {
      // 商详 / 收藏始终取大店（含仅搜小店）
      if ((metricKey === 'detailVisitors' || metricKey === 'favorites') && laneKind !== 'big') {
        return ''
      }
      // 得物推汇总仅写在「总和」行
      if ((metricKey === 'recommendPayAmount' || metricKey === 'recommendCost') && laneKind !== 'sum') {
        return ''
      }
      const current = pickCompareValue(lastSummary, metricKey, laneKind)
      return current == null ? '' : Number(current)
    }

    function metricRate(metricKey, laneKind, which) {
      if ((metricKey === 'detailVisitors' || metricKey === 'favorites') && laneKind !== 'big') {
        return ''
      }
      if (!hasCompare) return ''
      const current = pickCompareValue(lastSummary, metricKey, laneKind)
      const prev = which === 'pop'
        ? pickCompareValue(lastCompare?.pop?.summary, metricKey, laneKind)
        : pickCompareValue(lastCompare?.yoy?.summary, metricKey, laneKind)
      const rate = rateExportValue(current, prev)
      return rate === '' ? '' : `${rate}%`
    }

    const header = [
      '',
      '支付金额',
      '支付用户数',
      '商详访问人数',
      '收藏用户数',
      '推荐直接支付金额',
      '推荐消耗',
      '支付金额环比',
      '支付金额同比',
      '支付用户数环比',
      '支付用户数同比',
      '商详访问人数环比',
      '商详访问人数同比',
      '收藏用户数环比',
      '收藏用户数同比',
    ]

    const rows = [header]
    dimensions.forEach(({label, kind}) => {
      rows.push([
        label,
        metricValue('payAmount', kind),
        metricValue('payUsers', kind),
        metricValue('detailVisitors', kind),
        metricValue('favorites', kind),
        metricValue('recommendPayAmount', kind),
        metricValue('recommendCost', kind),
        metricRate('payAmount', kind, 'pop'),
        metricRate('payAmount', kind, 'yoy'),
        metricRate('payUsers', kind, 'pop'),
        metricRate('payUsers', kind, 'yoy'),
        metricRate('detailVisitors', kind, 'pop'),
        metricRate('detailVisitors', kind, 'yoy'),
        metricRate('favorites', kind, 'pop'),
        metricRate('favorites', kind, 'yoy'),
      ])
    })
    return rows
  }

  async function exportBoardExcel() {
    if (!lastSummary) {
      showToast('请先完成对账')
      return
    }
    try {
      const XLSX = await ensureXlsx()
      const aoa = buildBoardExportRows()
      const sheet = XLSX.utils.aoa_to_sheet(aoa)
      sheet['!cols'] = [
        {wch: 6},
        {wch: 12}, {wch: 12}, {wch: 14}, {wch: 12},
        {wch: 16}, {wch: 12},
        {wch: 14}, {wch: 14}, {wch: 16}, {wch: 16},
        {wch: 18}, {wch: 18}, {wch: 16}, {wch: 16},
      ]
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, '汇总看板')

      const start = lastResultMeta?.startDate || 'start'
      const end = lastResultMeta?.endDate || 'end'
      const filename = `汇总看板_${start}_${end}.xlsx`
      XLSX.writeFile(book, filename)
      showToast('已导出看板 Excel')
    } catch (err) {
      console.error(err)
      showToast(err.message || '导出失败')
    }
  }

  function rateCellExport(rate) {
    if (rate == null || Number.isNaN(Number(rate))) return ''
    return `${parseFloat(Number(rate).toFixed(1))}%`
  }

  function buildDetailExportRows() {
    const header = [
      'SPUID',
      '商品货号',
      '类目名称',
      '支付金额',
      '支付金额环比',
      '支付金额同比',
      '商详访问人数',
      '商详访问人数环比',
      '商详访问人数同比',
      '收藏用户数',
      '收藏用户数环比',
      '收藏用户数同比',
      '支付用户数',
      '支付用户数环比',
      '支付用户数同比',
      '推荐直接支付金额',
      '推荐消耗',
      '推荐直接支付ROI',
    ]
    const sorted = getSortedRows(lastRows)
    const rows = [header]
    sorted.forEach((row) => {
      rows.push([
        row.spuid ?? '',
        row.sku ?? '',
        row.category ?? '',
        row.payAmount == null ? '' : Number(row.payAmount),
        rateCellExport(row.payAmountPop),
        rateCellExport(row.payAmountYoy),
        row.detailVisitors == null ? '' : Number(row.detailVisitors),
        rateCellExport(row.detailVisitorsPop),
        rateCellExport(row.detailVisitorsYoy),
        row.favorites == null ? '' : Number(row.favorites),
        rateCellExport(row.favoritesPop),
        rateCellExport(row.favoritesYoy),
        row.payUsers == null ? '' : Number(row.payUsers),
        rateCellExport(row.payUsersPop),
        rateCellExport(row.payUsersYoy),
        row.recommendPayAmount == null ? '' : Number(row.recommendPayAmount),
        row.recommendCost == null ? '' : Number(row.recommendCost),
        row.recommendRoi == null || Number.isNaN(Number(row.recommendRoi))
          ? ''
          : Number(row.recommendRoi),
      ])
    })
    return rows
  }

  async function exportDetailExcel() {
    if (!lastRows.length) {
      showToast(lastSummary ? '当前无明细数据' : '请先完成对账')
      return
    }
    try {
      const XLSX = await ensureXlsx()
      const aoa = buildDetailExportRows()
      const sheet = XLSX.utils.aoa_to_sheet(aoa)
      sheet['!cols'] = [
        {wch: 14}, {wch: 16}, {wch: 18},
        {wch: 12}, {wch: 14}, {wch: 14},
        {wch: 14}, {wch: 18}, {wch: 18},
        {wch: 12}, {wch: 16}, {wch: 16},
        {wch: 12}, {wch: 16}, {wch: 16},
        {wch: 16}, {wch: 12}, {wch: 16},
      ]
      const book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, sheet, '明细清单')

      const start = lastResultMeta?.startDate || 'start'
      const end = lastResultMeta?.endDate || 'end'
      const filename = `明细清单_${start}_${end}.xlsx`
      XLSX.writeFile(book, filename)
      showToast(`已导出明细 Excel（${lastRows.length} 行）`)
    } catch (err) {
      console.error(err)
      showToast(err.message || '导出失败')
    }
  }

  function updateSortHeaders() {
    document.querySelectorAll('.th-sort').forEach((btn) => {
      const key = btn.getAttribute('data-sort')
      btn.classList.toggle('is-asc', key === sortKey && sortDir === 'asc')
      btn.classList.toggle('is-desc', key === sortKey && sortDir === 'desc')
    })
  }

  function getSortedRows(rows) {
    const list = rows.slice()
    const dir = sortDir === 'asc' ? 1 : -1
    list.sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      const an = av == null || Number.isNaN(Number(av)) ? null : Number(av)
      const bn = bv == null || Number.isNaN(Number(bv)) ? null : Number(bv)
      if (an == null && bn == null) return String(a.spuid).localeCompare(String(b.spuid))
      if (an == null) return 1
      if (bn == null) return -1
      if (an === bn) return String(a.spuid).localeCompare(String(b.spuid))
      return (an - bn) * dir
    })
    return list
  }

  function formatRateText(rate) {
    return formatRate(rate)
  }

  function appendRateCell(tr, rate) {
    const td = document.createElement('td')
    td.className = 'num compare-col'
    const info = formatRateText(rate)
    const span = document.createElement('span')
    span.className = `rate-cell ${info.cls}`
    span.textContent = info.text
    td.appendChild(span)
    tr.appendChild(td)
  }

  function renderTable(rows) {
    lastRows = Array.isArray(rows) ? rows : []
    const showCompare = !!(lastCompare && lastCompare.type)
    const table = els.tableBody.closest('table')
    if (table) table.classList.toggle('show-compare', showCompare)

    const sorted = getSortedRows(lastRows)
    updateSortHeaders()

    const frag = document.createDocumentFragment()
    sorted.forEach((row) => {
      const tr = document.createElement('tr')
        ;[row.spuid, row.sku, row.category].forEach((text, idx) => {
          const td = document.createElement('td')
          td.textContent = text ?? ''
          tr.appendChild(td)
        })

      const metrics = [
        {key: 'payAmount', value: row.payAmount},
        {key: 'detailVisitors', value: row.detailVisitors},
        {key: 'favorites', value: row.favorites},
        {key: 'payUsers', value: row.payUsers},
      ]
      metrics.forEach((m) => {
        const td = document.createElement('td')
        td.className = 'num'
        td.textContent = formatNumber(m.value)
        tr.appendChild(td)
        appendRateCell(tr, row[`${m.key}Pop`])
        appendRateCell(tr, row[`${m.key}Yoy`])
      })

      const promoMetrics = [
        {text: formatNumber(row.recommendPayAmount)},
        {text: formatNumber(row.recommendCost)},
        {
          text: row.recommendRoi == null || Number.isNaN(Number(row.recommendRoi))
            ? '—'
            : formatNumber(row.recommendRoi),
        },
      ]
      promoMetrics.forEach((m) => {
        const td = document.createElement('td')
        td.className = 'num promo-col'
        td.textContent = m.text
        tr.appendChild(td)
      })

      frag.appendChild(tr)
    })
    els.tableBody.replaceChildren(frag)
  }

  function handleSortClick(key) {
    if (sortKey === key) {
      sortDir = sortDir === 'desc' ? 'asc' : 'desc'
    } else {
      sortKey = key
      sortDir = 'desc'
    }
    renderTable(lastRows)
  }

  function collectLeafValues(nodes, out) {
    out = out || []
    nodes.forEach((n) => {
      if (n.children && n.children.length) collectLeafValues(n.children, out)
      else out.push(n.value)
    })
    return out
  }

  function filterCategoryTree(nodes, keyword) {
    const q = String(keyword || '').trim().toLowerCase()
    if (!q) return nodes

    function matchNode(node) {
      const hit =
        String(node.label || '').toLowerCase().includes(q) ||
        String(node.value || '').toLowerCase().includes(q)

      if (node.children && node.children.length) {
        const children = node.children.map(matchNode).filter(Boolean)
        if (children.length || hit) {
          return {
            label: node.label,
            value: node.value,
            children: children.length ? children : undefined,
          }
        }
        return null
      }

      return hit ? {label: node.label, value: node.value} : null
    }

    return nodes.map(matchNode).filter(Boolean)
  }

  function refreshCategoryView() {
    filteredCategoryTree = filterCategoryTree(categoryTree, categoryKeyword)
    renderCategoryTree(filteredCategoryTree)
    if (els.categoryEmpty) {
      els.categoryEmpty.hidden = filteredCategoryTree.length > 0
    }
  }

  function updateCategoryLabel() {
    const count = selectedCategories.size
    if (!count) els.categoryLabel.textContent = '全部类目'
    else if (count === 1) els.categoryLabel.textContent = Array.from(selectedCategories)[0]
    else els.categoryLabel.textContent = `已选 ${count} 个类目`
  }

  function syncParentChecks() {
    els.categoryTree.querySelectorAll('[data-role="parent"]').forEach((parentInput) => {
      const group = parentInput.closest('.tree-node')
      const kids = Array.from(group.querySelectorAll('.tree-children input[type="checkbox"]'))
      if (!kids.length) return
      const checked = kids.filter((k) => k.checked).length
      parentInput.checked = checked === kids.length
      parentInput.indeterminate = checked > 0 && checked < kids.length
    })
  }

  function renderCategoryTree(nodes) {
    els.categoryTree.replaceChildren()
    function walk(list, parent) {
      list.forEach((node) => {
        const wrap = document.createElement('div')
        wrap.className = 'tree-node'
        const row = document.createElement('label')
        row.className = 'tree-row'
        const input = document.createElement('input')
        input.type = 'checkbox'
        input.value = node.value
        input.dataset.role = node.children && node.children.length ? 'parent' : 'leaf'
        if (!(node.children && node.children.length)) {
          input.checked = selectedCategories.has(node.value)
        }
        const text = document.createElement('span')
        text.textContent = node.label
        row.append(input, text)
        wrap.appendChild(row)

        if (node.children && node.children.length) {
          const kids = document.createElement('div')
          kids.className = 'tree-children'
          walk(node.children, kids)
          wrap.appendChild(kids)
          input.addEventListener('change', () => {
            kids.querySelectorAll('input[data-role="leaf"]').forEach((leaf) => {
              leaf.checked = input.checked
              if (input.checked) selectedCategories.add(leaf.value)
              else selectedCategories.delete(leaf.value)
            })
            syncParentChecks()
            updateCategoryLabel()
          })
        } else {
          input.addEventListener('change', () => {
            if (input.checked) selectedCategories.add(input.value)
            else selectedCategories.delete(input.value)
            syncParentChecks()
            updateCategoryLabel()
          })
        }
        parent.appendChild(wrap)
      })
    }
    walk(nodes, els.categoryTree)
    syncParentChecks()
    updateCategoryLabel()
  }

  async function loadCategories() {
    const token = ++categoryFetchToken
    els.categoryLabel.textContent = '类目加载中…'
    try {
      const res = await apiFetch('/api/categories', {cache: 'no-store'})
      const json = await res.json()
      if (token !== categoryFetchToken) return
      if (!json.ok) throw new Error(json.error || '类目加载失败')
      categoryTree = json.data || []
      const leaves = new Set(collectLeafValues(categoryTree))
      // 全量类目树：保留仍有效的已选类目，换日期不会清空
      selectedCategories = new Set(Array.from(selectedCategories).filter((v) => leaves.has(v)))
      refreshCategoryView()
      renderCategoryPresets()
    } catch (err) {
      if (token !== categoryFetchToken) return
      els.categoryLabel.textContent = '类目加载失败'
      showToast(err.message || '类目加载失败')
    }
  }

  function getQuery() {
    return {
      startDate: inputToYmd(els.startDate.value) || null,
      endDate: inputToYmd(els.endDate.value) || null,
      spuid: els.spuid.value.trim(),
      sku: els.sku.value.trim(),
      categories: Array.from(selectedCategories),
      shop: els.shop.value,
    }
  }

  async function runSearch() {
    if (searching) return
    if (!meta) {
      showToast('服务未连接，请用 http://localhost:3780 打开')
      return
    }
    const query = getQuery()
    if (!query.startDate || !query.endDate) {
      showToast('请先选择日期范围')
      return
    }
    if (query.startDate > query.endDate) {
      showToast('开始日期不能晚于结束日期')
      return
    }

    searching = true
    els.searchBtn.disabled = true
    startProgress('正在读取本地表格…')

    try {
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 180000)
      const res = await apiFetch('/api/search', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(query),
        cache: 'no-store',
        signal: controller.signal,
      })
      window.clearTimeout(timeout)

      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error || `检索失败 (${res.status})`)

      const {summary, rows, meta: resultMeta, compare} = json.data
      lastResultMeta = resultMeta
      lastCompare = compare || null
      renderTable(rows)
      renderSummary(summary, compare, rows)

      const periodText = compare && compare.type
        ? ` · ${compare.label}环比同比`
        : ''
      els.resultMeta.textContent = `${resultMeta.startDate}–${resultMeta.endDate} · 原始行 ${resultMeta.matchedRawRows} · SPU ${resultMeta.matchedSpus}${periodText}`
      els.board.hidden = false
      els.tableSection.hidden = false
      els.emptyState.hidden = true
      stopProgress(true)
      if (!rows.length) showToast('没有匹配数据')
      else showToast(`对账完成 · ${rows.length} 个 SPU`)
    } catch (err) {
      console.error(err)
      stopProgress(false)
      const msg = err.name === 'AbortError' ? '检索超时，请缩小日期范围' : (err.message || '检索失败')
      showToast(msg)
      if (els.serverStatus) {
        els.serverStatus.textContent = `检索失败：${msg}`
        els.serverStatus.className = 'empty-hint bad'
        els.emptyState.hidden = false
      }
    } finally {
      searching = false
      els.searchBtn.disabled = false
    }
  }

  function applyMeta(nextMeta, {preserveDates = false} = {}) {
    meta = nextMeta
    if (!meta) return
    const prevStart = els.startDate.value
    const prevEnd = els.endDate.value
    els.startDate.min = ymdToInput(meta.minDate)
    els.startDate.max = ymdToInput(meta.maxDate)
    els.endDate.min = ymdToInput(meta.minDate)
    els.endDate.max = ymdToInput(meta.maxDate)
    if (preserveDates && prevStart && prevEnd) {
      els.startDate.value = prevStart
      els.endDate.value = prevEnd
    } else {
      els.startDate.value = ymdToInput(meta.maxDate)
      els.endDate.value = ymdToInput(meta.maxDate)
    }
    els.metaHint.textContent = `实时数据 ${ymdToInput(meta.minDate)} ~ ${ymdToInput(meta.maxDate)} · 大店 ${meta.fileCounts['大店']} · 小店 ${meta.fileCounts['小店']}`
    if (els.commitId && meta.commit) {
      els.commitId.textContent = meta.commit
      els.commitId.hidden = false
    }
  }

  async function runDeploy() {
    if (deploying) return
    deploying = true
    if (els.commitId) els.commitId.disabled = true
    try {
      const res = await apiFetch('/pull', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: '{}',
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || !json.ok) {
        throw new Error(json.error || `部署失败 HTTP ${res.status}`)
      }
      showToast(json.message || '已开始拉取并安装依赖，完成后自动重载')
    } catch (err) {
      showToast(String(err.message || err))
    } finally {
      deploying = false
      if (els.commitId) els.commitId.disabled = false
    }
  }

  function openUploadModal() {
    if (!els.uploadModal) return
    els.uploadModal.hidden = false
    document.body.classList.add('modal-open')
    if (els.uploadToken) {
      try {
        const saved = sessionStorage.getItem('dewu_upload_token')
        if (saved && !els.uploadToken.value) els.uploadToken.value = saved
      } catch (_) { /* ignore */}
      els.uploadToken.focus()
    } else if (els.closeUploadBtn) {
      els.closeUploadBtn.focus()
    }
  }

  function closeUploadModal() {
    if (!els.uploadModal || uploading) return
    els.uploadModal.hidden = true
    if (!els.promoUploadModal || els.promoUploadModal.hidden) {
      document.body.classList.remove('modal-open')
    }
  }

  function parseUploadFilename(name) {
    const base = String(name || '').split(/[/\\]/).pop() || ''
    const m = base.match(/^(大店|小店)(\d{8})\.xlsx$/i)
    if (!m) return null
    return {shop: m[1], date: m[2]}
  }

  function isValidUploadYmd(ymd) {
    if (!/^\d{8}$/.test(ymd)) return false
    const y = Number(ymd.slice(0, 4))
    const m = Number(ymd.slice(4, 6))
    const d = Number(ymd.slice(6, 8))
    const dt = new Date(y, m - 1, d)
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
  }

  function shopExistingDates(shop) {
    const dates = meta?.fileDates?.[shop]
    return Array.isArray(dates) ? new Set(dates) : new Set()
  }

  function syncUploadSelection() {
    const files = els.uploadFiles?.files ? Array.from(els.uploadFiles.files) : []
    /** @type {Map<string, string>} */
    const seenKey = new Map()
    /** @type {Map<string, { 大店?: string, 小店?: string }>} */
    const byDate = new Map()

    pendingUploads = files.map((file) => {
      const name = file.name || ''
      if (!/\.xlsx$/i.test(name)) {
        return {file, name, ok: false, msg: '仅支持 .xlsx', status: 'invalid'}
      }
      const parsed = parseUploadFilename(name)
      if (!parsed) {
        return {file, name, ok: false, msg: '命名须为 大店YYYYMMDD.xlsx / 小店YYYYMMDD.xlsx', status: 'invalid'}
      }
      if (!isValidUploadYmd(parsed.date)) {
        return {file, name, shop: parsed.shop, date: parsed.date, ok: false, msg: `日期无效 ${parsed.date}`, status: 'invalid'}
      }
      const key = `${parsed.shop}|${parsed.date}`
      if (seenKey.has(key)) {
        return {
          file, name, shop: parsed.shop, date: parsed.date,
          ok: false, msg: `与 ${seenKey.get(key)} 重复`, status: 'invalid',
        }
      }
      if (shopExistingDates(parsed.shop).has(parsed.date)) {
        return {
          file, name, shop: parsed.shop, date: parsed.date,
          ok: false, msg: `${parsed.shop} 已存在该日期`, status: 'invalid',
        }
      }
      seenKey.set(key, name)
      if (!byDate.has(parsed.date)) byDate.set(parsed.date, {})
      byDate.get(parsed.date)[parsed.shop] = name
      return {
        file, name, shop: parsed.shop, date: parsed.date,
        ok: true, msg: `待上传 · ${parsed.shop}/${parsed.date}.xlsx`, status: 'ready',
      }
    })

    // Pair check
    for (const [date, shops] of byDate) {
      if (shops['大店'] && shops['小店']) continue
      const missing = !shops['大店'] ? '大店' : '小店'
      const msg = `${date} 缺少${missing}，须成对上传`
      pendingUploads = pendingUploads.map((item) => {
        if (item.date !== date || item.status !== 'ready') return item
        return {...item, ok: false, msg, status: 'invalid'}
      })
    }

    const readyCount = pendingUploads.filter((x) => x.ok).length
    const pairCount = Math.floor(readyCount / 2)
    if (els.uploadFileMeta) {
      els.uploadFileMeta.textContent = files.length
        ? `已选 ${files.length} 个 · 可上传 ${readyCount} 个（${pairCount} 对）`
        : '未选择文件'
    }
    if (els.uploadBtn) {
      els.uploadBtn.disabled = uploading || readyCount === 0 || readyCount !== files.length
    }
    renderUploadList()
  }

  function renderUploadList() {
    if (!els.uploadList) return
    if (!pendingUploads.length) {
      els.uploadList.hidden = true
      els.uploadList.replaceChildren()
      return
    }
    els.uploadList.hidden = false
    const frag = document.createDocumentFragment()
    pendingUploads.forEach((item) => {
      const li = document.createElement('li')
      li.className = item.ok ? 'is-ok' : 'is-bad'
      if (item.status === 'uploading') li.className = 'is-wait'
      if (item.status === 'done-ok') li.className = 'is-ok'
      if (item.status === 'done-bad') li.className = 'is-bad'
      const name = document.createElement('span')
      name.className = 'upload-name'
      name.textContent = item.name
      const msg = document.createElement('span')
      msg.className = 'upload-msg'
      msg.textContent = item.msg
      li.append(name, msg)
      frag.appendChild(li)
    })
    els.uploadList.replaceChildren(frag)
  }

  async function runUpload() {
    if (uploading || !meta) return
    const token = String(els.uploadToken?.value || '').trim()
    if (!token) {
      showToast('请输入上传口令')
      els.uploadToken?.focus()
      return
    }
    const valid = pendingUploads.filter((x) => x.ok)
    if (!valid.length || valid.length !== pendingUploads.length) {
      showToast('请先通过校验：每个日期须成对包含大店与小店')
      return
    }

    uploading = true
    if (els.uploadBtn) els.uploadBtn.disabled = true
    pendingUploads = pendingUploads.map((item) => (
      item.ok
        ? {...item, status: 'uploading', msg: '上传中…'}
        : item
    ))
    renderUploadList()

    try {
      const form = new FormData()
      form.append('token', token)
      valid.forEach((item) => form.append('files', item.file, item.name))

      const res = await apiFetch('/api/upload', {
        method: 'POST',
        body: form,
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.status === 403) {
        throw new Error(json.error || '上传口令错误')
      }
      const results = json.data?.results || []
      const byName = new Map(results.map((r) => [r.name, r]))

      pendingUploads = pendingUploads.map((item) => {
        const r = byName.get(item.name)
        if (!r) {
          return {...item, status: 'done-bad', ok: false, msg: json.error || '未返回结果'}
        }
        if (r.ok) {
          return {
            ...item,
            status: 'done-ok',
            ok: true,
            msg: `已写入 ${r.shop}/${r.date}.xlsx · ${r.rowCount || 0} 行`,
          }
        }
        return {...item, status: 'done-bad', ok: false, msg: r.error || '上传失败'}
      })
      renderUploadList()

      if (json.data?.meta) {
        applyMeta(json.data.meta, {preserveDates: true})
        loadCategories()
      }

      const okCount = json.data?.okCount || 0
      const failCount = json.data?.failCount || pendingUploads.length
      if (json.ok && okCount) {
        try {sessionStorage.setItem('dewu_upload_token', token)} catch (_) { /* ignore */}
        showToast(`上传成功 ${okCount} 个文件（${okCount / 2} 对）`)
        window.setTimeout(() => closeUploadModal(), 600)
      } else if (okCount) {
        showToast(`成功 ${okCount} 个，失败 ${failCount} 个`)
      } else {
        showToast(json.error || `校验未通过（${failCount}）`)
      }

      if (els.uploadFiles) els.uploadFiles.value = ''
      if (els.uploadFileMeta) {
        els.uploadFileMeta.textContent = json.ok && okCount
          ? `本次成功 ${okCount} 个`
          : '未选择文件'
      }
    } catch (err) {
      console.error(err)
      pendingUploads = pendingUploads.map((item) => (
        item.status === 'uploading'
          ? {...item, status: 'done-bad', ok: false, msg: err.message || '上传失败'}
          : item
      ))
      renderUploadList()
      showToast(err.message || '上传失败')
      if (String(err.message || '').includes('口令')) els.uploadToken?.focus()
    } finally {
      uploading = false
      if (els.uploadBtn) els.uploadBtn.disabled = true
    }
  }

  function openPromoUploadModal() {
    if (!els.promoUploadModal) return
    els.promoUploadModal.hidden = false
    document.body.classList.add('modal-open')
    if (els.promoUploadToken) {
      try {
        const saved = sessionStorage.getItem('dewu_upload_token')
        if (saved && !els.promoUploadToken.value) els.promoUploadToken.value = saved
      } catch (_) { /* ignore */}
      els.promoUploadToken.focus()
    }
  }

  function closePromoUploadModal() {
    if (!els.promoUploadModal || promoUploading) return
    els.promoUploadModal.hidden = true
    if (!els.uploadModal || els.uploadModal.hidden) {
      document.body.classList.remove('modal-open')
    }
  }

  function parsePromoUploadFilename(name) {
    const base = String(name || '').split(/[/\\]/).pop() || ''
    const range = base.match(
      /^(\d{4})\.(\d{1,2})\.(\d{1,2})-(\d{4})\.(\d{1,2})\.(\d{1,2})\.xlsx$/i,
    )
    if (range) {
      const start = `${range[1]}${pad2(range[2])}${pad2(range[3])}`
      const end = `${range[4]}${pad2(range[5])}${pad2(range[6])}`
      if (!isValidUploadYmd(start) || !isValidUploadYmd(end) || start > end) return null
      return {fileName: base, start, end}
    }
    const single = base.match(/^(\d{4})\.(\d{1,2})\.(\d{1,2})\.xlsx$/i)
    if (single) {
      const ymd = `${single[1]}${pad2(single[2])}${pad2(single[3])}`
      if (!isValidUploadYmd(ymd)) return null
      return {fileName: base, start: ymd, end: ymd}
    }
    return null
  }

  function rangesOverlap(aStart, aEnd, bStart, bEnd) {
    return aStart <= bEnd && bStart <= aEnd
  }

  function formatPromoRange(start, end) {
    if (!start || !end) return ''
    return start === end ? start : `${start}~${end}`
  }

  function findExistingPromoConflict(start, end) {
    const files = Array.isArray(meta?.promoFiles) ? meta.promoFiles : []
    for (const f of files) {
      if (rangesOverlap(start, end, f.start, f.end)) {
        return `与已有 ${f.fileName}（${formatPromoRange(f.start, f.end)}）重叠`
      }
    }
    return null
  }

  function syncPromoUploadSelection() {
    const files = els.promoUploadFiles?.files ? Array.from(els.promoUploadFiles.files) : []
    /** @type {Map<string, string>} */
    const seenName = new Map()

    pendingPromoUploads = files.map((file) => {
      const name = file.name || ''
      if (!/\.xlsx$/i.test(name)) {
        return {file, name, ok: false, msg: '仅支持 .xlsx', status: 'invalid'}
      }
      const parsed = parsePromoUploadFilename(name)
      if (!parsed) {
        return {
          file, name, ok: false,
          msg: '命名须为 YYYY.M.D-YYYY.M.D.xlsx 或 YYYY.M.D.xlsx',
          status: 'invalid',
        }
      }
      const key = parsed.fileName.toLowerCase()
      if (seenName.has(key)) {
        return {
          file, name, start: parsed.start, end: parsed.end,
          ok: false, msg: `与 ${seenName.get(key)} 重复`, status: 'invalid',
        }
      }
      const conflict = findExistingPromoConflict(parsed.start, parsed.end)
      if (conflict) {
        return {
          file, name, start: parsed.start, end: parsed.end,
          ok: false, msg: conflict, status: 'invalid',
        }
      }
      seenName.set(key, name)
      return {
        file, name, start: parsed.start, end: parsed.end,
        ok: true,
        msg: `待上传 · ${formatPromoRange(parsed.start, parsed.end)}`,
        status: 'ready',
      }
    })

    // Within-batch overlap
    for (let i = 0; i < pendingPromoUploads.length; i++) {
      const a = pendingPromoUploads[i]
      if (!a.ok || !a.start || !a.end) continue
      for (let j = i + 1; j < pendingPromoUploads.length; j++) {
        const b = pendingPromoUploads[j]
        if (!b.ok || !b.start || !b.end) continue
        if (!rangesOverlap(a.start, a.end, b.start, b.end)) continue
        pendingPromoUploads[i] = {
          ...a, ok: false, status: 'invalid',
          msg: `与同批次 ${b.name}（${formatPromoRange(b.start, b.end)}）重叠`,
        }
        pendingPromoUploads[j] = {
          ...b, ok: false, status: 'invalid',
          msg: `与同批次 ${a.name}（${formatPromoRange(a.start, a.end)}）重叠`,
        }
      }
    }

    const readyCount = pendingPromoUploads.filter((x) => x.ok).length
    if (els.promoUploadFileMeta) {
      els.promoUploadFileMeta.textContent = files.length
        ? `已选 ${files.length} 个 · 可上传 ${readyCount} 个`
        : '未选择文件'
    }
    if (els.promoUploadBtn) {
      els.promoUploadBtn.disabled = promoUploading || readyCount === 0 || readyCount !== files.length
    }
    renderPromoUploadList()
  }

  function renderPromoUploadList() {
    if (!els.promoUploadList) return
    if (!pendingPromoUploads.length) {
      els.promoUploadList.hidden = true
      els.promoUploadList.replaceChildren()
      return
    }
    els.promoUploadList.hidden = false
    const frag = document.createDocumentFragment()
    pendingPromoUploads.forEach((item) => {
      const li = document.createElement('li')
      li.className = item.ok ? 'is-ok' : 'is-bad'
      if (item.status === 'uploading') li.className = 'is-wait'
      if (item.status === 'done-ok') li.className = 'is-ok'
      if (item.status === 'done-bad') li.className = 'is-bad'
      const name = document.createElement('span')
      name.className = 'upload-name'
      name.textContent = item.name
      const msg = document.createElement('span')
      msg.className = 'upload-msg'
      msg.textContent = item.msg
      li.append(name, msg)
      frag.appendChild(li)
    })
    els.promoUploadList.replaceChildren(frag)
  }

  async function runPromoUpload() {
    if (promoUploading || !meta) return
    const token = String(els.promoUploadToken?.value || '').trim()
    if (!token) {
      showToast('请输入上传口令')
      els.promoUploadToken?.focus()
      return
    }
    const valid = pendingPromoUploads.filter((x) => x.ok)
    if (!valid.length || valid.length !== pendingPromoUploads.length) {
      showToast('请先通过校验：命名正确且日期区间不与已有数据重叠')
      return
    }

    promoUploading = true
    if (els.promoUploadBtn) els.promoUploadBtn.disabled = true
    pendingPromoUploads = pendingPromoUploads.map((item) => (
      item.ok
        ? {...item, status: 'uploading', msg: '上传中…'}
        : item
    ))
    renderPromoUploadList()

    try {
      const form = new FormData()
      form.append('token', token)
      valid.forEach((item) => form.append('files', item.file, item.name))

      const res = await apiFetch('/api/upload-promo', {
        method: 'POST',
        body: form,
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.status === 403) {
        throw new Error(json.error || '上传口令错误')
      }
      const results = json.data?.results || []
      const byName = new Map(results.map((r) => [r.name, r]))

      pendingPromoUploads = pendingPromoUploads.map((item) => {
        const r = byName.get(item.name)
        if (!r) {
          return {...item, status: 'done-bad', ok: false, msg: json.error || '未返回结果'}
        }
        if (r.ok) {
          return {
            ...item,
            status: 'done-ok',
            ok: true,
            msg: `已写入 · ${formatPromoRange(r.start, r.end)} · ${r.rowCount || 0} 行`,
          }
        }
        return {...item, status: 'done-bad', ok: false, msg: r.error || '上传失败'}
      })
      renderPromoUploadList()

      if (json.data?.meta) {
        applyMeta(json.data.meta, {preserveDates: true})
      }

      const okCount = json.data?.okCount || 0
      const failCount = json.data?.failCount || pendingPromoUploads.length
      if (json.ok && okCount) {
        try {sessionStorage.setItem('dewu_upload_token', token)} catch (_) { /* ignore */}
        showToast(`得物推上传成功 ${okCount} 个文件`)
        window.setTimeout(() => closePromoUploadModal(), 600)
      } else if (okCount) {
        showToast(`成功 ${okCount} 个，失败 ${failCount} 个`)
      } else {
        showToast(json.error || `校验未通过（${failCount}）`)
      }

      if (els.promoUploadFiles) els.promoUploadFiles.value = ''
      if (els.promoUploadFileMeta) {
        els.promoUploadFileMeta.textContent = json.ok && okCount
          ? `本次成功 ${okCount} 个`
          : '未选择文件'
      }
    } catch (err) {
      console.error(err)
      pendingPromoUploads = pendingPromoUploads.map((item) => (
        item.status === 'uploading'
          ? {...item, status: 'done-bad', ok: false, msg: err.message || '上传失败'}
          : item
      ))
      renderPromoUploadList()
      showToast(err.message || '上传失败')
      if (String(err.message || '').includes('口令')) els.promoUploadToken?.focus()
    } finally {
      promoUploading = false
      if (els.promoUploadBtn) els.promoUploadBtn.disabled = true
    }
  }

  function resetFilters() {
    if (meta) {
      els.startDate.value = ymdToInput(meta.maxDate)
      els.endDate.value = ymdToInput(meta.maxDate)
    }
    els.spuid.value = ''
    els.sku.value = ''
    els.shop.value = ''
    selectedCategories.clear()
    categoryKeyword = ''
    activeCategoryPresetId = null
    if (els.categorySearch) els.categorySearch.value = ''
    hideCategoryPresetMenu()
    updateCategoryLabel()
    loadCategories()
    renderCategoryPresets()
  }

  async function init() {
    els.metaHint.textContent = '正在连接本地服务…'
    els.serverStatus.textContent = '请确认地址是 http://localhost:3780'
    els.serverStatus.className = 'empty-hint'

    try {
      const res = await apiFetch('/api/meta', {cache: 'no-store'})
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json()
      if (!json.ok) throw new Error(json.error || '元数据失败')
      applyMeta(json.data)

      els.serverStatus.textContent = '已连接：数据来自 大店/ 与 小店/ 的 xlsx'
      els.serverStatus.className = 'empty-hint ok'
      loadCategories();

      // 点击整个日期框即可打开日历
      [els.startDate, els.endDate].forEach((input) => {
        input.addEventListener('click', () => {
          if (typeof input.showPicker === 'function') {
            try {input.showPicker()} catch (_) { /* ignore */}
          }
        })
      })
    } catch (err) {
      if (String(err.message || '').includes('登录')) return
      meta = null
      els.metaHint.textContent = '未连接服务'
      els.serverStatus.innerHTML = `连接失败。请在目录 <code>C:\\Users\\l\\Desktop\\dewu\\dewu</code> 运行 <code>npm start</code>，然后打开 <code>http://localhost:3780</code>`
      els.serverStatus.className = 'empty-hint bad'
      showToast('服务未连接')
    }

    els.searchBtn.addEventListener('click', runSearch)
    els.resetBtn.addEventListener('click', resetFilters)
    if (els.openUploadBtn) {
      els.openUploadBtn.addEventListener('click', openUploadModal)
    }
    if (els.openPromoUploadBtn) {
      els.openPromoUploadBtn.addEventListener('click', openPromoUploadModal)
    }
    if (els.uploadModal) {
      els.uploadModal.addEventListener('click', (e) => {
        if (e.target && e.target.closest('[data-close-upload]')) {
          closeUploadModal()
        }
      })
    }
    if (els.promoUploadModal) {
      els.promoUploadModal.addEventListener('click', (e) => {
        if (e.target && e.target.closest('[data-close-promo-upload]')) {
          closePromoUploadModal()
        }
      })
    }
    if (els.uploadPickBtn && els.uploadFiles) {
      els.uploadPickBtn.addEventListener('click', () => els.uploadFiles.click())
    }
    if (els.uploadFiles) {
      els.uploadFiles.addEventListener('change', syncUploadSelection)
    }
    if (els.uploadBtn) {
      els.uploadBtn.addEventListener('click', runUpload)
    }
    if (els.promoUploadPickBtn && els.promoUploadFiles) {
      els.promoUploadPickBtn.addEventListener('click', () => els.promoUploadFiles.click())
    }
    if (els.promoUploadFiles) {
      els.promoUploadFiles.addEventListener('change', syncPromoUploadSelection)
    }
    if (els.promoUploadBtn) {
      els.promoUploadBtn.addEventListener('click', runPromoUpload)
    }
    if (els.commitId) {
      els.commitId.addEventListener('click', runDeploy)
    }
    if (els.exportBoardBtn) {
      els.exportBoardBtn.addEventListener('click', exportBoardExcel)
    }
    if (els.exportDetailBtn) {
      els.exportDetailBtn.addEventListener('click', exportDetailExcel)
    }
    document.querySelectorAll('.th-sort').forEach((btn) => {
      btn.addEventListener('click', () => {
        handleSortClick(btn.getAttribute('data-sort'))
      })
    })
    updateSortHeaders()
    els.categoryTrigger.addEventListener('click', () => {
      const open = els.categoryPanel.hidden
      els.categoryPanel.hidden = !open
      els.categoryTrigger.setAttribute('aria-expanded', String(open))
      if (open && els.categorySearch) {
        window.setTimeout(() => els.categorySearch.focus(), 0)
      }
    })
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.field-cascade')) {
        els.categoryPanel.hidden = true
        els.categoryTrigger.setAttribute('aria-expanded', 'false')
      }
    })
    if (els.categorySearch) {
      els.categorySearch.addEventListener('input', () => {
        categoryKeyword = els.categorySearch.value
        refreshCategoryView()
      })
      els.categorySearch.addEventListener('keydown', (e) => {
        // 避免在类目搜索框按 Enter 触发整页检索
        if (e.key === 'Enter') e.preventDefault()
      })
    }
    els.catSelectAll.addEventListener('click', () => {
      const source = categoryKeyword.trim() ? filteredCategoryTree : categoryTree
      collectLeafValues(source).forEach((v) => selectedCategories.add(v))
      activeCategoryPresetId = null
      refreshCategoryView()
      renderCategoryPresets()
    })
    els.catClear.addEventListener('click', () => {
      if (categoryKeyword.trim()) {
        collectLeafValues(filteredCategoryTree).forEach((v) => selectedCategories.delete(v))
      } else {
        selectedCategories.clear()
      }
      activeCategoryPresetId = null
      refreshCategoryView()
      renderCategoryPresets()
    })
    if (els.categoryPresetSaveBtn) {
      els.categoryPresetSaveBtn.addEventListener('click', () => {
        hideCategoryPresetMenu()
        openCategoryPresetModal('save')
      })
    }
    if (els.categoryPresetModalConfirm) {
      els.categoryPresetModalConfirm.addEventListener('click', confirmCategoryPresetModal)
    }
    if (els.categoryPresetNameInput) {
      els.categoryPresetNameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          confirmCategoryPresetModal()
        }
      })
    }
    document.querySelectorAll('[data-close-cat-preset-modal]').forEach((node) => {
      node.addEventListener('click', closeCategoryPresetModal)
    })
    if (els.categoryPresetMenu) {
      els.categoryPresetMenu.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-action]')
        if (!btn) return
        const id = categoryPresetContextId
        const action = btn.getAttribute('data-action')
        hideCategoryPresetMenu()
        if (!id) return
        if (action === 'rename') openCategoryPresetModal('rename', id)
        if (action === 'delete') deleteCategoryPreset(id)
      })
    }
    document.addEventListener('click', (e) => {
      if (!els.categoryPresetMenu || els.categoryPresetMenu.hidden) return
      if (els.categoryPresetMenu.contains(e.target)) return
      hideCategoryPresetMenu()
    })
    document.addEventListener('scroll', hideCategoryPresetMenu, true)
    window.addEventListener('resize', hideCategoryPresetMenu)
    renderCategoryPresets()

    els.startDate.addEventListener('change', () => {
      updatePeriodHint()
    })
    els.endDate.addEventListener('change', () => {
      updatePeriodHint()
    })
    updatePeriodHint()
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (els.categoryPresetMenu && !els.categoryPresetMenu.hidden) {
          hideCategoryPresetMenu()
          return
        }
        if (els.categoryPresetModal && !els.categoryPresetModal.hidden) {
          closeCategoryPresetModal()
          return
        }
        if (els.promoUploadModal && !els.promoUploadModal.hidden) {
          closePromoUploadModal()
          return
        }
        if (els.uploadModal && !els.uploadModal.hidden) {
          closeUploadModal()
          return
        }
      }
      if (
        e.key === 'Enter' &&
        e.target.matches('input') &&
        e.target.id !== 'categorySearch' &&
        e.target.id !== 'categoryPresetNameInput'
      ) {
        runSearch()
      }
    })
  }

  init()
})()
