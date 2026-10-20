/* =========================================================================
   Скриншоты страниц через Chrome DevTools Protocol.
   Корректно эмулирует мобильный viewport (в отличие от --window-size,
   который Chrome ограничивает минимальной шириной окна).

   Использование:
     node scripts/screenshot.mjs --url http://127.0.0.1:4173/ --route / --out shots/home.png --mobile
   ========================================================================= */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]])
    return acc
  }, []),
)

const BASE = args.url || 'http://127.0.0.1:4173'
const ROUTE = args.route || '/'
const OUT = resolve(args.out || 'shots/page.png')
const MOBILE = !!args.mobile
const WIDTH = Number(args.width || (MOBILE ? 390 : 1440))
const HEIGHT = Number(args.height || (MOBILE ? 844 : 900))
const FULL = args.full === undefined ? true : args.full !== 'false' && args.full !== false
const PORT = 9344

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p))
if (!CHROME) {
  console.error('Chrome/Edge не найден')
  process.exit(1)
}

const userDataDir = mkdtempSync(join(tmpdir(), 'charge-shot-'))
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)
process.on('exit', () => { try { child.kill() } catch {} })

let ws
let id = 0
const pending = new Map()
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
if (!wsUrl) { console.error('CDP недоступен'); process.exit(1) }

ws = new WebSocket(wsUrl)
await new Promise((r) => ws.addEventListener('open', r, { once: true }))
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(m.error.message)) : res(m.result)
  }
})

await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', {
  width: WIDTH,
  height: HEIGHT,
  deviceScaleFactor: 1,
  mobile: MOBILE,
})
await send('Page.navigate', { url: BASE + ROUTE })
await sleep(2200)

// опциональные клики по тексту кнопок (через запятую, по порядку)
if (args.clicks) {
  const list = String(args.clicks).split('|').map((s) => s.trim()).filter(Boolean)
  for (const text of list) {
    await send('Runtime.evaluate', {
      expression: `(() => {
        const els = Array.from(document.querySelectorAll('button, a'));
        const el = els.find(e => (e.textContent || '').trim().includes(${JSON.stringify(text)}));
        if (el) { el.click(); return 'clicked'; }
        return 'not found';
      })()`,
      returnByValue: true,
    })
    await sleep(900)
  }
}

// прокручиваем страницу, чтобы подгрузились lazy-изображения
await send('Runtime.evaluate', {
  expression: `(async () => {
    const h = document.body.scrollHeight;
    for (let y = 0; y < h; y += window.innerHeight * 0.8) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    window.scrollTo(0, ${Number(args.scroll || 0)});
    await new Promise(r => setTimeout(r, 700));
  })()`,
  awaitPromise: true,
})
await sleep(800)

const metrics = await send('Page.getLayoutMetrics')
const cap = await send('Page.captureScreenshot', {
  format: 'png',
  captureBeyondViewport: FULL,
  clip: FULL
    ? { x: 0, y: 0, width: WIDTH, height: Math.min(Math.ceil(metrics.cssContentSize.height), 16000), scale: 1 }
    : undefined,
})

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, Buffer.from(cap.data, 'base64'))
console.log(`OK  ${ROUTE}  ${WIDTH}x${FULL ? Math.min(Math.ceil(metrics.cssContentSize.height), 16000) : HEIGHT}  ->  ${OUT}`)
child.kill()
process.exit(0)
