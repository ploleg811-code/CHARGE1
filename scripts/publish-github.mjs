/* =========================================================================
   Публикация сайта CHARGE на GitHub Pages через GitHub REST API.
   Работает без git и без GitHub CLI.

   Подготовка токена:
     GitHub → Settings → Developer settings → Personal access tokens
     → Fine-grained tokens → Generate new token
     → Repository permissions: Contents = Read and write, Pages = Read and write
     → скопировать токен в файл (одна строка), например:
        C:\Users\<user>\Desktop\gh-token.txt

   Запуск:
     node scripts/publish-github.mjs --token-file "<путь к файлу>" --repo charge-detailing [--private] [--dry-run]
   ========================================================================= */

import { readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const args = {}
const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { args[key] = next; i++ } else { args[key] = true }
  }
}

const TOKEN_FILE = args['token-file']
const REPO = args.repo || 'charge-detailing'
const PRIVATE = !!args.private
const DRY = !!args['dry-run']
const BUILD_DIR = args.dir || 'dist-standalone'
const API = 'https://api.github.com'

if (!TOKEN_FILE && !DRY) {
  console.error('Укажите --token-file "<путь к файлу с токеном>"')
  process.exit(1)
}

let token = ''
if (TOKEN_FILE) {
  try {
    token = (await readFile(TOKEN_FILE, 'utf8')).trim()
  } catch (e) {
    console.error('Не удалось прочитать файл токена:', e.message)
    process.exit(1)
  }
  if (!token) {
    console.error('Файл токена пуст.')
    process.exit(1)
  }
}

const headers = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'charge-publisher',
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!res.ok) {
    const msg = data?.message || text || res.status
    throw new Error(`${method} ${url.replace(API, '')} → ${res.status} ${msg}`)
  }
  return data
}

/* --- Собираем список файлов --- */
async function walk(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walk(full, base)))
    else out.push(full)
  }
  return out
}

const DEST = args.path && args.path !== '.' ? args.path : ''
const tasks = [{ dir: BUILD_DIR, dest: DEST }]

// Дополнительные каталоги: --also "локальная_папка=путь_в_репозитории"
for (const spec of [].concat(args.also || [])) {
  const [dir, dest = ''] = String(spec).split('=')
  tasks.push({ dir, dest })
}

const plan = []
for (const t of tasks) {
  const list = (await walk(t.dir)).sort()
  for (const f of list) {
    const rel = relative(t.dir, f).split(sep).join('/')
    plan.push({ file: f, path: (t.dest ? t.dest.replace(/\/$/, '') + '/' : '') + rel })
  }
}
const files = plan.map((p) => p.file)

/* --- Dry run: только показать, что будет загружено --- */
if (DRY) {
  console.log(`Каталог: ${BUILD_DIR} → ${DEST ? DEST + '/' : '(корень)'}`)
  let total = 0
  const tree = new Map()
  for (const p of plan) {
    total += (await stat(p.file)).size
    const dir = p.path.includes('/') ? p.path.slice(0, p.path.lastIndexOf('/')) : '(корень)'
    tree.set(dir, (tree.get(dir) || 0) + 1)
  }
  console.log(`Файлов к загрузке: ${plan.length}`)
  for (const [dir, n] of [...tree.entries()].sort()) console.log(`  ${dir}/ — ${n}`)
  console.log(`Размер: ${(total / 1024 / 1024).toFixed(1)} МБ`)
  process.exit(0)
}

/* --- 1. Кто мы --- */
const me = await api('GET', `${API}/user`)
console.log(`Авторизован как: ${me.login}`)

/* --- 2. Создаём репозиторий (если ещё нет) --- */
let repoExists = true
try {
  await api('GET', `${API}/repos/${me.login}/${REPO}`)
  console.log(`Репозиторий ${me.login}/${REPO} уже существует — используем его.`)
} catch {
  repoExists = false
}
if (!repoExists) {
  try {
    await api('POST', `${API}/user/repos`, {
      name: REPO,
      description: 'CHARGE — премиальный детейлинг-центр в Санкт-Петербурге',
      private: PRIVATE,
      auto_init: true,
      has_issues: true,
    })
    console.log(`Создан репозиторий: ${me.login}/${REPO} (${PRIVATE ? 'private' : 'public'})`)
    await new Promise((r) => setTimeout(r, 1500))
  } catch (e) {
    console.error('Не удалось создать репозиторий:', e.message)
    console.error('Создайте пустой репозиторий на github.com (public) и повторите с --repo <имя>.')
    process.exit(1)
  }
}

/* --- 3. Заливаем файлы --- */
const CONCURRENCY = 2
let done = 0
let failed = 0

async function upload(item) {
  const rel = item.path
  const content = (await readFile(item.file)).toString('base64')
  const url = `${API}/repos/${me.login}/${REPO}/contents/${rel}`

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await api('PUT', url, {
        message: `deploy: ${rel}`,
        content,
        branch: 'main',
      })
      done++
      if (done % 10 === 0) console.log(`  загружено ${done}/${plan.length}`)
      return
    } catch (e) {
      const msg = String(e.message)
      // 422 — файл уже есть: берём актуальный sha и обновляем
      if (msg.includes('422')) {
        try {
          const existing = await api('GET', `${url}?ref=main`)
          await api('PUT', url, {
            message: `deploy: ${rel}`,
            content,
            sha: existing.sha,
            branch: 'main',
          })
          done++
          if (done % 10 === 0) console.log(`  загружено ${done}/${plan.length}`)
          return
        } catch (e2) {
          // 409 (sha race) — пробуем ещё раз
          if (String(e2.message).includes('409')) { await sleep(700 * attempt); continue }
          failed++
          console.error(`  ОШИБКА ${rel}: ${e2.message}`)
          return
        }
      }
      if (msg.includes('409')) { await sleep(700 * attempt); continue }
      failed++
      console.error(`  ОШИБКА ${rel}: ${msg}`)
      return
    }
  }
  failed++
  console.error(`  ОШИБКА ${rel}: не удалось после 5 попыток`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const queue = [...plan]
await Promise.all(
  Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length) {
      const item = queue.shift()
      await upload(item)
    }
  }),
)

console.log(`Загружено файлов: ${done - failed}/${plan.length}${failed ? `, ошибок: ${failed}` : ''}`)
if (failed) {
  console.error('Есть ошибки — публикацию прерываю.')
  process.exit(1)
}

/* --- 4. Включаем GitHub Pages --- */
const pagesPath = args['pages-path'] !== undefined ? args['pages-path'] : DEST
try {
  await api('POST', `${API}/repos/${me.login}/${REPO}/pages`, {
    build_type: 'legacy',
    source: { branch: 'main', path: pagesPath ? '/' + pagesPath.replace(/^\//, '') : '/' },
  })
  console.log(`GitHub Pages включён (ветка main, папка /${pagesPath}).`)
} catch (e) {
  if (String(e.message).includes('409')) {
    console.log('Pages уже настроены — обновляем источник.')
    try {
      await api('PUT', `${API}/repos/${me.login}/${REPO}/pages`, {
        build_type: 'legacy',
        source: { branch: 'main', path: pagesPath ? '/' + pagesPath.replace(/^\//, '') : '/' },
      })
      console.log('Источник обновлён.')
    } catch (e2) { console.warn('Не удалось обновить Pages:', e2.message) }
  } else {
    console.warn('Не удалось включить Pages автоматически:', e.message)
    console.log('Включите вручную: Settings → Pages → Deploy from a branch → main /' + (pagesPath || ''))
  }
}

/* --- 5. Удаляем файл с токеном --- */
try {
  await unlink(TOKEN_FILE)
  console.log('Файл с токеном удалён.')
} catch {}

const url = `https://${me.login}.github.io/${REPO}/`
console.log('')
console.log(`Готово! Сайт будет доступен через 1–2 минуты:`)
console.log(`  ${url}`)
