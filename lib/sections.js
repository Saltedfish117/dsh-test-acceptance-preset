// 「测试验收」预设的通用指令注入。
//
// 该插件只挂在 preset 的 plugins 列表里，所以它注册的 systemPrompt section 只在
// 该预设创建的 Agent 作用域内可见，普通会话不受影响。

import { renderSections } from './store.js'

/** 硬依赖：没挂 system-prompt 的 profile 里本插件保持不激活。 */
export const inject = ['systemPrompt']

export function apply(ctx) {
  ctx.systemPrompt.section({
    // 与预设绑定，改名时同步 cordis.patch.yml 里的预设 id。
    name: 'preset:test-acceptance:sections',
    // 排在 persona 之后、工具说明之前，具体位置由组装器统一排序。
    order: 900,
    // 内容里的 {{…}} 原样保留，不参与 DSH 的模板变量插值。
    interpolate: false,
    // 每次组装重新求值：改配置后下一轮请求即生效，不需要重启。
    text: (context) => {
      const sessionId = context?.session?.id
      // 没有会话上下文（例如离线组装）时不注入，避免把全局配置泄漏到非本模式的场景。
      if (!sessionId) return ''
      try {
        return renderSections(sessionId)
      } catch {
        // 配置读取异常时宁可不注入，也不要打断本次请求。
        return ''
      }
    },
  })
}
