/* =========================================================================
   E2E-проверка CHARGE через Chrome DevTools Protocol.
   Запуск: node scripts/e2e-check.mjs [baseUrl]
   ========================================================================= */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.argv[2] || 'http://127.0.0.1:4173'
const PORT = 9333

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
]
const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!chromePath) {
  console.error('Chrome/Edge не найден')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'charge-e2e-'))
const child = spawn(
  chromePath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    '--window-size=1440,900',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const cleanup = () => {
  try { child.kill() } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })

let ws
let msgId = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []

function send(method, params = {}) {
  const id = ++msgId
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await res.json()
      const page = targets.find((t) => t.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch {}
    await sleep(250)
  }
  throw new Error('Не удалось подключиться к Chrome DevTools')
}

const url = await connect()
ws = new WebSocket(url)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`))
    else resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    consoleErrors.push(
      (msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' '),
    )
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails
    pageErrors.push(d.exception?.description || d.text)
  }
})

await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')

async function goto(path) {
  await send('Page.navigate', { url: BASE + path })
  await sleep(1500)
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    throw new Error(
      'eval error: ' + (res.exceptionDetails.exception?.description || res.exceptionDetails.text),
    )
  }
  return res.result.value
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail ?? null })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + JSON.stringify(detail) : ''}`)
}

const clickByText = (text, scope = '') =>
  evaluate(`
    const els = Array.from(document.querySelectorAll(${JSON.stringify(scope + ' button, ' + scope + ' a')}));
    const el = els.find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
    if (el) { el.click(); return true; }
    return false;
  `)

/* ======================= 1. Главная ======================= */
await goto('/')
check(
  'home: рендерится hero и заголовок',
  await evaluate(`return !!document.querySelector('.home-hero__title') && document.title.includes('CHARGE')`),
)
check(
  'home: полоса марок на месте',
  await evaluate(`return document.querySelectorAll('.brand-rail__item').length === 14`),
)

/* ======================= 2. Навигация ======================= */
await goto('/cars')
const brandCount = await evaluate(`return document.querySelectorAll('.brand-card').length`)
check('nav: /cars открывается по прямой ссылке, 14 марок', brandCount === 14, { brandCount })

await goto('/cars/bmw')
const modelCount = await evaluate(`return document.querySelectorAll('.model-card').length`)
check('nav: страница марки BMW с моделями', modelCount >= 3, { modelCount })

/* ======================= 3. Корзина: добавление ======================= */
await goto('/configure')
await evaluate(`
  const b = document.querySelector('.service-card button.chip-btn');
  if (b) b.click();
`)
await sleep(600)
const badge = await evaluate(`return document.querySelector('.icon-btn__badge')?.textContent.trim()`)
check('cart: услуга добавлена (счётчик в шапке)', badge === '1', { badge })

const inCart = await evaluate(
  `return Array.from(document.querySelectorAll('.service-card button.chip-btn')).some(b => b.textContent.includes('В корзине'))`,
)
check('cart: кнопка карточки переключилась в «В корзине»', inCart)

/* ======================= 4. Корзина ======================= */
await goto('/cart')
const cartInfo = await evaluate(`
  const lines = document.querySelectorAll('.cart-lines .line-item');
  const total = document.querySelector('.cart-summary__total strong')?.textContent.trim() || '';
  return { lines: lines.length, total: total };
`)
check('cart: позиции перенесены на страницу корзины', cartInfo.lines === 1, cartInfo)
check('cart: рассчитана сумма', /\d/.test(cartInfo.total), { total: cartInfo.total })

/* ======================= 5. Сохранение после перезагрузки ======================= */
await goto('/cart')
const afterReload = await evaluate(`return document.querySelectorAll('.cart-lines .line-item').length`)
check('cart: выбор сохраняется после перезагрузки страницы', afterReload === 1, { afterReload })

/* ======================= 6. Пошаговая заявка ======================= */
await clickByText('Оставить заявку', '.cart-summary')
await sleep(900)
const wizardOpen = await evaluate(`
  const m = document.querySelector('.modal');
  return { open: !!m && m.classList.contains('is-open'), steps: document.querySelectorAll('.steps-bar__item').length };
`)
check('wizard: модальное окно заявки открывается', wizardOpen.open && wizardOpen.steps === 3, wizardOpen)

const modelCards = await evaluate(`return document.querySelectorAll('.wiz-modelcard').length`)
check('wizard: доступны все модели всех марок с фото', modelCards >= 45, { modelCards })

/* --- Шаг 1: модель --- */
await evaluate(`
  const m = Array.from(document.querySelectorAll('.wiz-modelcard')).find(x => x.textContent.includes('Porsche'));
  if (m) m.click();
`)
await sleep(500)
await clickByText('Далее', '.modal__foot')
await sleep(700)
const step2 = await evaluate(`
  return { services: document.querySelectorAll('.wiz-service').length, sub: document.querySelector('.modal__sub')?.textContent.trim() };
`)
check('wizard: шаг 1 (автомобиль) → шаг 2 (услуги)', step2.services >= 8, step2)

/* --- Шаг 2: услуги --- */
await evaluate(`
  const s = document.querySelector('.wiz-service:not(.is-active)');
  if (s) s.click();
`)
await sleep(400)
await clickByText('Далее', '.modal__foot')
await sleep(700)
const step3 = await evaluate(`
  return {
    hasName: !!document.getElementById('wiz-name'),
    hasPhone: !!document.getElementById('wiz-phone'),
    hasDate: !!document.getElementById('wiz-date'),
    hasTime: !!document.getElementById('wiz-time'),
    hasComment: !!document.getElementById('wiz-comment'),
  };
`)
check(
  'wizard: шаг 3 содержит имя, телефон, дату, время и комментарий',
  step3.hasName && step3.hasPhone && step3.hasDate && step3.hasTime && step3.hasComment,
  step3,
)

/* --- Неверный телефон --- */
await evaluate(`
  const el = document.getElementById('wiz-phone');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, '123');
  el.dispatchEvent(new Event('input', { bubbles: true }));
`)
await sleep(300)
await clickByText('Отправить', '.modal__foot')
await sleep(600)
const phoneErr = await evaluate(`return document.querySelector('.modal .field__error')?.textContent.trim() || ''`)
check('wizard: неверный телефон отклоняется с понятной ошибкой', phoneErr.length > 0, { phoneErr })

/* --- Верный телефон --- */
await evaluate(`
  const el = document.getElementById('wiz-phone');
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(el, '+7 999 123-45-67');
  el.dispatchEvent(new Event('input', { bubbles: true }));
`)
await sleep(300)
await clickByText('Отправить', '.modal__foot')
await sleep(1800)
const demo = await evaluate(`
  const n = document.querySelector('.modal .notice');
  return n ? n.textContent.replace(/\\s+/g, ' ').trim() : '';
`)
check(
  'wizard: заявка обработана и честно помечена как демо-режим',
  /Демонстрационный режим/i.test(demo) && /не отправлена/i.test(demo),
  { demo: demo.slice(0, 130) },
)

await clickByText('Готово', '.modal__foot')
await sleep(600)

/* --- Автомобиль попал в корзину --- */
await goto('/cart')
const vehicle = await evaluate(`
  const pill = Array.from(document.querySelectorAll('.pill')).find(p => p.textContent.includes('Автомобиль'));
  return pill ? pill.textContent.trim() : null;
`)
check('cart: выбранный автомобиль перенесён в корзину', /Porsche/.test(vehicle || ''), { vehicle })

/* ======================= 7. Удаление услуг ======================= */
const beforeRemove = await evaluate(`return document.querySelectorAll('.cart-lines .line-item').length`)
for (let i = 0; i < 8; i++) {
  const removed = await evaluate(`
    const rm = Array.from(document.querySelectorAll('.line-item__remove')).find(b => b.textContent.trim() === 'Удалить');
    if (rm) { rm.click(); return true; }
    return false;
  `)
  if (!removed) break
  await sleep(500)
}
const afterRemove = await evaluate(
  `return { lines: document.querySelectorAll('.cart-lines .line-item').length, empty: !!document.querySelector('.cart-empty') }`,
)
check(
  'cart: услуги удаляются, показывается пустое состояние',
  afterRemove.lines === 0 && afterRemove.empty && beforeRemove > 0,
  { beforeRemove, ...afterRemove },
)

/* ======================= 8. Полоса марок: колесо едет ======================= */
await goto('/cars')
await sleep(700)
const railBefore = await evaluate(`return document.querySelector('.brand-rail__marker')?.style.transform || null`)
await evaluate(`
  const card = Array.from(document.querySelectorAll('.brand-card')).find(c => (c.getAttribute('aria-label') || '').includes('Lamborghini'));
  if (card) card.click();
`)
await sleep(1600)
const railAfter = await evaluate(`return document.querySelector('.brand-rail__marker')?.style.transform || null`)
check(
  'rail: колесо перемещается к выбранной марке',
  railBefore !== null && railAfter !== null && railBefore !== railAfter,
  { before: railBefore, after: railAfter },
)

/* ======================= 9. Страница марки: без «Ваш автомобиль», есть «+» ======================= */
await goto('/cars/bmw')
const brandPage = await evaluate(`
  return {
    hasPicker: !!document.querySelector('.picker'),
    hasPickerHeading: Array.from(document.querySelectorAll('h2, p')).some(e => (e.textContent || '').trim() === 'Ваш автомобиль'),
    plusTiles: document.querySelectorAll('.model-plus-tile').length,
    writeButtons: Array.from(document.querySelectorAll('button')).filter(b => (b.textContent || '').trim() === 'Запишитесь').length,
    models: document.querySelectorAll('.model-card').length
  };
`)
check(
  'brand page: блок «Ваш автомобиль / модели» удалён',
  !brandPage.hasPicker && !brandPage.hasPickerHeading,
  brandPage,
)
check('brand page: плитка «+» в конце списка моделей', brandPage.plusTiles === 1, brandPage)
check('brand page: кнопка «Запишитесь» на странице', brandPage.writeButtons >= 1, brandPage)

await evaluate(`document.querySelector('.model-plus-tile').click()`)
await sleep(900)
const customWizard = await evaluate(`
  const m = document.querySelector('.modal');
  return {
    open: !!m && m.classList.contains('is-open'),
    ownModelField: !!document.getElementById('wiz-custom'),
    hasModelGrid: !!document.querySelector('.wiz-modelgrid'),
    step: document.querySelector('.modal__sub')?.textContent.trim()
  };
`)
check(
  'brand page: «+» открывает окно заявки, где шаг 1 — «Своя модель»',
  customWizard.open && customWizard.ownModelField && !customWizard.hasModelGrid,
  customWizard,
)
await evaluate(`document.querySelector('.modal__close')?.click()`)
await sleep(500)

/* ======================= 10. Полоса марок: стрелка и стрелки прокрутки ======================= */
await goto('/cars')
await sleep(800)
const rail = await evaluate(`
  const m = document.querySelector('.brand-rail__marker');
  const nav = document.querySelectorAll('.brand-rail__nav');
  return {
    marker: !!m,
    markerIsWheel: !!(m && m.querySelector('svg')),
    navCount: nav.length,
    scrollW: document.querySelector('.brand-rail__viewport')?.scrollWidth || 0,
    clientW: document.querySelector('.brand-rail__viewport')?.clientWidth || 0
  };
`)
check('rail: указатель — стрелка, а не колесо', rail.marker && !rail.markerIsWheel, rail)
check('rail: есть стрелки прокрутки влево/вправо', rail.navCount === 2, rail)

await evaluate(`
  const next = Array.from(document.querySelectorAll('.brand-rail__nav')).find(b => (b.getAttribute('aria-label') || '').includes('правее'));
  if (next) next.click();
`)
await sleep(1400)
const scrolled = await evaluate(`
  const vp = document.querySelector('.brand-rail__viewport');
  const tesla = Array.from(document.querySelectorAll('.brand-rail__item')).find(b => b.textContent.trim() === 'Tesla');
  const vpRect = vp.getBoundingClientRect();
  const tRect = tesla.getBoundingClientRect();
  return { scrollLeft: Math.round(vp.scrollLeft), teslaVisible: tRect.left >= vpRect.left - 10 && tRect.right <= vpRect.right + 10 };
`)
check('rail: стрелка вправо прокручивает полосу, появляется TESLA', scrolled.scrollLeft > 20 && scrolled.teslaVisible, scrolled)

/* ======================= 11. Плитка «+» и «своя модель» ======================= */
await goto('/')
const plusExists = await evaluate(`
  const b = document.querySelector('.plus-action');
  return { exists: !!b, hasEmoji: !!b && /[\\u{1F500}-\\u{1FAFF}\\u{2B00}-\\u{2BFF}]/u.test(b.textContent || '') };
`)
check('plus: плитка «+» есть на странице и это не эмодзи', plusExists.exists && !plusExists.hasEmoji, plusExists)
await evaluate(`document.querySelector('.plus-action').click()`)
await sleep(800)
const plusOpens = await evaluate(`return !!document.querySelector('.modal.is-open')`)
check('plus: нажатие на «+» открывает окно заявки', plusOpens)
await evaluate(`document.querySelector('.modal__close').click()`)
await sleep(500)

await goto('/cart')
await clickByText('Оставить заявку', '.cart-summary')
await sleep(800)
const customTile = await evaluate(`return !!document.querySelector('.wiz-modelcard--custom')`)
check('wizard: есть плитка «Своя модель»', customTile)
await evaluate(`document.querySelector('.wiz-modelcard--custom').click()`)
await sleep(500)
const customInput = await evaluate(`
  const el = document.getElementById('wiz-custom');
  return { visible: !!el, label: document.querySelector('.field__label[for="wiz-custom"]')?.textContent.trim() };
`)
check('wizard: плитка открывает поле «Своя модель»', customInput.visible && /своя модель/i.test(customInput.label || ''), customInput)

/* ======================= 10. Мягкий переход между страницами ======================= */
await goto('/cars')
const pageClass = await evaluate(`return document.querySelector('main.page')?.className || ''`)
const anim = await evaluate(`
  const m = document.querySelector('main.page');
  return m ? getComputedStyle(m).animationName : '';
`)
check('transition: мягкая анимация перехода присутствует', /page-fade/.test(anim), { pageClass, anim })

/* ======================= 10. Вращение диска ======================= */
await goto('/')
const angle1 = await evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--wheel-angle')`)
await sleep(1400)
const angle2 = await evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--wheel-angle')`)
check(
  'wheel: диск вращается (угол меняется)',
  angle1 !== angle2 && parseFloat(angle2) !== parseFloat(angle1),
  { angle1: angle1.trim(), angle2: angle2.trim() },
)

await goto('/services')
const angle3 = await evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--wheel-angle')`)
check(
  'wheel: вращение продолжается после смены страницы',
  parseFloat(angle3) !== parseFloat(angle2),
  { before: angle2.trim(), after: angle3.trim() },
)

/* ======================= 11. Мобильный viewport (390px) ======================= */
await send('Emulation.setDeviceMetricsOverride', {
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true,
})
await goto('/')
const mobileState = await evaluate(`
  const b = document.querySelector('.burger');
  const d = document.documentElement;
  return {
    burgerVisible: !!b && getComputedStyle(b).display !== 'none',
    navHidden: getComputedStyle(document.querySelector('.nav')).display === 'none',
    scrollW: d.scrollWidth,
    clientW: d.clientWidth,
    bodyScrollW: document.body.scrollWidth
  };
`)
check('mobile: бургер показан, основная навигация скрыта', mobileState.burgerVisible && mobileState.navHidden, mobileState)
check(
  'mobile: нет горизонтального переполнения',
  mobileState.scrollW <= mobileState.clientW + 1 && mobileState.bodyScrollW <= mobileState.clientW + 1,
  mobileState,
)

await evaluate(`document.querySelector('.burger').click()`)
await sleep(900)
const menuState = await evaluate(`
  const m = document.querySelector('.mobile-menu');
  return {
    open: m ? m.classList.contains('is-open') : false,
    links: m ? m.querySelectorAll('.mobile-menu__link').length : 0,
    visible: m ? getComputedStyle(m).visibility : 'none'
  };
`)
check('mobile: меню открывается и содержит пункты навигации', menuState.open && menuState.links >= 6 && menuState.visible === 'visible', menuState)

await evaluate(`document.querySelector('.mobile-menu__link').click()`)
await sleep(900)
const afterNav = await evaluate(`return location.pathname`)
check('mobile: переход по пункту мобильного меню работает', afterNav === '/', { afterNav })

const mobileRoutes = ['/', '/services', '/services/ppf', '/cars', '/cars/bmw', '/works', '/about', '/contacts', '/cart', '/configure']
const overflow = []
for (const r of mobileRoutes) {
  await goto(r)
  const o = await evaluate(`return { s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth, b: document.body.scrollWidth }`)
  if (Math.max(o.s, o.b) > o.c + 1) overflow.push({ route: r, ...o })
}
check('mobile: горизонтального переполнения нет ни на одной странице', overflow.length === 0, overflow)

await send('Emulation.clearDeviceMetricsOverride')

/* ======================= 12. Ошибки консоли ======================= */
check(
  'console: нет ошибок и исключений на страницах',
  consoleErrors.length === 0 && pageErrors.length === 0,
  { consoleErrors: consoleErrors.slice(0, 5), pageErrors: pageErrors.slice(0, 5) },
)

/* ---------- Итог ---------- */
const failed = results.filter((r) => !r.pass)
console.log('\n=============================================')
console.log(`Проверок: ${results.length}  ·  Успешно: ${results.length - failed.length}  ·  Провалено: ${failed.length}`)
console.log('=============================================')
if (failed.length) {
  failed.forEach((f) => console.log(`  FAIL: ${f.name} ${JSON.stringify(f.detail ?? '')}`))
  process.exitCode = 1
}
cleanup()
process.exit(process.exitCode || 0)
