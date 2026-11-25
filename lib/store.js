// 通用指令小节的持久化层。
//
// 存放位置与工作区无关：$DSH_HOME/storages/<包名>/sections.json（$DSH_HOME 缺省 ~/.dsh），
// 所有工作区共用同一份配置。写入采用「临时文件 + rename」，避免进程中断留下半截 JSON。
//
// 数据形状（StoreV1）：
//   {
//     version: 1,
//     sections: [{ id, title, content, enabled, order }],
//     lastUsedIds: string[] | null,              // 上次会话的生效集合；null 表示从未设置
//     sessionChoices: Record<string, string[]>,  // sessionId -> 该会话的生效集合
//     updatedAt: string
//   }

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 包名，同时用作 storages 下的子目录名。 */
export const PACKAGE_NAME = 'dsh-test-acceptance-preset'

/** 小节字段的长度上限，与界面提示保持一致。 */
export const LIMITS = {
  title: 40,
  content: 4000,
  total: 12000,
}

/** sessionChoices 最多保留的会话数，超出后淘汰最早写入的项。 */
const MAX_SESSION_CHOICES = 50

/** 存储的根目录：$DSH_HOME 缺省 ~/.dsh。 */
function homeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/** sections.json 的绝对路径。 */
export function statePath() {
  return path.join(homeDir(), 'storages', PACKAGE_NAME, 'sections.json')
}

/** 一份空存储（未创建文件时的默认值）。 */
function emptyStore() {
  return {
    version: 1,
    sections: [],
    lastUsedIds: null,
    sessionChoices: {},
    updatedAt: new Date().toISOString(),
  }
}

// 单进程缓存：只在文件 mtime 变化时重新解析，避免每次请求都读盘。
// error 保留最近一次解析失败的原因，供 UI 提示，同时继续使用上一份可用数据。
let cache = { path: '', mtimeMs: -1, store: emptyStore(), error: null }

/** 生成本地唯一的小节 id：时间戳 + 随机后缀，重命名内容时保持不变。 */
export function newSectionId() {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 把任意外部数据整理成合法小节。
 * @param raw 待整理的数据；标题/内容缺失或不合法时返回 null，表示丢弃该条。
 * @param index 位置，用于补齐 order。
 */
function normalizeSection(raw, index) {
  if (!raw || typeof raw !== 'object') return null
  const title = String(raw.title ?? '').trim().slice(0, LIMITS.title)
  const content = String(raw.content ?? '').trim().slice(0, LIMITS.content)
  if (!title || !content) return null
  const id = typeof raw.id === 'string' && raw.id ? raw.id : newSectionId()
  return {
    id,
    title,
    content,
    enabled: raw.enabled !== false,
    order: Number.isFinite(raw.order) ? Number(raw.order) : index,
  }
}

/**
 * 规范化整份存储：丢弃不合法小节、按 order 重排、剔除指向已删除小节的引用。
 * @param raw 文件里读出的 JSON（可能损坏或来自旧版本）。
 */
function normalizeStore(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const sections = []
  if (Array.isArray(source.sections)) {
    for (let index = 0; index < source.sections.length; index += 1) {
      const section = normalizeSection(source.sections[index], index)
      if (section) sections.push(section)
    }
  }
  sections.sort((a, b) => a.order - b.order)
  sections.forEach((section, index) => {
    section.order = index
  })

  const known = new Set(sections.map((section) => section.id))
  // 引用清理：只保留仍然存在的小节 id；null 表示「没有设置过」。
  const cleanIds = (value) => {
    if (!Array.isArray(value)) return null
    return [...new Set(value.filter((id) => typeof id === 'string' && known.has(id)))]
  }

  const sessionChoices = {}
  if (source.sessionChoices && typeof source.sessionChoices === 'object') {
    for (const [sessionId, ids] of Object.entries(source.sessionChoices)) {
      const cleaned = cleanIds(ids)
      if (cleaned) sessionChoices[sessionId] = cleaned
    }
  }

  return {
    version: 1,
    sections,
    lastUsedIds: 'lastUsedIds' in source ? cleanIds(source.lastUsedIds) : null,
    sessionChoices,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : new Date().toISOString(),
  }
}

/**
 * 读取存储（带 mtime 缓存）。
 * @returns { store: StoreV1, error: string | null } error 非空表示文件解析失败，
 *   此时 store 仍是上一份可用数据（初始为空存储）。
 */
export function readState() {
  const file = statePath()
  let stat
  try {
    stat = fs.statSync(file)
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      cache = { path: file, mtimeMs: -1, store: emptyStore(), error: null }
      return { store: cache.store, error: null }
    }
    throw error
  }

  if (cache.path === file && cache.mtimeMs === stat.mtimeMs) {
    return { store: cache.store, error: cache.error }
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    cache = { path: file, mtimeMs: stat.mtimeMs, store: normalizeStore(parsed), error: null }
  } catch (error) {
    // 坏 JSON 不覆盖内存中的可用数据，只记录错误让 UI 提示。
    cache = {
      ...cache,
      path: file,
      mtimeMs: stat.mtimeMs,
      error: `配置文件解析失败：${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return { store: cache.store, error: cache.error }
}

/** 原子写入整份存储，返回写入后的规范化数据。 */
export function writeState(store) {
  const file = statePath()
  const next = normalizeStore({ ...store, updatedAt: new Date().toISOString() })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
  const stat = fs.statSync(file)
  cache = { path: file, mtimeMs: stat.mtimeMs, store: next, error: null }
  return next
}

/**
 * 读出、修改、写回。mutator 接收深拷贝，返回新存储；抛错则不做任何写入。
 */
export function updateState(mutator) {
  const { store } = readState()
  const draft = structuredClone(store)
  const next = mutator(draft) || draft
  return writeState(next)
}

/**
 * 某会话的生效小节 id。
 * 优先级：会话显式选择 → 上次会话的使用集合 → 全局启用的小节。
 * @param sessionId 当前会话 id；缺省时跳过会话级选择（插件页预览用）。
 */
export function effectiveIds(store, sessionId) {
  const valid = new Set(store.sections.map((section) => section.id))
  const filter = (ids) => ids.filter((id) => valid.has(id))
  if (sessionId && Array.isArray(store.sessionChoices[sessionId])) {
    return filter(store.sessionChoices[sessionId])
  }
  if (Array.isArray(store.lastUsedIds)) {
    return filter(store.lastUsedIds)
  }
  return store.sections.filter((section) => section.enabled).map((section) => section.id)
}

/**
 * 保存整份小节列表（新增、编辑、删除、排序都走这里）。
 * 删除小节时同步从 lastUsedIds 与所有 sessionChoices 中移除该 id。
 * @param sections 前端提交的小节数组，字段会被规范化。
 */
export function saveSections(sections) {
  return updateState((store) => {
    const next = []
    for (let index = 0; index < sections.length; index += 1) {
      const section = normalizeSection(sections[index], index)
      if (section) next.push(section)
    }
    next.sort((a, b) => a.order - b.order)
    next.forEach((section, index) => {
      section.order = index
    })
    store.sections = next
    return store
  })
}

/**
 * 记录某会话的生效集合，并把它记为「下次新会话的默认」。
 * @param sessionId 生效的会话。
 * @param ids 该会话要注入的小节 id 列表（允许为空数组，表示全关）。
 */
export function setSessionChoice(sessionId, ids) {
  return updateState((store) => {
    const known = new Set(store.sections.map((section) => section.id))
    const chosen = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => known.has(id)))]
    // 先删后写，保证最近使用的会话排在末尾（用于超额淘汰）。
    delete store.sessionChoices[sessionId]
    store.sessionChoices[sessionId] = chosen
    const keys = Object.keys(store.sessionChoices)
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_SESSION_CHOICES))) {
      delete store.sessionChoices[stale]
    }
    store.lastUsedIds = chosen
    return store
  })
}

/**
 * 「恢复默认」：清掉该会话的显式选择，并把上次默认重置为全局启用的小节。
 */
export function resetSessionChoice(sessionId) {
  return updateState((store) => {
    delete store.sessionChoices[sessionId]
    store.lastUsedIds = store.sections.filter((section) => section.enabled).map((section) => section.id)
    return store
  })
}

/**
 * 生成注入用的 Markdown 文本；没有生效小节时返回空字符串（不注入）。
 * @param sessionId 当前会话 id，用于取会话级选择。
 */
export function renderSections(sessionId) {
  const { store } = readState()
  const chosen = effectiveIds(store, sessionId)
  if (!chosen.length) return ''
  const order = new Map(chosen.map((id, index) => [id, index]))
  const picked = store.sections
    .filter((section) => order.has(section.id))
    .sort((a, b) => order.get(a.id) - order.get(b.id))

  const blocks = picked.map((section) => `### ${section.title}\n${section.content.trim()}`)
  let body = blocks.join('\n\n')
  // 总长度上限：超出时按顺序截断，避免个别小节挤占过多上下文。
  if (body.length > LIMITS.total) {
    body = `${body.slice(0, LIMITS.total)}\n\n（通用指令超过长度上限，后续内容已截断。）`
  }
  return [
    '## 本模式通用指令（来自「测试验收」插件配置）',
    '',
    '以下是用户为本模式维护的固定信息，按小节生效；与本次任务冲突时以用户当前指令为准。',
    '',
    body,
  ].join('\n')
}
