// bundle 的 Host 半：给界面提供通用指令小节的读写接口。
//
// 界面用同源 fetch 访问 /api/test-acceptance-sections/*；路由声明 auth: 'required'，
// 由 webServer 先完成 peer 鉴权。数据本身落在 lib/store.js 描述的 JSON 文件里。

import fs from 'node:fs'
import path from 'node:path'

import { effectiveIds, readState, resetSessionChoice, saveSections, setSessionChoice, statePath } from './store.js'

/** 预设 id，用于判断某个会话是否属于本模式。 */
const PRESET_ID = 'test-acceptance'
/** 路由前缀：kind 为 prefix，因此 /state、/sections 等后缀都落到同一个 handler。 */
const ROUTE = '/api/test-acceptance-sections'

/** 临时诊断：把每次 state 请求的归属判断追加到 debug.log，便于排查会话侧按钮不显示。 */
function debugLog(entry) {
  try {
    const dir = path.dirname(statePath())
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'debug.log'), `${new Date().toISOString()} ${JSON.stringify(entry)}\n`, 'utf8')
  } catch {
    // 诊断日志失败不影响主流程。
  }
}

/** 返回 JSON 响应；统一禁用缓存，避免界面读到旧的配置。 */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 读完请求体并解析 JSON；空体当作 {}。 */
async function readJsonBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

/**
 * 拼出界面需要的快照。
 * @param sessionId 会话 id；缺省时只返回全局信息（插件页使用）。
 * @returns {{ sections, selectedIds, applicable, presetId, error }}
 */
function snapshot(sessions, sessionId) {
  const { store, error } = readState()
  const session = sessionId ? sessions?.get(sessionId) : undefined
  const presetId = session?.header?.agentPreset ?? null
  const applicable = sessionId ? (session ? presetId === PRESET_ID : true) : false
  debugLog({
    sessionId: sessionId ?? null,
    hasSession: Boolean(session),
    presetId,
    applicable,
    sections: store.sections.length,
    liveSessions: sessions ? sessions.list().length : -1,
  })
  return {
    sections: store.sections,
    selectedIds: effectiveIds(store, sessionId),
    // 没有会话时（插件页）不判断归属；有会话时只有本预设才在会话行显示按钮。
    // 会话尚未进入内存存储（例如新会话草稿）时先放行，避免新模式新建会话看不到入口。
    applicable,
    presetId,
    error,
  }
}

export function apply(ctx) {
  // webServer 是可选服务：没有它（或尚未激活）时本插件保持不激活，不影响预设本身。
  ctx.inject(['webServer'], (ctx) => {
    const sessions = ctx.get('sessions')

    const handler = async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')

      try {
        if (req.method === 'GET' && action === 'state') {
          const sessionId = url.searchParams.get('sessionId') || undefined
          sendJson(res, 200, { ok: true, ...snapshot(sessions, sessionId) })
          return
        }

        if (req.method === 'POST' && action === 'sections') {
          const body = await readJsonBody(req)
          const store = saveSections(Array.isArray(body.sections) ? body.sections : [])
          const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined
          sendJson(res, 200, {
            ok: true,
            sections: store.sections,
            selectedIds: effectiveIds(store, sessionId),
            error: null,
          })
          return
        }

        if (req.method === 'POST' && action === 'choice') {
          const body = await readJsonBody(req)
          if (typeof body.sessionId !== 'string' || !body.sessionId) {
            sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }
          const store = setSessionChoice(body.sessionId, Array.isArray(body.ids) ? body.ids : [])
          sendJson(res, 200, {
            ok: true,
            sections: store.sections,
            selectedIds: effectiveIds(store, body.sessionId),
            error: null,
          })
          return
        }

        if (req.method === 'POST' && action === 'reset') {
          const body = await readJsonBody(req)
          if (typeof body.sessionId !== 'string' || !body.sessionId) {
            sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            return
          }
          const store = resetSessionChoice(body.sessionId)
          sendJson(res, 200, {
            ok: true,
            sections: store.sections,
            selectedIds: effectiveIds(store, body.sessionId),
            error: null,
          })
          return
        }

        sendJson(res, 404, { ok: false, error: '未知接口' })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    }

    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, auth: 'required', handler }))
  })
}
