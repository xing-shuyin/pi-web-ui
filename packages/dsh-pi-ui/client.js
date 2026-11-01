window.__ModuleLoader__.load({
  id: '@local/dsh-pi-ui',
  factory(require) {
    const React = require('react');
    const { createElement: h, useState, useEffect, useRef, useCallback, useMemo } = React;

    const CSS_STYLES = `
      .dsh-pi-strip-container {
        display: flex;
        flex-direction: column;
        width: 100%;
        margin-bottom: 4px;
      }
      .dsh-pi-strip {
        display: flex;
        align-items: center;
        gap: 6px;
        overflow-x: auto;
        padding: 4px 2px 6px 2px;
        scrollbar-width: none;
        -ms-overflow-style: none;
      }
      .dsh-pi-strip::-webkit-scrollbar {
        display: none;
      }
      .dsh-pi-chip {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 3px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 500;
        line-height: 18px;
        white-space: nowrap;
        background: var(--dsw-alias-bg-layer-2, #27272a);
        color: var(--dsw-alias-label-secondary, #a1a1aa);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
        cursor: pointer;
        user-select: none;
        transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
      }
      .dsh-pi-chip:hover {
        background: var(--dsw-alias-bg-layer-1, #18181b);
        color: var(--dsw-alias-label-primary, #ffffff);
        border-color: var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.2));
        transform: translateY(-1px);
        box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
      }
      .dsh-pi-chip:active {
        transform: translateY(0);
      }
      .dsh-pi-chip-accent {
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f46e5) 15%, transparent);
        color: var(--dsw-alias-brand-primary, #6366f1);
        border-color: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f46e5) 30%, transparent);
      }
      .dsh-pi-chip-accent:hover {
        background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4f46e5) 25%, transparent);
        color: #ffffff;
      }

      /* Notes Drawer */
      .dsh-pi-notes-drawer {
        background: var(--dsw-alias-bg-layer-1, #18181b);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
        border-radius: 12px;
        padding: 12px;
        margin: 6px 0 10px 0;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        gap: 10px;
        animation: dshPiFadeIn 0.2s ease-out;
      }
      @keyframes dshPiFadeIn {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .dsh-pi-notes-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 600;
        color: var(--dsw-alias-label-primary, #f4f4f5);
      }
      .dsh-pi-notes-actions {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .dsh-pi-btn-sm {
        background: var(--dsw-alias-bg-layer-2, #27272a);
        color: var(--dsw-alias-label-secondary, #a1a1aa);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.1));
        border-radius: 6px;
        padding: 2px 8px;
        font-size: 11px;
        cursor: pointer;
        transition: all 0.15s ease;
      }
      .dsh-pi-btn-sm:hover {
        background: var(--dsw-alias-interactive-bg-hover, #3f3f46);
        color: var(--dsw-alias-label-primary, #ffffff);
      }
      .dsh-pi-notes-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
        max-height: 180px;
        overflow-y: auto;
      }
      .dsh-pi-notes-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 6px 10px;
        background: var(--dsw-alias-bg-layer-2, #27272a);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
        border-radius: 8px;
        font-size: 12px;
      }
      .dsh-pi-notes-item-text {
        flex: 1;
        min-width: 0;
        color: var(--dsw-alias-label-primary, #e4e4e7);
        text-overflow: ellipsis;
        overflow: hidden;
        white-space: nowrap;
      }
      .dsh-pi-notes-item-text.done {
        text-decoration: line-through;
        color: var(--dsw-alias-label-tertiary, #71717a);
      }
      .dsh-pi-notes-input-row {
        display: flex;
        gap: 6px;
        margin-top: 4px;
      }
      .dsh-pi-notes-input {
        flex: 1;
        background: var(--dsw-alias-bg-layer-2, #27272a);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.15));
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 12px;
        color: var(--dsw-alias-label-primary, #ffffff);
        outline: none;
      }
      .dsh-pi-notes-input:focus {
        border-color: var(--dsw-alias-brand-primary, #6366f1);
      }

      /* Footer Bar */
      .dsh-pi-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 8px;
        padding: 5px 12px;
        margin-top: 6px;
        background: var(--dsw-alias-bg-layer-1, #18181b);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.08));
        border-radius: 10px;
        font-size: 12px;
        color: var(--dsw-alias-label-secondary, #a1a1aa);
        user-select: none;
      }
      .dsh-pi-footer-left {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      .dsh-pi-footer-right {
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .dsh-pi-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        background: var(--dsw-alias-bg-layer-2, #27272a);
        border: 1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.12));
        font-weight: 600;
        font-size: 11px;
        color: var(--dsw-alias-label-primary, #f4f4f5);
        letter-spacing: 0.3px;
      }
      .dsh-pi-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #10b981;
      }
      .dsh-pi-dot.running {
        background: #38bdf8;
        box-shadow: 0 0 8px #38bdf8;
        animation: dshPiPulse 1.2s infinite ease-in-out;
      }
      @keyframes dshPiPulse {
        0% { transform: scale(0.85); opacity: 0.6; }
        50% { transform: scale(1.25); opacity: 1; }
        100% { transform: scale(0.85); opacity: 0.6; }
      }
      .dsh-pi-meter {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;
        padding: 2px 6px;
        border-radius: 6px;
        transition: background 0.15s ease;
      }
      .dsh-pi-meter:hover {
        background: var(--dsw-alias-bg-layer-2, #27272a);
      }
      .dsh-pi-meter-bar {
        width: 54px;
        height: 5px;
        background: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.15));
        border-radius: 999px;
        overflow: hidden;
      }
      .dsh-pi-meter-fill {
        height: 100%;
        border-radius: 999px;
        transition: width 0.3s ease, background-color 0.3s ease;
      }
      .dsh-pi-text-mono {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 11px;
      }
    `;

    // LocalStorage helper for Notes
    const NOTES_KEY = 'dsh_pi_notes_v1';
    function loadNotes() {
      try {
        const raw = localStorage.getItem(NOTES_KEY);
        if (!raw) return [
          { id: '1', text: '欢迎使用 PI-UI 增强套件！随手捕捉灵感与备忘', done: false },
          { id: '2', text: '点击右侧按钮可直接将笔记填入输入框', done: false }
        ];
        return JSON.parse(raw);
      } catch  {
        return [];
      }
    }
    function saveNotes(notes) {
      try {
        localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
      } catch  {}
    }

    // Default Quick Actions
    const DEFAULT_PROMPTS = [
      { id: 'plan', label: '📋 制定计划', prompt: '请先输出详细的实现分步计划、依赖关系和潜在风险评估，暂时不要编写具体代码。' },
      { id: 'review', label: '🔍 代码审查', prompt: '请对当前工作区的改动或相关核心模块进行严格的代码质量、安全隐患与架构合理性审查。' },
      { id: 'refactor', label: '⚡ 优化重构', prompt: '请分析现有代码结构的瓶颈，给出清晰的性能优化建议与重构方案。' },
      { id: 'test', label: '🧪 编写单测', prompt: '请针对核心业务函数与边界情况编写完备的自动化单元测试用例。' },
      { id: 'explain', label: '💬 解释逻辑', prompt: '请通俗易懂地梳理这段代码的核心逻辑、时序流转与关键设计决策。' },
    ];

    /**
     * Quick Actions & Notes Dock (rendered in `conversation.input.dock`)
     */
    function QuickActionsDock(props) {
      const { inputActions, useSession } = props;
      const [notesOpen, setNotesOpen] = useState(false);
      const [notes, setNotes] = useState(loadNotes);
      const [newNoteText, setNewNoteText] = useState('');

      // Listen for custom toggle from footer bar
      useEffect(() => {
        const handler = () => setNotesOpen(prev => !prev);
        window.addEventListener('dsh-pi-notes-toggle', handler);
        return () => window.removeEventListener('dsh-pi-notes-toggle', handler);
      }, []);

      const handleAddNote = useCallback(() => {
        if (!newNoteText.trim()) return;
        const next = [...notes, { id: String(Date.now()), text: newNoteText.trim(), done: false }];
        setNotes(next);
        saveNotes(next);
        setNewNoteText('');
      }, [newNoteText, notes]);

      const handleToggleDone = useCallback((id) => {
        const next = notes.map(n => n.id === id ? { ...n, done: !n.done } : n);
        setNotes(next);
        saveNotes(next);
      }, [notes]);

      const handleDeleteNote = useCallback((id) => {
        const next = notes.filter(n => n.id !== id);
        setNotes(next);
        saveNotes(next);
      }, [notes]);

      const handleInsertToDraft = useCallback((text) => {
        if (inputActions && typeof inputActions.setDraft === 'function') {
          inputActions.setDraft(text);
        }
      }, [inputActions]);

      return h('div', { className: 'dsh-pi-strip-container' },
        // Quick Action Chips Row
        h('div', { className: 'dsh-pi-strip' },
          // Notes toggle chip
          h('button', {
            type: 'button',
            className: `dsh-pi-chip ${notesOpen ? 'dsh-pi-chip-accent' : ''}`,
            onClick: () => setNotesOpen(!notesOpen),
            title: '展开/收起随手记便签'
          }, '📓 随手记' + (notes.length > 0 ? ` (${notes.filter(n => !n.done).length})` : '')),

          // Standard prompt chips
          DEFAULT_PROMPTS.map(p =>
            h('button', {
              key: p.id,
              type: 'button',
              className: 'dsh-pi-chip',
              onClick: () => handleInsertToDraft(p.prompt),
              title: p.prompt
            }, p.label)
          )
        ),

        // Quick Notes Inline Drawer
        notesOpen ? h('div', { className: 'dsh-pi-notes-drawer' },
          h('div', { className: 'dsh-pi-notes-header' },
            h('span', null, '📓 随手记与临时备忘'),
            h('div', { className: 'dsh-pi-notes-actions' },
              h('button', {
                type: 'button',
                className: 'dsh-pi-btn-sm',
                onClick: () => setNotesOpen(false)
              }, '✕ 收起')
            )
          ),
          h('div', { className: 'dsh-pi-notes-list' },
            notes.length === 0
              ? h('div', { style: { padding: '8px', color: 'var(--dsw-alias-label-tertiary, #71717a)', fontSize: '12px' } }, '暂无笔记，在下方输入添加~')
              : notes.map(n =>
                  h('div', { key: n.id, className: 'dsh-pi-notes-item' },
                    h('input', {
                      type: 'checkbox',
                      checked: n.done,
                      onChange: () => handleToggleDone(n.id),
                      style: { cursor: 'pointer' }
                    }),
                    h('span', {
                      className: `dsh-pi-notes-item-text ${n.done ? 'done' : ''}`,
                      title: n.text
                    }, n.text),
                    h('div', { style: { display: 'flex', gap: '4px' } },
                      h('button', {
                        type: 'button',
                        className: 'dsh-pi-btn-sm',
                        onClick: () => handleInsertToDraft(n.text),
                        title: '将笔记内容填入输入框'
                      }, '填入'),
                      h('button', {
                        type: 'button',
                        className: 'dsh-pi-btn-sm',
                        onClick: () => handleDeleteNote(n.id),
                        title: '删除'
                      }, '✕')
                    )
                  )
                )
          ),
          h('div', { className: 'dsh-pi-notes-input-row' },
            h('input', {
              className: 'dsh-pi-notes-input',
              placeholder: '记录一段新备忘，按回车添加...',
              value: newNoteText,
              onChange: (e) => setNewNoteText(e.target.value),
              onKeyDown: (e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddNote();
                }
              }
            }),
            h('button', {
              type: 'button',
              className: 'dsh-pi-btn-sm',
              style: { padding: '4px 10px' },
              onClick: handleAddNote
            }, '添加')
          )
        ) : null
      );
    }

    /**
     * Footer Bar (rendered in `conversation.composer.dock`)
     */
    function FooterBarDock(props) {
      const { useSession, useProjection } = props;
      const session = typeof useSession === 'function' ? useSession(s => s) : null;
      const pressure = typeof useProjection === 'function' ? useProjection('contextPressure') : null;
      const isRunning = Boolean(session?.running);

      // Context meter calculations
      const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens ?? 0;
      const contextWindow = pressure?.contextWindow ?? 1000000;
      const percent = contextWindow > 0 ? Math.min(100, Math.round((usedTokens / contextWindow) * 100)) : 0;

      // Color coding for context pressure
      const barColor = percent > 85 ? '#ef4444' : percent > 60 ? '#f59e0b' : '#10b981';

      // Format token numbers (e.g. 12.4k, 1.2M)
      const formatTokens = (val) => {
        if (!val || val === 0) return '0';
        if (val >= 1000000) return (val / 1000000).toFixed(1) + 'M';
        if (val >= 1000) return (val / 1000).toFixed(1) + 'k';
        return String(val);
      };

      const handleToggleNotes = () => {
        window.dispatchEvent(new CustomEvent('dsh-pi-notes-toggle'));
      };

      return h('div', { className: 'dsh-pi-footer' },
        // Left section: Engine Badge & Status
        h('div', { className: 'dsh-pi-footer-left' },
          h('span', { className: 'dsh-pi-badge' },
            h('span', { className: `dsh-pi-dot ${isRunning ? 'running' : ''}` }),
            'DSH × PI-UI'
          ),
          h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary, #71717a)' } },
            isRunning ? '⚡ 正在执行任务...' : '● 系统就绪'
          )
        ),

        // Right section: Token Meter & Notes Shortcut
        h('div', { className: 'dsh-pi-footer-right' },
          // Token meter
          h('div', {
            className: 'dsh-pi-meter',
            title: `上下文窗口占用: ${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${percent}%)`
          },
            h('span', { className: 'dsh-pi-text-mono' },
              `${formatTokens(usedTokens)} / ${formatTokens(contextWindow)}`
            ),
            h('div', { className: 'dsh-pi-meter-bar' },
              h('div', {
                className: 'dsh-pi-meter-fill',
                style: { width: `${Math.max(2, percent)}%`, backgroundColor: barColor }
              })
            ),
            h('span', {
              className: 'dsh-pi-text-mono',
              style: { color: barColor, fontWeight: 600 }
            }, `${percent}%`)
          ),

          // Quick notes button
          h('button', {
            type: 'button',
            className: 'dsh-pi-btn-sm',
            onClick: handleToggleNotes,
            title: '打开随手记便签'
          }, '📓 便签')
        )
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 1. Inject Stylesheet with cleanup effect
        ctx.effect(() => {
          const styleEl = document.createElement('style');
          styleEl.id = 'dsh-pi-ui-styles';
          styleEl.textContent = CSS_STYLES;
          document.head.appendChild(styleEl);
          return () => {
            styleEl.remove();
          };
        });

        // 2. Register QuickActionsDock into conversation.input.dock
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'pi-quick-actions',
          order: 5,
        }, QuickActionsDock));

        // 3. Register FooterBarDock into conversation.composer.dock
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'pi-footer-bar',
          order: 2,
        }, FooterBarDock));
      },
    };
  },
});
