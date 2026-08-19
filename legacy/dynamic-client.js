/**
 * mcmp-1 · 数学建模论文自动化流水线 —— Client 半(Dynamic Cordis Plugin 源码)
 *
 * 本文件内容即 cordis_define 的 code.client 参数:一个纯 JavaScript 函数体,
 * 返回 Cordis Plugin 对象。功能:
 *   - 在 shell.overlay 槽位注册一个可拖拽的浮动进度面板(独立窗口)
 *   - 通过 host.call('get-state') 每 1.2 秒轮询 Host 进度状态
 *   - 显示总体百分比进度条、当前轮/步骤/迭代、8 步骤打点、日志、产出文件
 *   - 支持中止(abort)、清空状态(reset)、最小化、关闭、拖拽定位
 * 注意:拖拽只绑定在标题文字上(指针捕获会吞掉同栏按钮的点击),按钮
 * 点击不受拖拽影响。仅使用 React.createElement(无 JSX),样式基于 DSH
 * 主题 CSS 变量并提供高对比度回退色。
 */
return {
  name: 'mcmp-ui',
  inject: ['timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    styles.insert([
      '.mcmp-panel { position: fixed; right: 16px; bottom: 16px; z-index: 9990; width: 344px; max-height: 78vh; display: flex; flex-direction: column; pointer-events: auto; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; box-shadow: 0 16px 48px rgba(0,0,0,0.4); font-size: 12px; line-height: 1.55; overflow: hidden; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }',
      '.mcmp-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); border-bottom: 1px solid var(--dsw-alias-border-l1); user-select: none; }',
      '.mcmp-title { font-weight: 600; font-size: 13px; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: grab; padding: 2px 0; }',
      '.mcmp-title:active { cursor: grabbing; }',
      '.mcmp-chip { padding: 2px 9px; border-radius: 999px; font-size: 11px; color: #ffffff; flex-shrink: 0; text-shadow: 0 1px 1px rgba(0,0,0,0.3); font-weight: 600; }',
      '.mcmp-chip-run { background: var(--dsw-alias-brand-primary, #2563eb); animation: mcmp-pulse 1.6s ease-in-out infinite; }',
      '.mcmp-chip-ok { background: var(--dsw-alias-state-success-primary, #16a34a); }',
      '.mcmp-chip-err { background: var(--dsw-alias-state-error-primary, #dc2626); }',
      '.mcmp-chip-warn { background: var(--dsw-alias-state-warn-primary, #d97706); }',
      '@keyframes mcmp-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.55; } }',
      '.mcmp-btn { border: none; background: transparent; color: var(--dsw-alias-label-primary); cursor: pointer; font-size: 14px; padding: 4px 9px; border-radius: 6px; line-height: 1; min-width: 26px; }',
      '.mcmp-btn:hover { background: var(--dsw-alias-bg-layer-2); }',
      '.mcmp-body { padding: 10px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; }',
      '.mcmp-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }',
      '.mcmp-label { color: var(--dsw-alias-label-secondary, #6b7280); }',
      '.mcmp-bar { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }',
      '.mcmp-fill { height: 100%; border-radius: 999px; background: var(--dsw-alias-brand-primary, #2563eb); transition: width 0.5s ease; }',
      '.mcmp-pct { font-weight: 700; font-size: 14px; }',
      '.mcmp-cur { font-size: 12px; }',
      '.mcmp-steps { display: flex; flex-direction: column; gap: 3px; }',
      '.mcmp-step { display: flex; align-items: center; gap: 6px; padding: 2px 6px; border-radius: 6px; }',
      '.mcmp-step.active { background: var(--dsw-alias-bg-layer-1); }',
      '.mcmp-step .mname { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
      '.mcmp-dots { color: var(--dsw-alias-label-secondary, #6b7280); letter-spacing: 1px; font-size: 11px; flex-shrink: 0; }',
      '.mcmp-done-dot { color: var(--dsw-alias-state-success-primary, #16a34a); }',
      '.mcmp-logs { font-family: ui-monospace, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-secondary, #6b7280); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; max-height: 96px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; }',
      '.mcmp-files { max-height: 140px; overflow-y: auto; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; padding: 6px 8px; font-size: 11px; }',
      '.mcmp-file { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--dsw-alias-label-secondary, #6b7280); }',
      '.mcmp-error { color: var(--dsw-alias-state-error-primary, #dc2626); }',
      '.mcmp-actions { display: flex; gap: 8px; justify-content: flex-end; }',
      '.mcmp-actions .mcmp-btn { border: 1px solid var(--dsw-alias-border-l1); padding: 4px 12px; font-size: 12px; }',
      '.mcmp-abort { color: var(--dsw-alias-state-error-primary, #dc2626); border-color: var(--dsw-alias-state-error-primary, #dc2626); }',
    ].join('\n'))

    const h = React.createElement
    const STATUS_TEXT = { running: '运行中', completed: '已完成', error: '出错', cancelled: '已中止', idle: '空闲' }
    const STATUS_CLASS = { running: 'run', completed: 'ok', error: 'err', cancelled: 'warn', idle: '' }

    function Panel() {
      const [snap, setSnap] = React.useState(null)
      const [minimized, setMinimized] = React.useState(false)
      const [dismissedRun, setDismissedRun] = React.useState(null)
      const [pos, setPos] = React.useState(null)
      const [drag, setDrag] = React.useState(null)

      React.useEffect(() => {
        let unmounted = false
        const tick = async () => {
          try {
            const s = await host.call('get-state', {})
            if (!unmounted && s) setSnap(s)
          } catch (err) { /* 面板未连接时忽略 */ }
        }
        tick()
        return ctx.interval(tick, 1200)
      }, [])

      if (!snap || snap.status === 'idle' || dismissedRun === snap.runId) return null
      const st = snap.status
      const pct = snap.pct

      // 拖拽只绑定在标题文字上,避免指针捕获吞掉同栏按钮的点击
      const onTitleDown = (e) => {
        if (e.button !== 0) return
        const box = e.currentTarget.parentElement ? e.currentTarget.parentElement.parentElement : null
        if (!box) return
        const rect = box.getBoundingClientRect()
        box.setPointerCapture(e.pointerId)
        setPos({ x: rect.left, y: rect.top })
        setDrag({ dx: e.clientX - rect.left, dy: e.clientY - rect.top })
      }
      const onMove = (e) => {
        if (!drag) return
        setPos({ x: e.clientX - drag.dx, y: e.clientY - drag.dy })
      }
      const onUp = (e) => {
        setDrag(null)
        try { e.currentTarget.releasePointerCapture(e.pointerId) } catch (err) { /* ignore */ }
      }

      const rootStyle = pos
        ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' }
        : undefined

      const elapsed = snap.startedAt ? Math.max(0, (snap.endedAt || Date.now()) - snap.startedAt) : 0
      const mm = Math.floor(elapsed / 60000)
      const ss = Math.floor((elapsed % 60000) / 1000)
      const elapsedText = mm > 0 ? mm + '分' + (ss < 10 ? '0' : '') + ss + '秒' : ss + '秒'

      const stepRows = (snap.steps || []).map((step) => {
        let dots = ''
        for (let k = 0; k < step.iterTotal; k++) {
          dots += k < step.done ? '●' : '○'
        }
        const name = h('span', { className: 'mname' }, step.key + ' ' + step.name)
        const dotEl = h('span', { className: 'mcmp-dots ' + (step.done > 0 ? 'mcmp-done-dot' : '') }, dots)
        const cnt = h('span', { className: 'mcmp-label' }, step.done + '/' + step.iterTotal)
        return h('div', { key: step.key, className: 'mcmp-step' + (step.active ? ' active' : '') }, name, dotEl, cnt)
      })

      const logLines = (snap.logs || []).map((l, i) => l.t + ' ' + l.m).join('\n')
      const fileRows = (snap.files || []).map((f, i) => h('div', { key: 'f' + i, className: 'mcmp-file' }, (f.type === 'dir' ? '📁 ' : '📄 ') + f.name))

      const curLine = snap.cur
        ? snap.cur.stepKey + ' ' + snap.cur.stepName + ' · 迭代 ' + (snap.cur.iterIdx + 1) + '/' + snap.cur.iterTotal + ' 「' + snap.cur.iterName + '」'
        : st === 'completed' ? '🎉 全部迭代已完成' : '等待中…'

      const children = []
      children.push(h('div', { key: 'head', className: 'mcmp-head' },
        h('span', { className: 'mcmp-title', title: '按住拖动面板', onPointerDown: onTitleDown }, '数学建模论文流水线'),
        h('span', { className: 'mcmp-chip mcmp-chip-' + (STATUS_CLASS[st] || '') }, STATUS_TEXT[st] || st),
        h('button', { key: 'min', className: 'mcmp-btn', title: minimized ? '展开面板' : '最小化面板', onClick: () => setMinimized(!minimized) }, minimized ? '□' : '—'),
        h('button', { key: 'close', className: 'mcmp-btn', title: '关闭面板', onClick: () => setDismissedRun(snap.runId) }, '×'),
      ))
      if (!minimized) {
        const body = []
        body.push(h('div', { key: 'pct', className: 'mcmp-row' },
          h('span', { className: 'mcmp-label' }, '总体进度'),
          h('span', { className: 'mcmp-pct' }, pct + '%'),
        ))
        body.push(h('div', { key: 'bar', className: 'mcmp-bar' },
          h('div', { className: 'mcmp-fill', style: { width: pct + '%' } }),
        ))
        body.push(h('div', { key: 'meta', className: 'mcmp-row' },
          h('span', { className: 'mcmp-label' }, '第 ' + snap.round + '/' + snap.rounds + ' 轮 · ' + snap.done + '/' + snap.total + ' 次迭代 · ' + elapsedText),
          h('span', { className: 'mcmp-label' }, '已完成'),
        ))
        body.push(h('div', { key: 'cur', className: 'mcmp-cur' }, curLine))
        if (snap.agentLabel && st === 'running') {
          body.push(h('div', { key: 'agent', className: 'mcmp-label' }, '子任务: ' + snap.agentLabel))
        }
        body.push(h('div', { key: 'steps', className: 'mcmp-steps' }, stepRows))
        if (logLines) body.push(h('div', { key: 'logs', className: 'mcmp-logs' }, logLines))
        if (fileRows.length > 0) body.push(h('div', { key: 'files', className: 'mcmp-files' }, fileRows))
        if (snap.error) body.push(h('div', { key: 'err', className: 'mcmp-error' }, snap.error))
        const actions = []
        if (st === 'running') {
          actions.push(h('button', { key: 'abort', className: 'mcmp-btn mcmp-abort', onClick: () => { host.call('abort', {}).catch(() => {}) } }, '中止'))
        } else {
          actions.push(h('button', { key: 'reset', className: 'mcmp-btn', onClick: () => { host.call('reset', {}).then(() => setDismissedRun(snap.runId)).catch(() => {}) } }, '清空状态'))
        }
        actions.push(h('button', { key: 'hide', className: 'mcmp-btn', onClick: () => setDismissedRun(snap.runId) }, '关闭'))
        body.push(h('div', { key: 'actions', className: 'mcmp-actions' }, actions))
        children.push(h('div', { key: 'body', className: 'mcmp-body' }, body))
      }
      return h('div', {
        className: 'mcmp-panel',
        style: rootStyle,
        onPointerMove: onMove,
        onPointerUp: onUp,
        onPointerCancel: onUp,
      }, children)
    }

    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'mathmodel-pipeline-panel', order: 50, label: '数学建模流水线进度面板' },
      () => h(Panel),
    ))
  },
}
