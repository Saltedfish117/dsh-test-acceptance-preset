// 「测试验收」的界面半：插件详情页的指令小节配置、会话行的「指令小节」入口、
// 会话内的只读面板。
//
// 数据读写都走 Host 半提供的同源 HTTP 接口（/api/test-acceptance-sections/*），
// 组件里不缓存长期状态，只保留展开行、草稿等视图状态。

window.__ModuleLoader__.load({
  id: 'dsh-test-acceptance-preset',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Host 接口前缀，与 lib/index.js 中的 ROUTE 保持一致。 */
    const API = '/api/test-acceptance-sections'
    /** 插件页与会话面板各用一份通道缓存，互不覆盖。 */
    const pluginChannel = createChannel()
    const sessionChannel = createChannel()

    // ------------------------------------------------------------------
    // 数据通道
    // ------------------------------------------------------------------

    function createChannel() {
      return { data: null, error: null, listeners: new Set(), started: false, sessionId: null }
    }

    function emit(channel) {
      channel.listeners.forEach((listener) => listener())
    }

    /** 拉取接口快照；失败只记录错误，界面继续显示上一次的数据。 */
    async function refresh(channel, sessionId) {
      try {
        const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''
        const response = await fetch(`${API}/state${query}`, { headers: { accept: 'application/json' } })
        const payload = await response.json()
        if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
        channel.data = payload
        channel.error = payload.error || null
      } catch (error) {
        channel.error = error instanceof Error ? error.message : String(error)
      }
      channel.sessionId = sessionId ?? null
      emit(channel)
    }

    /** 写入操作；成功后用返回的快照覆盖缓存，避免二次请求。 */
    async function post(channel, sessionId, action, body) {
      const response = await fetch(`${API}/${action}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, ...body }),
      })
      const payload = await response.json()
      if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`)
      channel.data = {
        ...(channel.data || {}),
        sections: payload.sections,
        selectedIds: payload.selectedIds,
        error: payload.error || null,
      }
      channel.error = payload.error || null
      emit(channel)
      return payload
    }

    /** 订阅通道；第一次挂载时拉一次数据。 */
    function useChannel(channel, sessionId) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((n) => n + 1)
        channel.listeners.add(listener)
        const changed = channel.sessionId !== (sessionId ?? null)
        if (!channel.started || changed) {
          channel.started = true
          refresh(channel, sessionId)
        }
        return () => {
          channel.listeners.delete(listener)
        }
      }, [sessionId])
      return channel
    }

    // ------------------------------------------------------------------
    // 会话面板的开合状态（按钮与浮层是两个 slot，需要模块级共享）
    // ------------------------------------------------------------------

    const overlay = { open: false, listeners: new Set() }
    function setOverlayOpen(open) {
      if (overlay.open === open) return
      overlay.open = open
      overlay.listeners.forEach((listener) => listener())
    }
    function useOverlayOpen() {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const listener = () => force((n) => n + 1)
        overlay.listeners.add(listener)
        return () => {
          overlay.listeners.delete(listener)
        }
      }, [])
      return overlay.open
    }

    // ------------------------------------------------------------------
    // 基础控件
    // ------------------------------------------------------------------

    /** 开关：role=switch，点击不冒泡到行主体。 */
    function Switch({ checked, disabled, onToggle, label }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          disabled: disabled || undefined,
          className: `tac-switch${checked ? ' is-on' : ''}`,
          onClick: (event) => {
            event.stopPropagation()
            onToggle(!checked)
          },
        },
        h('span', { className: 'tac-switch-knob' }),
      )
    }

    /** 六点拖拽手柄。 */
    function Grip() {
      const dots = []
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 2; column += 1) {
          dots.push(h('circle', { key: `${row}-${column}`, cx: 3 + column * 6, cy: 3 + row * 6, r: 1.4 }))
        }
      }
      return h('svg', { className: 'tac-grip', viewBox: '0 0 12 18', width: 10, height: 15, 'aria-hidden': true }, dots)
    }

    /** 内容预览：取第一行并压成一行，作为折叠态的摘要。 */
    function previewOf(content) {
      const line = String(content || '').split('\n').find((item) => item.trim()) || ''
      return line.trim()
    }

    // ------------------------------------------------------------------
    // 插件详情页（plugins.bundle.config）
    // ------------------------------------------------------------------

    function PluginPage(props) {
      const channel = useChannel(pluginChannel, null)
      const data = channel.data
      const sections = data?.sections || []
      const selected = new Set(data?.selectedIds || [])

      const [editingId, setEditingId] = React.useState(null)
      const [draft, setDraft] = React.useState({ title: '', content: '' })
      const [confirmId, setConfirmId] = React.useState(null)
      const [saving, setSaving] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const [dragId, setDragId] = React.useState(null)
      const [dropIndex, setDropIndex] = React.useState(null)

      // summary 视图只渲染一行摘要。
      if (props.view === 'summary') {
        if (!data) return h('span', { className: 'tac-summary' }, '通用指令注入')
        return h('span', { className: 'tac-summary' }, `通用指令注入 ${sections.length} 节 · ${selected.size} 节生效`)
      }

      const commit = async (nextSections) => {
        setSaving(true)
        setFailure(null)
        try {
          await post(pluginChannel, null, 'sections', { sections: nextSections })
          return true
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
          return false
        } finally {
          setSaving(false)
        }
      }

      const startEdit = (section) => {
        setEditingId(section.id)
        setDraft({ title: section.title, content: section.content })
      }

      const startCreate = () => {
        setEditingId('new')
        setDraft({ title: '', content: '' })
      }

      const cancelEdit = () => {
        setEditingId(null)
        setDraft({ title: '', content: '' })
      }

      const saveEdit = async () => {
        const title = draft.title.trim()
        const content = draft.content.trim()
        if (!title || !content) return
        let next
        if (editingId === 'new') {
          next = [
            ...sections,
            { id: `new-${Date.now()}`, title, content, enabled: true, order: sections.length },
          ]
        } else {
          next = sections.map((section) =>
            section.id === editingId ? { ...section, title, content } : section,
          )
        }
        if (await commit(next)) cancelEdit()
      }

      const toggle = async (section, enabled) => {
        await commit(sections.map((item) => (item.id === section.id ? { ...item, enabled } : item)))
      }

      const remove = async (section) => {
        setConfirmId(null)
        await commit(sections.filter((item) => item.id !== section.id))
      }

      const move = async (id, targetIndex) => {
        const from = sections.findIndex((section) => section.id === id)
        if (from < 0) return
        const next = sections.slice()
        const [item] = next.splice(from, 1)
        const index = from < targetIndex ? targetIndex - 1 : targetIndex
        next.splice(Math.max(0, Math.min(next.length, index)), 0, item)
        await commit(next.map((section, position) => ({ ...section, order: position })))
      }

      // 键盘操作：Esc 取消编辑、Ctrl/⌘+Enter 保存。
      const onEditorKeyDown = (event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          cancelEdit()
        } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault()
          saveEdit()
        }
      }

      const editor = (id) =>
        h(
          'div',
          { className: 'tac-editor', key: `editor-${id}` },
          h('input', {
            className: 'tac-input',
            value: draft.title,
            maxLength: 40,
            placeholder: '标题',
            autoFocus: true,
            onChange: (event) => setDraft({ ...draft, title: event.target.value }),
            onKeyDown: onEditorKeyDown,
          }),
          h('textarea', {
            className: 'tac-textarea',
            value: draft.content,
            maxLength: 4000,
            rows: 6,
            placeholder: '内容',
            onChange: (event) => setDraft({ ...draft, content: event.target.value }),
            onKeyDown: onEditorKeyDown,
          }),
          h(
            'div',
            { className: 'tac-editor-foot' },
            h(
              'div',
              { className: 'tac-editor-actions' },
              id !== 'new' && h(
                'button',
                {
                  type: 'button',
                  className: 'tac-link is-danger',
                  onClick: () => setConfirmId(id),
                },
                '删除',
              ),
              h(
                'button',
                { type: 'button', className: 'tac-btn', onClick: cancelEdit },
                '取消',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'tac-btn is-primary',
                  disabled: saving || !draft.title.trim() || !draft.content.trim(),
                  onClick: saveEdit,
                },
                id === 'new' ? '添加' : '保存',
              ),
            ),
          ),
        )

      const row = (section, index) => {
        const expanded = editingId === section.id
        const dragging = dragId === section.id
        return h(
          'div',
          {
            key: section.id,
            className: `tac-row${dragging ? ' is-dragging' : ''}${dropIndex === index ? ' is-drop' : ''}`,
            onDragOver: (event) => {
              if (!dragId) return
              event.preventDefault()
              setDropIndex(index)
            },
            onDrop: (event) => {
              event.preventDefault()
              const id = dragId
              setDragId(null)
              setDropIndex(null)
              if (id) move(id, index)
            },
            onClick: () => (expanded ? cancelEdit() : startEdit(section)),
          },
          h(
            'span',
            {
              className: 'tac-grip-wrap',
              draggable: true,
              tabIndex: 0,
              title: '拖动排序',
              onClick: (event) => event.stopPropagation(),
              onDragStart: (event) => {
                setDragId(section.id)
                event.dataTransfer.effectAllowed = 'move'
                event.dataTransfer.setData('text/plain', section.id)
              },
              onDragEnd: () => {
                setDragId(null)
                setDropIndex(null)
              },
              onKeyDown: (event) => {
                if (!event.altKey) return
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  move(section.id, Math.max(0, index - 1))
                } else if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  move(section.id, Math.min(sections.length, index + 2))
                }
              },
            },
            h(Grip, null),
          ),
          h(
            'div',
            { className: 'tac-row-main' },
            h('div', { className: 'tac-row-title' }, section.title),
            h('div', { className: 'tac-row-preview' }, previewOf(section.content)),
          ),
          h(Switch, {
            checked: section.enabled,
            disabled: saving,
            label: `${section.title} 启用`,
            onToggle: (next) => toggle(section, next),
          }),
        )
      }

      const list = []
      sections.forEach((section, index) => {
        list.push(row(section, index))
        if (editingId === section.id) list.push(editor(section.id))
      })
      if (editingId === 'new') list.unshift(editor('new'))

      const confirmSection = sections.find((section) => section.id === confirmId)

      return h(
        'div',
        { className: 'tac-page' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'tac-header' },
          h('div', { className: 'tac-header-title' }, '通用指令注入'),
          h(
            'div',
            { className: 'tac-header-side' },
            h('span', { className: 'tac-count' }, `共 ${sections.length} 节 · ${selected.size} 节生效`),
            h('button', { type: 'button', className: 'tac-link', onClick: startCreate }, '＋ 新增小节'),
          ),
        ),
        failure && h('div', { className: 'tac-failure' }, failure),
        data?.error && h('div', { className: 'tac-failure' }, data.error),
        !sections.length && editingId !== 'new'
          ? h(
              'div',
              { className: 'tac-empty' },
              h('div', { className: 'tac-empty-icon' }),
              h('div', { className: 'tac-empty-title' }, '还没有任何小节'),
              h(
                'button',
                { type: 'button', className: 'tac-btn is-primary tac-empty-add', onClick: startCreate },
                '新增小节',
              ),
            )
          : h('div', { className: 'tac-list' }, list),
        confirmSection &&
          h(
            'div',
            { className: 'tac-confirm-mask', onClick: () => setConfirmId(null) },
            h(
              'div',
              { className: 'tac-confirm', onClick: (event) => event.stopPropagation() },
              h('div', { className: 'tac-confirm-title' }, '删除小节？'),
              h('div', { className: 'tac-confirm-text' }, confirmSection.title),
              h(
                'div',
                { className: 'tac-confirm-actions' },
                h('button', { type: 'button', className: 'tac-btn', onClick: () => setConfirmId(null) }, '取消'),
                h(
                  'button',
                  { type: 'button', className: 'tac-btn is-primary', onClick: () => remove(confirmSection) },
                  '删除',
                ),
              ),
            ),
          ),
      )
    }

    // ------------------------------------------------------------------
    // 会话行入口（conversation.hero.options）
    // ------------------------------------------------------------------

    function HeroOption(props) {
      const channel = useChannel(sessionChannel, props.sessionId)
      const data = channel.data
      // 入口始终显示（只要有小节）：草稿页拿不到可靠的预设，且用户要求常驻可达；
      // 是否真的注入由预设作用域决定，普通会话不会注入，面板里有说明。
      if (!data || !data.sections.length) return null
      const active = data.selectedIds.length
      const total = data.sections.length
      return h(
        'button',
        {
          type: 'button',
          className: 'tac-hero',
          title: '指令小节（仅在测试验收模式生效）',
          onClick: () => setOverlayOpen(!overlay.open),
        },
        h('style', null, CSS),
        `指令小节 ${active}/${total}`,
      )
    }

    // ------------------------------------------------------------------
    // 会话面板（conversation.input.overlay，只读）
    // ------------------------------------------------------------------

    function SessionOverlay(props) {
      const channel = useChannel(sessionChannel, props.sessionId)
      const open = useOverlayOpen()
      const data = channel.data
      const [expandedId, setExpandedId] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)

      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOverlayOpen(false)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [open])

      if (!open || !data || !data.sections.length) return null

      const selected = new Set(data.selectedIds)
      const toggle = async (section, enabled) => {
        const next = new Set(selected)
        if (enabled) next.add(section.id)
        else next.delete(section.id)
        setBusy(true)
        setFailure(null)
        try {
          await post(sessionChannel, props.sessionId, 'choice', { ids: [...next] })
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const reset = async () => {
        setBusy(true)
        setFailure(null)
        try {
          await post(sessionChannel, props.sessionId, 'reset', {})
        } catch (error) {
          setFailure(error instanceof Error ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const rows = []
      data.sections.forEach((section) => {
        const expanded = expandedId === section.id
        rows.push(
          h(
            'div',
            {
              key: section.id,
              className: 'tac-panel-row',
              onClick: () => setExpandedId(expanded ? null : section.id),
            },
            h(
              'div',
              { className: 'tac-panel-main' },
              h('div', { className: 'tac-panel-title' }, section.title),
              !expanded && h('div', { className: 'tac-panel-preview' }, previewOf(section.content)),
            ),
            h(Switch, {
              checked: selected.has(section.id),
              disabled: busy,
              label: `${section.title} 生效`,
              onToggle: (next) => toggle(section, next),
            }),
          ),
        )
        if (expanded) {
          rows.push(h('div', { key: `${section.id}-content`, className: 'tac-panel-content' }, section.content))
        }
      })

      return h(
        'div',
        { className: 'tac-panel', onClick: (event) => event.stopPropagation() },
        h('style', null, CSS),
        h('div', { className: 'tac-panel-head' },
          h('div', null, '本会话生效的指令小节'),
          h('div', { className: 'tac-panel-sub' }, '仅在测试验收模式生效'),
        ),
        failure && h('div', { className: 'tac-failure' }, failure),
        h('div', { className: 'tac-panel-list' }, rows),
        h(
          'div',
          { className: 'tac-panel-foot' },
          h(
            'button',
            { type: 'button', className: 'tac-link', disabled: busy, onClick: reset },
            '恢复默认',
          ),
          h('button', { type: 'button', className: 'tac-btn is-primary', onClick: () => setOverlayOpen(false) }, '完成'),
        ),
        h('div', { className: 'tac-panel-hint' }, '改内容去 插件 → 测试验收'),
      )
    }

    // ------------------------------------------------------------------
    // 样式（只用主题 token，跟随明暗主题）
    // ------------------------------------------------------------------

    const CSS = `
.tac-page { display: flex; flex-direction: column; gap: 10px; background: transparent; color: var(--dsw-alias-label-primary); }
.tac-summary { color: var(--dsw-alias-label-secondary); }
.tac-header { display: flex; align-items: center; justify-content: space-between; }
.tac-header-title { font-size: 12.5px; font-weight: 700; }
.tac-header-side { display: flex; align-items: center; gap: 12px; }
.tac-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.tac-link { border: 0; background: transparent; padding: 0; font-size: 11.5px; color: var(--dsw-alias-brand-primary); cursor: pointer; }
.tac-link.is-danger { color: var(--dsw-alias-state-error-primary); }
.tac-link:disabled { opacity: .5; cursor: default; }
.tac-list { display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; overflow: hidden; }
.tac-row { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1); cursor: pointer; position: relative; }
.tac-row + .tac-row, .tac-row + .tac-editor, .tac-editor + .tac-row { border-top: 1px solid var(--dsw-alias-border-l1); }
.tac-row:hover { background: var(--dsw-alias-bg-layer-2); }
.tac-row.is-dragging { opacity: .6; }
.tac-row.is-drop { box-shadow: inset 0 2px 0 var(--dsw-alias-brand-primary); }
.tac-grip-wrap { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 18px; color: var(--dsw-alias-state-idle-primary); cursor: grab; }
.tac-grip-wrap:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); border-radius: 4px; }
.tac-grip { fill: currentColor; }
.tac-row-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.tac-row-title { font-size: 12.5px; font-weight: 700; }
.tac-row-preview { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tac-switch { width: 36px; height: 20px; border-radius: 10px; border: 0; padding: 0; background: var(--dsw-alias-border-l2); position: relative; cursor: pointer; flex: none; transition: background .15s; }
.tac-switch.is-on { background: var(--dsw-alias-label-primary); }
.tac-switch:disabled { opacity: .6; cursor: default; }
.tac-switch-knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-bg-base); transition: transform .15s; }
.tac-switch.is-on .tac-switch-knob { transform: translateX(16px); }
.tac-editor { display: flex; flex-direction: column; gap: 8px; padding: 12px; background: var(--dsw-alias-bg-layer-2); }
.tac-input, .tac-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; padding: 7px 10px; outline: none; }
.tac-input:focus, .tac-textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.tac-textarea { resize: vertical; min-height: 96px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; line-height: 1.6; }
.tac-editor-foot { display: flex; align-items: center; justify-content: space-between; }
.tac-editor-actions { display: flex; align-items: center; gap: 8px; margin-left: auto; }
.tac-btn { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; padding: 5px 12px; border-radius: 8px; cursor: pointer; }
.tac-btn.is-primary { background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-base); border-color: transparent; }
.tac-btn:disabled { opacity: .5; cursor: default; }
.tac-failure { font-size: 11.5px; color: var(--dsw-alias-state-error-primary); }
.tac-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 28px 0 32px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); }
.tac-empty-icon { width: 36px; height: 36px; border-radius: 10px; background: var(--dsw-alias-bg-layer-2); }
.tac-empty-title { font-size: 13px; font-weight: 700; }
.tac-empty-add { min-width: 96px; }
.tac-confirm-mask { position: fixed; inset: 0; background: rgba(0,0,0,.25); display: flex; align-items: center; justify-content: center; z-index: 60; }
.tac-confirm { width: 300px; border-radius: 12px; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); padding: 18px; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.18); }
.tac-confirm-title { font-size: 13px; font-weight: 700; }
.tac-confirm-text { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.tac-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.tac-hero { display: inline-flex; align-items: center; height: 24px; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 11.5px; padding: 0 8px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
.tac-hero:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.tac-panel { position: fixed; right: 24px; bottom: 196px; width: 560px; max-height: calc(100vh - 240px); display: flex; flex-direction: column; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; box-shadow: 0 16px 40px rgba(0,0,0,.18); z-index: 50; color: var(--dsw-alias-label-primary); overflow: hidden; }
.tac-panel-head { display: flex; flex-direction: column; gap: 2px; padding: 14px 18px 10px; font-size: 13px; font-weight: 700; }
.tac-panel-sub { font-size: 10.5px; font-weight: 400; color: var(--dsw-alias-label-secondary); }
.tac-panel-list { overflow: auto; padding-bottom: 6px; }
.tac-panel-row { display: flex; align-items: center; gap: 12px; padding: 10px 18px; cursor: pointer; }
.tac-panel-row:hover { background: var(--dsw-alias-bg-layer-2); }
.tac-panel-main { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.tac-panel-title { font-size: 12.5px; font-weight: 700; }
.tac-panel-preview { font-size: 11px; color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tac-panel-content { padding: 0 18px 14px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; max-height: 240px; overflow: auto; }
.tac-panel-foot { display: flex; align-items: center; justify-content: space-between; padding: 10px 18px; border-top: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.tac-panel-hint { padding: 0 18px 12px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); }
`

    // ------------------------------------------------------------------
    // 注册
    // ------------------------------------------------------------------

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-test-acceptance-preset', id: 'sections' }, PluginPage),
        )
        // 与 dsh-image-gen 同位置：composer 工具行右侧，提交按钮之前。
        // 这个位置在新会话草稿页也会渲染；left 位置在草稿页不渲染，别改回去。
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register({ name: 'conversation.input.right', id: 'test-acceptance.sections', order: 10 }, HeroOption),
        )
        ctx.slots.inject('conversation.input.overlay', () =>
          ctx.slots.register({ name: 'conversation.input.overlay', id: 'test-acceptance.sections', order: 10 }, SessionOverlay),
        )
      },
    }
  },
})
