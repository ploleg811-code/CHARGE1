/* =========================================================================
   Проверка standalone-сборки, открытой напрямую через file://
   (без веб-сервера). Запуск:
     node scripts/standalone-check.mjs
   ========================================================================= */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const INDEX = resolve(process.argv[2] || 'dist-standalone/index.html')
if (!existsSync(INDEX)) {
  console.error('Не найден ' + INDEX + ' — сначала выполните npm run build:standalone')
  process.exit(1)
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
const PORT = 9355
const userDataDir = mkdtempSync(join(tmpdir(), 'charge-standalone-'))
const child = spawn(
  CHROME,
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
process.on('exit', () => { try { child.kill() } catch {} })

let ws
let id = 0
const pending = new Map()
const errors = []
const send = (method, params = {}) => {
  const n = ++id
  ws.send(JSON.stringify({ id: n, method, params }))
  return new Promise((res, rej) => pending.set(n, { res, rej }))
}

let wsUrl
for (let i = 0; i < 60; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
    const page = list.find((t) => t.type === 'page')
    if (page?.webSocketDebuggerUrl) { wsUrl = page.webSocketDebuggerUrl; break }
  } catch {}
  await sleep(250)
}
ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  }
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
  }
})
await send('Page.enable')
await send('Runtime.enable')

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text)
  return res.result.value
}

const results = []
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ::  ' + JSON.stringify(detail) : ''}`)
}

const fileUrl = pathToFileURL(INDEX).href
await send('Page.navigate', { url: fileUrl })
await sleep(2500)

const boot = await evaluate(`
  return {
    protocol: location.protocol,
    title: document.title,
    hero: !!document.querySelector('.home-hero__title'),
    wheel: !!document.querySelector('.wheel svg'),
    hintShown: !!document.querySelector('body > div[style*="z-index:99999"]'),
    fontLoaded: document.fonts.check('700 40px Unbounded')
  };
`)
check('standalone: приложение запустилось по file://', boot.hero && boot.wheel, boot)
check('standalone: подсказка «нужен сервер» не показывается', !boot.hintShown, { hintShown: boot.hintShown })
check('standalone: шрифт Unbounded загрузился', boot.fontLoaded === true, { fontLoaded: boot.fontLoaded })

// Навигация через HashRouter (ссылки имеют вид #/cars)
await evaluate(`
  const link = Array.from(document.querySelectorAll('a')).find(a => (a.getAttribute('href') || '').replace('#', '') === '/cars');
  if (link) link.click();
`)
await sleep(1200)
const cars = await evaluate(`
  return { hash: location.hash, cards: document.querySelectorAll('.brand-card').length };
`)
check('standalone: навигация работает (hash-роут /cars)', cars.hash === '#/cars' && cars.cards === 14, cars)

// Корзина
await evaluate(`
  const link = Array.from(document.querySelectorAll('a')).find(a => (a.getAttribute('href') || '').replace('#', '') === '/configure');
  if (link) link.click();
`)
await sleep(1200)
await evaluate(`
  const b = document.querySelector('.service-card button.chip-btn');
  if (b) b.click();
`)
await sleep(600)
const badge = await evaluate(`return document.querySelector('.icon-btn__badge')?.textContent.trim()`)
check('standalone: корзина работает', badge === '1', { badge })

await evaluate(`
  const link = Array.from(document.querySelectorAll('a')).find(a => (a.getAttribute('href') || '').replace('#', '') === '/cart');
  if (link) link.click();
`)
await sleep(1200)
const cart = await evaluate(`
  return {
    hash: location.hash,
    lines: document.querySelectorAll('.cart-lines .line-item').length,
    storage: !!localStorage.getItem('charge:cart')
  };
`)
check('standalone: корзина и localStorage работают', cart.lines === 1 && cart.storage, cart)

check('standalone: нет исключений в консоли', errors.length === 0, errors.slice(0, 3))

const failed = results.filter((r) => !r.pass)
console.log('\n=============================================')
console.log(`Проверок: ${results.length}  ·  Успешно: ${results.length - failed.length}  ·  Провалено: ${failed.length}`)
console.log('=============================================')
child.kill()
process.exit(failed.length ? 1 : 0)
