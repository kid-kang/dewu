/**
 * 页面宠物（l2d-widget）
 * 依赖全局 L2D_WIDGET.createWidget
 * 尺寸随主内容区两侧留白自适应，尽量不压到对账区域
 */
; (() => {
  const STORAGE_KEY = 'dewu_pet_asleep'
  const CREATE = typeof L2D_WIDGET !== 'undefined' ? L2D_WIDGET.createWidget : null
  const MODEL_CDN = 'https://model.hacxy.cn'
  const PAGE_MAX = 1180
  const BASE_W = 220
  const BASE_H = 240

  /** @type {ReturnType<NonNullable<typeof CREATE>> | null} */
  let widget = null
  let tipTimer = 0
  let resizeTimer = 0

  const tipsShared = {
    welcomeMessage: [
      '玄冬对账台就位～',
      '选好日期，我帮你盯着数',
      '大店小店，一起核对！',
    ],
    messages: [
      '单日 / 整周 / 整月可看环比同比',
      '得物推数据在明细最右侧',
      '导出前先完成一次对账哦',
      '喝口水再对，眼睛谢谢你',
      '类目筛选记得保存常用配置',
      '点我旁边菜单可以换形象',
    ],
    duration: 3800,
    interval: 14000,
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

  function model(path, scale, welcomeMessage, offset = [0, 0.1]) {
    return {
      path,
      scale,
      offset,
      tips: welcomeMessage
        ? {...tipsShared, welcomeMessage}
        : tipsShared,
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

  /**
   * 按右侧留白算缩放：塞进 gutter，大屏可放大，小屏缩小或隐藏
   * 24"≈1920 → 约 1.5~1.65；笔记本窄边距 → 0.4~0.7 或隐藏
   */
  function computePetScale(gutter) {
    const edge = 12
    const usable = gutter - edge
    if (usable < 72) return 0
    return Math.min(1.65, usable / BASE_W)
  }

  function shouldEnable() {
    if (!CREATE) return false
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false
    // 太窄直接不加载；稍宽但仍几乎无边距时由 scale=0 隐藏
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
      applyResponsivePet()
    }, 50)
  }

  function applyResponsivePet() {
    const scale = computePetScale(getGutter())
    document.documentElement.style.setProperty('--dewu-pet-scale', String(scale || 0))

    const stage = findStage()
    const status = findStatus()
    const visible = scale > 0

    if (stage instanceof HTMLElement) {
      stage.style.zoom = visible ? String(scale) : '1'
      stage.style.visibility = visible ? 'visible' : 'hidden'
      stage.style.pointerEvents = visible ? '' : 'none'
      stage.setAttribute('data-pet-scale', visible ? scale.toFixed(2) : '0')
    }
    if (status instanceof HTMLElement) {
      status.style.zoom = visible ? String(Math.min(scale, 1)) : '1'
      status.style.visibility = visible ? '' : 'hidden'
    }
  }

  function say(text) {
    if (!text || !widget) return
    const scale = computePetScale(getGutter())
    if (scale <= 0) return
    const span = findTipsSpan()
    if (!span) return
    const bubble = span.parentElement
    if (!(bubble instanceof HTMLElement)) return
    span.textContent = text
    bubble.style.opacity = '1'
    bubble.style.animation = 'l2dw-tips-in 0.35s ease-out forwards'
    window.clearTimeout(tipTimer)
    tipTimer = window.setTimeout(() => {
      bubble.style.opacity = '0'
    }, 3600)
  }

  function bindResize() {
    window.addEventListener('resize', () => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => {
        applyResponsivePet()
      }, 120)
    })
  }

  function init() {
    if (widget || !shouldEnable()) return null

    try {
      widget = CREATE({
        position: 'bottom-right',
        size: {width: BASE_W, height: BASE_H},
        primaryColor: 'rgba(26, 95, 122, 0.92)',
        transitionDuration: 900,
        transitionType: 'slide',
        model: [
          model('/live2d/cat-black/model.json', 0.12, ['黑猫报到～', '对账我盯着']),
          model(`${MODEL_CDN}/Wanko/Wanko.model3.json`, 0.14, ['汪！小狗上线', '今天也要认真对账']),
          model(`${MODEL_CDN}/Senko_Normals/senko.model3.json`, 0.08, ['仙狐来帮忙了', '累了就歇一会儿吧']),
          model(`${MODEL_CDN}/Hiyori/Hiyori.model3.json`, 0.08, ['Hiyori 来了', '一起把数字对清楚']),
          model(`${MODEL_CDN}/Mao/Mao.model3.json`, 0.08, ['Mao 就位', '看板数据我陪你看']),
          model('/live2d/koharu/model.json', 0.14, ['小春好呀', '选好日期就可以开始啦']),
          model(`${MODEL_CDN}/HK416-1-normal/model.json`, 0.08, ['HK416 待命', '任务开始了吗？']),
          model(`${MODEL_CDN}/bilibili-22/index.json`, 0.11, ['22 来啦', '哔哩哔哩～对账加油']),
          model(`${MODEL_CDN}/bilibili-33/index.json`, 0.11, ['33 报到', '换我上场啦']),
        ],
        menus: {
          align: 'left',
          extraItems: [
            {
              icon: 'mdi:eye-off-outline',
              label: '收起宠物',
              onClick: (w) => {
                try {
                  localStorage.setItem(STORAGE_KEY, '1')
                } catch (_) {}
                w.sleep()
              },
            },
          ],
        },
      })

      pinToBottomRight()
      applyResponsivePet()
      bindResize()

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
