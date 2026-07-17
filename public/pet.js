/**
 * 页面宠物（l2d-widget）
 * 依赖全局 L2D_WIDGET.createWidget
 * 大屏放大 canvas 实际像素（清晰）+ 按模型校准 scale；无左侧悬浮菜单
 */
; (() => {
  const STORAGE_KEY = 'dewu_pet_asleep'
  const CREATE = typeof L2D_WIDGET !== 'undefined' ? L2D_WIDGET.createWidget : null
  const MODEL_CDN = 'https://model.hacxy.cn'
  const PAGE_MAX = 1180
  const BASE_W = 220
  const BASE_H = 240
  const MAX_SCALE = 1.9
  const TRANSITION_MS = 900
  const TIP_DURATION_MS = 3800

  /** @type {ReturnType<NonNullable<typeof CREATE>> | null} */
  let widget = null
  let tipTimer = 0
  let resizeTimer = 0
  let modelIndex = 0
  let switching = false

  /**
   * 仅开场欢迎语。messages 置空后组件仍会 clear 自带 hide 定时器，
   * 因此开场结束后由 scheduleWelcomeHide 主动收起气泡。
   */
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

  /**
   * 仅保留：黑猫、小春、bilibili 22/33
   * scale 已按 Cubism2 / Cubism3 分别校准，大屏再乘 layoutScale
   */
  const MODEL_DEFS = [
    {path: '/live2d/cat-black/model.json', scale: 0.16, welcome: ['黑猫报到～', '对账我盯着']},
    {path: '/live2d/koharu/model.json', scale: 0.24, welcome: ['小春好呀', '选好日期就可以开始啦']},
    {path: `${MODEL_CDN}/bilibili-22/index.json`, scale: 0.32, welcome: ['22 来啦', '哔哩哔哩～对账加油']},
    {path: `${MODEL_CDN}/bilibili-33/index.json`, scale: 0.32, welcome: ['33 报到', '换我上场啦']},
  ]

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
    if (usable < 72) return 0
    return Math.min(MAX_SCALE, usable / BASE_W)
  }

  function petPixelSize(scale) {
    const s = scale > 0 ? scale : 1
    return {
      width: Math.round(BASE_W * s),
      height: Math.round(BASE_H * s),
    }
  }

  function shouldEnable() {
    if (!CREATE) return false
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    if (window.innerWidth < 1100) return false
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
    return document.querySelector('.dewu-pet-stage')
  }

  function findStatus() {
    return document.querySelector('.dewu-pet-status')
  }

  function currentBaseScale() {
    return MODEL_DEFS[modelIndex]?.scale ?? 0.2
  }

  /** 各模型用自身基准 scale × 布局倍率，避免只有黑猫看起来变大 */
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
      // tips 在模型上方；菜单是侧栏空容器，直接隐藏
      const style = el.getAttribute('style') || ''
      if (style.includes('bottom: calc(100%') || style.includes('bottom:calc(100%')) continue
      el.style.display = 'none'
      el.style.pointerEvents = 'none'
    }
  }

  function pinToBottomRight() {
    for (const el of document.body.children) {
      if (!(el instanceof HTMLElement)) continue
      if (el.querySelector(':scope > canvas')) {
        el.classList.add('dewu-pet-stage')
      }
    }
    window.setTimeout(() => {
      for (const el of document.body.children) {
        if (!(el instanceof HTMLElement)) continue
        if (el.classList.contains('dewu-pet-stage')) continue
        if (el.querySelector('canvas')) continue
        const style = el.getAttribute('style') || ''
        if (style.includes('z-index: 9998') || style.includes('z-index:9998')) {
          el.classList.add('dewu-pet-status')
        }
      }
      hideMenuChrome()
      applyResponsivePet()
    }, 50)
  }

  function applyResponsivePet() {
    const scale = computePetScale(getGutter())
    const visible = scale > 0
    const {width, height} = petPixelSize(scale)

    document.documentElement.style.setProperty('--dewu-pet-scale', String(scale || 0))
    document.documentElement.style.setProperty(
      '--dewu-pet-height',
      visible ? `${height}px` : '0px',
    )

    const stage = findStage()
    const status = findStatus()

    if (stage instanceof HTMLElement) {
      stage.style.zoom = ''
      stage.style.width = `${width}px`
      stage.style.height = `${height}px`
      stage.style.visibility = visible ? 'visible' : 'hidden'
      stage.style.pointerEvents = visible ? '' : 'none'
      stage.setAttribute('data-pet-scale', visible ? scale.toFixed(2) : '0')
    }
    if (status instanceof HTMLElement) {
      status.style.zoom = ''
      status.style.visibility = visible ? '' : 'hidden'
    }

    hideMenuChrome()

    if (visible) {
      requestAnimationFrame(() => {
        syncModelScale(scale)
        // Cubism3 切换后偶发需再补一次
        window.setTimeout(() => syncModelScale(scale), 80)
      })
    }
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

  /** 开场语展示结束后收起（补偿组件 E() 清掉自带 hide 定时器） */
  function scheduleWelcomeHide() {
    window.clearTimeout(tipTimer)
    tipTimer = window.setTimeout(hideTipBubble, TRANSITION_MS + TIP_DURATION_MS)
  }

  function say(text) {
    if (!text || !widget) return
    const scale = computePetScale(getGutter())
    if (scale <= 0) return
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

  function init() {
    if (widget || !shouldEnable()) return null

    const bootScale = computePetScale(getGutter())
    const bootSize = petPixelSize(bootScale > 0 ? bootScale : 1)
    const layoutBoost = bootScale > 0 ? bootScale : 1
    modelIndex = 0

    try {
      // 创建时就把布局倍率写进各模型 scale，Cubism3 首帧也够大
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
        // 空 items：不展示切换/休眠/About 等左侧悬浮菜单
        menus: {
          items: [],
        },
      })

      pinToBottomRight()
      applyResponsivePet()
      bindResize()
      scheduleWelcomeHide()
      window.setTimeout(bindCanvasCycle, 100)

      try {
        if (localStorage.getItem(STORAGE_KEY) === '1') {
          window.setTimeout(() => widget?.sleep(), 1200)
        }
      } catch (_) {}

      document.body.addEventListener(
        'click',
        (e) => {
          const t = e.target
          if (!(t instanceof Element)) return
          if ((t.textContent || '').includes('正在休息')) {
            try {
              localStorage.removeItem(STORAGE_KEY)
            } catch (_) {}
          }
        },
        true,
      )

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
      } catch (_) {}
      widget?.sleep()
    },
    get widget() {
      return widget
    },
  }
})()
