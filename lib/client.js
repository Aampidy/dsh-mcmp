/**
 * dsh-mcmp · 显示界面模块(Client 半,标准 __ModuleLoader__ 客户端 bundle)
 * 小浮窗的显示与交互:每 1.2s 通过 fetch('/mcmp-api/state') 轮询 Host 状态,
 * 中止/重置通过 POST /mcmp-api/abort|reset。拖拽仅绑定标题文字。
 * 按《架构.md》v3 目标架构渲染:五阶段(阶段零~四)子阶段进度、中控台模块、
 * 回滚计数与强制锁定、P0-P3 问题评级;主循环重写前,快照无 stages 字段时
 * 自动回退到旧 S1-S8 步骤渲染(见 index.js 中的 v3 快照契约)。
 * (程序入口模块见 lib/index.js,论文写作主循环模块见 lib/pipeline.js)
 */
window.__ModuleLoader__.load({
  id: "dsh-mcmp",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");

    const CSS = [
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
      '.mcmp-super { color: var(--dsw-alias-brand-primary, #2563eb); font-weight: 600; }',
      '.mcmp-lock { color: var(--dsw-alias-state-error-primary, #dc2626); font-weight: 600; }',
    ].join('\n')

    const h = react.createElement
    const STATUS_TEXT = { running: '运行中', completed: '已完成', error: '出错', cancelled: '已中止', idle: '空闲' }
    const STATUS_CLASS = { running: 'run', completed: 'ok', error: 'err', cancelled: 'warn', idle: '' }

    function Panel() {
      const [snap, setSnap] = react.useState(null)
      const [minimized, setMinimized] = react.useState(false)
      const [dismissedRun, setDismissedRun] = react.useState(null)
      const [pos, setPos] = react.useState(null)
      const [drag, setDrag] = react.useState(null)

      react.useEffect(() => {
        let unmounted = false
        const tick = async () => {
          try {
            const res = await fetch('/mcmp-api/state', { cache: 'no-store' })
            if (res.ok) {
              const s = await res.json()
              if (!unmounted && s) setSnap(s)
            }
          } catch (err) { /* 面板未连接时忽略 */ }
        }
        tick()
        const id = setInterval(tick, 1200)
        return () => { unmounted = true; clearInterval(id) }
      }, [])

      if (!snap || snap.status === 'idle' || dismissedRun === snap.runId) return null
      const st = snap.status
      const pct = snap.pct
      // v3 架构(架构.md):快照含 stages(五阶段)时走新渲染;当前主循环(旧 S1-S8)缺失该字段,回退旧渲染
      const isV3 = Array.isArray(snap.stages) && snap.stages.length > 0

      // 拖拽只绑定在标题文字上,避免指针捕获吞掉同栏按钮的点击
      const onTitleDown = (e) => {
        if (e.button !== 0) return
        const head = e.currentTarget.parentElement
        const box = head && head.parentElement ? head.parentElement : null
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

      const stepRows = isV3
        ? (snap.stages || []).map((stage) => {
            let dots = ''
            for (let k = 0; k < stage.subTotal; k++) {
              dots += k < stage.done ? '●' : '○'
            }
            const name = h('span', { className: 'mname' }, stage.key + ' ' + stage.name)
            const dotEl = h('span', { className: 'mcmp-dots ' + (stage.done > 0 ? 'mcmp-done-dot' : '') }, dots)
            const cnt = h('span', { className: 'mcmp-label' }, stage.done + '/' + stage.subTotal)
            return h('div', { key: stage.key, className: 'mcmp-step' + (stage.active ? ' active' : '') }, name, dotEl, cnt)
          })
        : (snap.steps || []).map((step) => {
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

      const curLine = isV3
        ? (snap.cur
            ? snap.cur.stageKey + ' ' + snap.cur.stageName + ' · 子阶段 ' + (snap.cur.subIdx + 1) + '/' + snap.cur.subTotal + ' 「' + snap.cur.subName + '」'
            : st === 'completed' ? '🎉 全部子阶段已完成' : '等待中…')
        : (snap.cur
            ? snap.cur.stepKey + ' ' + snap.cur.stepName + ' · 迭代 ' + (snap.cur.iterIdx + 1) + '/' + snap.cur.iterTotal + ' 「' + snap.cur.iterName + '」'
            : st === 'completed' ? '🎉 全部迭代已完成' : '等待中…')

      const children = []
      children.push(h('div', { key: 'head', className: 'mcmp-head' },
        h('span', { className: 'mcmp-title', title: '按住拖动面板', onPointerDown: onTitleDown }, '数学建模论文撰写系统'),
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
          h('span', { className: 'mcmp-label' }, isV3
            ? '已完成 ' + snap.done + '/' + snap.total + ' 个子阶段 · ' + elapsedText
            : '第 ' + snap.round + '/' + snap.rounds + ' 轮 · ' + snap.done + '/' + snap.total + ' 次迭代 · ' + elapsedText),
          h('span', { className: 'mcmp-label' }, '已完成'),
        ))
        body.push(h('div', { key: 'cur', className: 'mcmp-cur' }, curLine))
        if (isV3 && snap.supervisor) {
          const sup = snap.supervisor
          if (sup.module) {
            body.push(h('div', { key: 'super', className: 'mcmp-row' },
              h('span', { className: 'mcmp-label' }, '中控台'),
              h('span', { className: 'mcmp-super' }, sup.module),
            ))
          }
          const rb = '回滚 ' + (Number.isSafeInteger(sup.rollbackCount) ? sup.rollbackCount : 0)
            + '/' + (Number.isSafeInteger(sup.rollbackLimit) ? sup.rollbackLimit : 10) + ' 次'
          const q = sup.issues || {}
          const iss = 'P0 ' + (q.P0 || 0) + ' · P1 ' + (q.P1 || 0) + ' · P2 ' + (q.P2 || 0) + ' · P3 ' + (q.P3 || 0)
          body.push(h('div', { key: 'rb', className: 'mcmp-row' },
            h('span', { className: 'mcmp-label' }, rb),
            h('span', { className: 'mcmp-label' }, iss),
          ))
          if (sup.forcedFinal) {
            body.push(h('div', { key: 'lock', className: 'mcmp-lock' }, '🔒 回滚已达上限,流水线已强制锁定(请人工介入)'))
          }
        }
        if (snap.agentLabel && st === 'running') {
          body.push(h('div', { key: 'agent', className: 'mcmp-label' }, '子任务: ' + snap.agentLabel))
        }
        body.push(h('div', { key: 'steps', className: 'mcmp-steps' }, stepRows))
        if (logLines) body.push(h('div', { key: 'logs', className: 'mcmp-logs' }, logLines))
        if (fileRows.length > 0) body.push(h('div', { key: 'files', className: 'mcmp-files' }, fileRows))
        if (snap.error) body.push(h('div', { key: 'err', className: 'mcmp-error' }, snap.error))
        const actions = []
        if (st === 'running') {
          actions.push(h('button', { key: 'abort', className: 'mcmp-btn mcmp-abort', onClick: () => { fetch('/mcmp-api/abort', { method: 'POST' }).catch(() => {}) } }, '中止'))
        } else {
          actions.push(h('button', { key: 'reset', className: 'mcmp-btn', title: '清空状态与断点续跑记录,下次 /loopbegin 从头全新开始', onClick: () => { fetch('/mcmp-api/reset', { method: 'POST' }).then(() => setDismissedRun(snap.runId)).catch(() => {}) } }, '重置(全新开始)'))
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

    const inject = ["slots", "timer"]

    function apply(ctx) {
      if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-mcmp/panel.css"]') === null) {
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-mcmp'
        tag.dataset.pluginCss = 'dsh-mcmp/panel.css'
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'mcmp-pipeline-panel', order: 50, label: '数学建模论文撰写系统进度面板' },
        () => h(Panel),
      ))
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
