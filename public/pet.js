/**
 * 页面宠物（l2d-widget）
 * 依赖全局 L2D_WIDGET.createWidget
 * 固定右下角；模型加载失败/超时也会强制露出舞台，避免「一直没有宠物」
 */
; (() => {
  const STORAGE_KEY = 'dewu_pet_asleep'
  const MODEL_CDN = 'https://model.hacxy.cn'
  const PAGE_MAX = 1180
  const BASE_W = 220
  const BASE_H = 240
  const MAX_SCALE = 1.9
  const TRANSITION_MS = 900
  const TIP_DURATION_MS = 3800
  const FORCE_SHOW_MS = 2500

  /** @type {any} */
  let widget = null
  let tipTimer = 0
  let resizeTimer = 0
  let forceShowTimer = 0
  let modelIndex = 0
  let switching = false
  let initTried = false

  const tipsShared = {
    messages: [],
    duration: TIP_DURATION_MS,
    interval: 2147483647,
    typing: {
      speed: 90,
    },
    style: {
      background: 'rgba(26, 95, 122, 0.94)',
      borderRadius: '6px',
      fontFamily: '"Figtree", "Segoe UI", sans-serif',
      fontSize: '12px',
      maxWidth: '220px',
      whiteSpace: 'normal',
    },
  }

  const MODEL_DEFS = [
    {path: '/live2d/cat-black/model.json', scale: 0.16, welcome: ['黑猫报到～', '对账我盯着']},
    {path: '/live2d/koharu/model.json', scale: 0.24, welcome: ['小春好呀', '选好日期就可以开始啦']},
    {path: `${MODEL_CDN}/bilibili-22/index.json`, scale: 0.32, welcome: ['22 来啦', '哔哩哔哩～对账加油']},
    {path: `${MODEL_CDN}/bilibili-33/index.json`, scale: 0.32, welcome: ['33 报到', '换我上场啦']},
  ]

  function getCreate() {
    return typeof window.L2D_WIDGET !== 'undefined' && typeof window.L2D_WIDGET.createWidget === 'function'
      ? window.L2D_WIDGET.createWidget
      : null
  }

  function model(def) {
    return {
      path: def.path,
      scale: def.scale,
      offset: [0, 0.08],
      tips: {...tipsShared, welcomeMessage: def.welcome},
    }
  }

  function getGutter() {
    const vw = window.innerWidth
    const page = document.querySelector('.page')
    const pageWidth = page
      ? page.getBoundingClientRect().width
      : Math.min(PAGE_MAX, Math.max(0, vw - 32))
    return Math.max(0, (vw - pageWidth) / 2)
  }

  function computePetScale(gutter) {
    const edge = 8
    const usable = gutter - edge
    if (usable < 72) return 0.72
    return Math.min(MAX_SCALE, Math.max(0.72, usable / BASE_W))
  }

  function petPixelSize(scale) {
    const s = scale > 0 ? scale : 1
    return {
      width: Math.round(BASE_W * s),
      height: Math.round(BASE_H * s),
    }
  }

  function shouldEnable() {
    if (!getCreate()) return false
    // 窄屏不加载；不再因 prefers-reduced-motion 整宠禁用（Win 常开「减少动画」）
    if (window.innerWidth < 720) return false
    return true
  }

  function findTipsSpan() {
    const stages = Array.from(document.body.children).filter(
      (el) => el instanceof HTMLElement && el.querySelector('canvas'),
    )
    for (const stage of stages) {
      const span = stage.querySelector('div span')
      if (span) return span
    }
    return null
  }

  function findStage() {
    const marked = document.querySelector('.dewu-pet-stage')
    if (marked) return marked
    for (const el of document.body.children) {
      if (!(el instanceof HTMLElement)) continue
      if (el.querySelector(':scope > canvas')) {
        el.classList.add('dewu-pet-stage')
        return el
      }
    }
    return null
  }

  function findStatus() {
    const marked = document.querySelector('.dewu-pet-status')
    if (marked) return marked
    for (const el of document.body.children) {
      if (!(el instanceof HTMLElement)) continue
      if (el.classList.contains('dewu-pet-stage')) continue
      if (el.querySelector('canvas')) continue
      const style = el.getAttribute('style') || ''
      if (style.includes('z-index: 9998') || style.includes('z-index:9998')) {
        el.classList.add('dewu-pet-status')
        return el
      }
    }
    return null
  }

  function currentBaseScale() {
    return MODEL_DEFS[modelIndex]?.scale ?? 0.2
  }

  function syncModelScale(layoutScale) {
    const l2d = widget?.l2d
    if (!l2d || typeof l2d.setScale !== 'function') return
    const s = layoutScale > 0 ? layoutScale : 1
    l2d.setScale(currentBaseScale() * s)
    if (typeof l2d.resize === 'function') {
      l2d.resize()
    }
  }

  function hideMenuChrome() {
    const stage = findStage()
    if (!(stage instanceof HTMLElement)) return
    for (const el of stage.children) {
      if (!(el instanceof HTMLElement)) continue
      if (el.tagName === 'CANVAS') continue
      const style = el.getAttribute('style') || ''
      if (style.includes('bottom: calc(100%') || style.includes('bottom:calc(100%')) continue
      el.style.display = 'none'
      el.style.pointerEvents = 'none'
    }
  }

  /** 组件默认 translateY(130%)，仅在 model loaded 后滑入；加载失败会一直藏着 */
  function forceShowStage() {
    const stage = findStage()
    if (!(stage instanceof HTMLElement)) return false
    stage.classList.add('dewu-pet-stage')
    stage.style.transform = 'translateY(0)'
    stage.style.opacity = '1'
    stage.style.visibility = 'visible'
    stage.style.pointerEvents = ''
    stage.style.zIndex = '9999'
    return true
  }

  function pinToBottomRight() {
    findStage()
    window.setTimeout(() => {
      findStatus()
      hideMenuChrome()
      applyResponsivePet()
      forceShowStage()
    }, 50)
  }

  function applyResponsivePet() {
    const scale = computePetScale(getGutter())
    const {width, height} = petPixelSize(scale)

    document.documentElement.style.setProperty('--dewu-pet-scale', String(scale || 0))
    document.documentElement.style.setProperty('--dewu-pet-height', `${height}px`)

    const stage = findStage()
    const status = findStatus()

    if (stage instanceof HTMLElement) {
      stage.style.zoom = ''
      stage.style.width = `${width}px`
      stage.style.height = `${height}px`
      stage.style.visibility = 'visible'
      stage.style.pointerEvents = ''
      stage.style.transform = 'translateY(0)'
      stage.style.opacity = '1'
      stage.setAttribute('data-pet-scale', scale.toFixed(2))
    }
    if (status instanceof HTMLElement) {
      status.style.zoom = ''
      status.style.visibility = ''
    }

    hideMenuChrome()

    requestAnimationFrame(() => {
      syncModelScale(scale)
      window.setTimeout(() => syncModelScale(scale), 80)
    })
  }

  function findTipBubble() {
    const span = findTipsSpan()
    const bubble = span?.parentElement
    return bubble instanceof HTMLElement ? bubble : null
  }

  function hideTipBubble() {
    const bubble = findTipBubble()
    if (!bubble) return
    bubble.style.animation = 'none'
    bubble.style.opacity = '1'
    bubble.offsetHeight
    bubble.style.transition = 'opacity 0.25s ease, transform 0.25s ease'
    bubble.style.opacity = '0'
    bubble.style.transform = 'translateY(6px)'
    window.setTimeout(() => {
      bubble.style.transition = 'none'
      bubble.style.transform = ''
    }, 260)
  }

  function scheduleWelcomeHide() {
    window.clearTimeout(tipTimer)
    tipTimer = window.setTimeout(hideTipBubble, TRANSITION_MS + TIP_DURATION_MS)
  }

  function say(text) {
    if (!text || !widget) return
    const span = findTipsSpan()
    const bubble = findTipBubble()
    if (!span || !bubble) return
    span.textContent = text
    bubble.style.opacity = '1'
    bubble.style.animation = 'l2dw-tips-in 0.35s ease-out forwards'
    window.clearTimeout(tipTimer)
    tipTimer = window.setTimeout(hideTipBubble, TIP_DURATION_MS)
  }

  function bindResize() {
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        applyResponsivePet()
        forceShowStage()
      }, 120)
    })
  }

  async function cycleModel() {
    if (!widget || switching || MODEL_DEFS.length < 2) return
    switching = true
    try {
      modelIndex = (modelIndex + 1) % MODEL_DEFS.length
      await widget.switchModel(modelIndex)
      hideMenuChrome()
      applyResponsivePet()
      forceShowStage()
      scheduleWelcomeHide()
    } catch (err) {
      console.warn('[pet] 切换模型失败', err)
    } finally {
      switching = false
    }
  }

  function bindCanvasCycle() {
    const stage = findStage()
    const canvas = stage?.querySelector(':scope > canvas')
    if (!(canvas instanceof HTMLCanvasElement)) return
    canvas.style.cursor = 'pointer'
    canvas.title = '点击切换形象'
    canvas.addEventListener('click', () => {
      cycleModel()
    })
  }

  function bindModelLoaded() {
    const l2d = widget?.l2d
    if (!l2d || typeof l2d.on !== 'function') return
    l2d.on('loaded', () => {
      forceShowStage()
      applyResponsivePet()
    })
  }

  function init() {
    if (widget) return widget
    if (!shouldEnable()) {
      if (!getCreate()) {
        console.warn('[pet] L2D_WIDGET.createWidget 不可用')
      }
      return null
    }
    if (initTried && !widget) {
      // 允许短暂重试（脚本偶发未就绪）
    }
    initTried = true

    const CREATE = getCreate()
    if (!CREATE) return null

    const bootScale = computePetScale(getGutter())
    const bootSize = petPixelSize(bootScale)
    const layoutBoost = bootScale
    modelIndex = 0

    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch (_) { /* ignore */ }

    try {
      const models = MODEL_DEFS.map((def) => {
        const m = model(def)
        m.scale = def.scale * layoutBoost
        return m
      })

      widget = CREATE({
        position: 'bottom-right',
        size: bootSize,
        primaryColor: 'rgba(26, 95, 122, 0.92)',
        transitionDuration: TRANSITION_MS,
        transitionType: 'slide',
        model: models,
        menus: {
          items: [],
        },
      })

      pinToBottomRight()
      applyResponsivePet()
      forceShowStage()
      bindResize()
      bindModelLoaded()
      scheduleWelcomeHide()
      window.setTimeout(bindCanvasCycle, 100)

      window.clearTimeout(forceShowTimer)
      forceShowTimer = window.setTimeout(() => {
        if (!forceShowStage()) {
          console.warn('[pet] 舞台未找到，模型可能加载失败')
        } else {
          applyResponsivePet()
        }
      }, FORCE_SHOW_MS)

      // 再补几次，覆盖异步挂载 canvas 的情况
      ;[200, 600, 1200].forEach((ms) => {
        window.setTimeout(() => {
          findStage()
          forceShowStage()
          applyResponsivePet()
          bindCanvasCycle()
        }, ms)
      })

      return widget
    } catch (err) {
      console.warn('[pet] 初始化失败', err)
      widget = null
      return null
    }
  }

  window.DewuPet = {
    init,
    say,
    sleep() {
      try {
        localStorage.setItem(STORAGE_KEY, '1')
      } catch (_) { /* ignore */ }
      widget?.sleep()
    },
    get widget() {
      return widget
    },
  }

  // 不依赖 app.js 时序：脚本就绪后自行拉起
  function boot() {
    try {
      init()
    } catch (err) {
      console.warn('[pet] 自动初始化失败', err)
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, {once: true})
  } else {
    boot()
  }
})()
