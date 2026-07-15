/* Dewu dual-shop search — plain script (no module) */
(function () {
  const COPY_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M4 16V6a2 2 0 0 1 2-2h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'

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
    metaHint: $('metaHint'),
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

  async function copyValue(raw, btn) {
    const text = String(raw)
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    btn.classList.add('copied')
    showToast('已复制')
    window.setTimeout(() => btn.classList.remove('copied'), 900)
  }

  function createCopyButton(value) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'copy-btn'
    btn.title = '复制纯数值'
    btn.innerHTML = COPY_ICON
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      copyValue(value, btn)
    })
    return btn
  }

  function renderMetricCard(title, lanes, options = {}) {
    const card = document.createElement('article')
    card.className = 'metric-card' + (options.merged ? ' is-merged' : '')
    const h = document.createElement('h3')
    h.className = 'metric-title'
    h.textContent = title
    card.appendChild(h)
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
      main.append(tag, val, createCopyButton(lane.value))
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

  function renderSummary(summary, compare) {
    lastSummary = summary
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
      renderMetricCard('商详与收藏', [
        {
          kind: 'plain',
          label: '商详访问人数',
          value: summary.detailVisitors['大店'],
          metricKey: 'detailVisitors',
          compareKind: 'big',
        },
        {
          kind: 'plain',
          label: '收藏用户数',
          value: summary.favorites['大店'],
          metricKey: 'favorites',
          compareKind: 'big',
        },
      ], {merged: true}),
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
      // 商详 / 收藏仅大店有数据
      if ((metricKey === 'detailVisitors' || metricKey === 'favorites') && laneKind !== 'big') {
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
    const wrap = document.createElement('div')
    wrap.className = 'cell-with-copy'
    const span = document.createElement('span')
    span.className = `rate-cell ${info.cls}`
    span.textContent = info.text
    // 复制纯数字百分比值，无 % 符号时用 —
    const copyVal = rate == null || Number.isNaN(rate) ? '' : parseFloat(Number(rate).toFixed(1))
    wrap.append(span, createCopyButton(copyVal === '' ? '—' : copyVal))
    td.appendChild(wrap)
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
      const baseCells = [
        {text: row.spuid, value: row.spuid, num: false, copy: true},
        {text: row.sku, value: row.sku, num: false, copy: true},
        {text: row.category, num: false, copy: false},
      ]
      baseCells.forEach((cell) => {
        const td = document.createElement('td')
        if (cell.num) td.className = 'num'
        if (cell.copy) {
          const wrap = document.createElement('div')
          wrap.className = cell.num ? 'cell-with-copy' : 'cell-with-copy cell-with-copy-text'
          const span = document.createElement('span')
          span.textContent = cell.text
          wrap.append(span, createCopyButton(cell.value ?? cell.text))
          td.appendChild(wrap)
        } else {
          td.textContent = cell.text
        }
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
        const wrap = document.createElement('div')
        wrap.className = 'cell-with-copy'
        const span = document.createElement('span')
        span.textContent = formatNumber(m.value)
        wrap.append(span, createCopyButton(m.value))
        td.appendChild(wrap)
        tr.appendChild(td)
        appendRateCell(tr, row[`${m.key}Pop`])
        appendRateCell(tr, row[`${m.key}Yoy`])
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
    const params = new URLSearchParams()
    const start = inputToYmd(els.startDate.value)
    const end = inputToYmd(els.endDate.value)
    if (start) params.set('startDate', start)
    if (end) params.set('endDate', end)
    if (els.shop.value) params.set('shop', els.shop.value)
    els.categoryLabel.textContent = '类目加载中…'
    try {
      const res = await fetch(`/api/categories?${params}`, {cache: 'no-store'})
      const json = await res.json()
      if (token !== categoryFetchToken) return
      if (!json.ok) throw new Error(json.error || '类目加载失败')
      categoryTree = json.data || []
      const leaves = new Set(collectLeafValues(categoryTree))
      selectedCategories = new Set(Array.from(selectedCategories).filter((v) => leaves.has(v)))
      refreshCategoryView()
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
      const res = await fetch('/api/search', {
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
      renderSummary(summary, compare)
      renderTable(rows)

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
    document.body.classList.remove('modal-open')
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

      const res = await fetch('/api/upload', {
        method: 'POST',
        body: form,
        cache: 'no-store',
      })
      const json = await res.json()
      if (res.status === 401) {
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
    if (els.categorySearch) els.categorySearch.value = ''
    updateCategoryLabel()
    loadCategories()
  }

  async function init() {
    els.metaHint.textContent = '正在连接本地服务…'
    els.serverStatus.textContent = '请确认地址是 http://localhost:3780'
    els.serverStatus.className = 'empty-hint'

    try {
      const res = await fetch('/api/meta', {cache: 'no-store'})
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
    if (els.uploadModal) {
      els.uploadModal.addEventListener('click', (e) => {
        if (e.target && e.target.closest('[data-close-upload]')) {
          closeUploadModal()
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
      refreshCategoryView()
    })
    els.catClear.addEventListener('click', () => {
      if (categoryKeyword.trim()) {
        collectLeafValues(filteredCategoryTree).forEach((v) => selectedCategories.delete(v))
      } else {
        selectedCategories.clear()
      }
      refreshCategoryView()
    })

    let catTimer = 0
    const refreshCats = () => {
      window.clearTimeout(catTimer)
      catTimer = window.setTimeout(loadCategories, 280)
    }
    els.startDate.addEventListener('change', () => {
      refreshCats()
      updatePeriodHint()
    })
    els.endDate.addEventListener('change', () => {
      refreshCats()
      updatePeriodHint()
    })
    els.shop.addEventListener('change', refreshCats)
    updatePeriodHint()
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.uploadModal && !els.uploadModal.hidden) {
        closeUploadModal()
        return
      }
      if (e.key === 'Enter' && e.target.matches('input') && e.target.id !== 'categorySearch') {
        runSearch()
      }
    })
  }

  init()
})()
