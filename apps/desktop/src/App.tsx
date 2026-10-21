import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Check, ChevronDown, CircleHelp, Clock3, Download, FolderKanban, History, LayoutDashboard, Monitor, Moon, MoreHorizontal, Pause, Play, Plus, Settings, Sun, Target, Trash2, Trophy, X } from 'lucide-react'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { addTaskToToday, createId, dismissTaskForToday, formatDuration, isFocusSession, isRecordableSession, isTaskVisibleToday, loadState, normalizeTaskKey, rolloverRecurringTasks, saveState, sessionElapsed, todayKey, type ChronoState, type FocusSession, type PomodoroPhase, type Priority, type Project, type Task, type TaskRecurrence, type TimerMode } from './types'

type View = 'today' | 'tasks' | 'projects' | 'history' | 'stats' | 'settings'
type SettingsSection = 'preferences' | 'appearance' | 'data'
const colors = ['#334155', '#52677f', '#71869b', '#7c849e', '#668b8b']
const priorityNames: Record<Priority, string> = { high: '高', medium: '中', low: '低' }
type TimerWidgetPayload = { taskTitle: string; elapsedMs: number; status: FocusSession['status']; phase: PomodoroPhase; theme: 'light' | 'dark' }
type TimerWidgetAction = { action: 'pause' | 'resume' | 'finish' }
type TaskDraft = { title: string; projectId: string; priority: Priority; plannedMinutes: number; recurrence: TaskRecurrence }
type DuplicateCandidate = { draft: TaskDraft; existing: Task; recurringExists: boolean }
const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

export default function App() {
  const isTimerWidget = new URLSearchParams(window.location.search).get('widget') === 'timer'
  return isTimerWidget ? <TimerWidget /> : <MainApp />
}

function MainApp() {
  const [state, setState] = useState<ChronoState>(loadState)
  const [view, setView] = useState<View>('today')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [expandedProjectId, setExpandedProjectId] = useState<string>()
  const [mode, setMode] = useState<TimerMode>(state.settings.defaultMode)
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState<'task' | 'project' | null>(null)
  const [duplicateCandidate, setDuplicateCandidate] = useState<DuplicateCandidate>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [widgetReady, setWidgetReady] = useState(0)
  const widgetCreationPending = useRef(false)
  useEffect(() => saveState(state), [state])
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer) }, [])
  useEffect(() => { setState((current) => rolloverRecurringTasks(current, now)) }, [now])
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const applyTheme = () => {
      const theme = state.settings.theme === 'system' ? (media.matches ? 'dark' : 'light') : state.settings.theme
      document.documentElement.dataset.theme = theme
    }
    applyTheme()
    if (state.settings.theme !== 'system') return
    media.addEventListener?.('change', applyTheme)
    return () => media.removeEventListener?.('change', applyTheme)
  }, [state.settings.theme])
  useEffect(() => { if (toast) { const timer = window.setTimeout(() => setToast(''), 2200); return () => clearTimeout(timer) } }, [toast])
  useEffect(() => {
    if (!helpOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelpOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [helpOpen])
  const active = state.sessions.find((session) => session.status === 'running' || session.status === 'paused')
  const activeTask = state.tasks.find((task) => task.id === active?.taskId)
  const todayStart = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }, [now])
  const dayKey = todayKey(now)
  const todaySessions = state.sessions.filter((session) => new Date(session.startedAt).getTime() >= todayStart)
  const todayFocus = todaySessions.filter((session) => isFocusSession(session) && isRecordableSession(session, now)).reduce((sum, session) => sum + sessionElapsed(session, now), 0)
  const completedToday = state.tasks.filter((task) => task.status === 'done' && task.completedAt && new Date(task.completedAt).getTime() >= todayStart).length
  const update = (fn: (value: ChronoState) => ChronoState) => setState((value) => fn(value))
  const notify = (message: string) => setToast(message)

  function startTimer(taskId: string, requestedMode = mode) {
    const task = state.tasks.find((item) => item.id === taskId); if (!task) return
    if (active?.taskId === taskId) return notify('当前任务已经在计时')
    const iso = new Date().toISOString()
    const session: FocusSession = { id: createId('session'), taskId, projectId: task.projectId, mode: requestedMode, phase: 'focus', pomodoroIndex: 1, startedAt: iso, accumulatedMs: 0, status: 'running' }
    update((current) => ({ ...current, sessions: [...current.sessions.map((item) => item.status === 'running' ? closeRunning(item, now, current.settings.switchBehavior) : item), session], tasks: current.tasks.map((item) => item.id === taskId ? { ...item, status: 'running', updatedAt: iso } : (item.status === 'running' ? { ...item, status: 'todo', updatedAt: iso } : item)) }))
    setSelectedTaskId(taskId); notify(requestedMode === 'pomodoro' ? '番茄钟已开始' : '计时已开始')
  }
  function pauseTimer() { if (!active || active.status !== 'running') return; update((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === active.id ? { ...item, accumulatedMs: sessionElapsed(item, now), pausedAt: new Date().toISOString(), status: 'paused' } : item) })); notify('计时已暂停') }
  function resumeTimer() { if (!active || active.status !== 'paused') return; update((current) => ({ ...current, sessions: current.sessions.map((item) => item.id === active.id ? { ...item, startedAt: new Date().toISOString(), pausedAt: undefined, status: 'running' } : item) })); notify('计时已继续') }
  function finishTimer(cancelled = false) { if (!active) return; const elapsed = sessionElapsed(active, now); const ended = { ...active, accumulatedMs: elapsed, endedAt: new Date().toISOString(), status: cancelled ? 'cancelled' as const : 'completed' as const }; const recordable = isRecordableSession(active, now); update((current) => ({ ...current, sessions: [...current.sessions.filter((item) => item.id !== active.id), ...(recordable ? [ended] : [])], tasks: current.tasks.map((task) => task.id === active.taskId ? { ...task, status: 'todo' as const, updatedAt: new Date().toISOString() } : task) })); notify(recordable ? (cancelled ? '会话已取消，实际时长已保留' : '会话已保存') : '未满 1 分钟，本次会话未记录') }
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen('timer-widget-ready', () => setWidgetReady((value) => value + 1)).then((stop) => { unlisten = stop })
    return () => unlisten?.()
  }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen<TimerWidgetAction>('timer-widget-action', ({ payload }) => {
      if (payload.action === 'pause') pauseTimer()
      if (payload.action === 'resume') resumeTimer()
      if (payload.action === 'finish') finishTimer()
    }).then((stop) => { unlisten = stop })
    return () => unlisten?.()
  }, [active?.id, active?.status, now])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    const syncWidget = async () => {
      const widget = await WebviewWindow.getByLabel('timer-widget')
      if (!active || !activeTask) {
        await widget?.close().catch(() => undefined)
        return
      }
      const payload: TimerWidgetPayload = {
        taskTitle: activeTask.title,
        elapsedMs: sessionElapsed(active, now),
        status: active.status,
        phase: active.phase,
        theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      }
      if (widget) {
        await emitTo('timer-widget', 'timer-widget-state', payload).catch(() => undefined)
        return
      }
      if (widgetCreationPending.current) return
      widgetCreationPending.current = true
      const monitor = await currentMonitor()
      if (cancelled) { widgetCreationPending.current = false; return }
      const width = 260
      const height = 112
      const margin = 20
      const workPosition = monitor?.workArea.position.toLogical(monitor.scaleFactor)
      const workSize = monitor?.workArea.size.toLogical(monitor.scaleFactor)
      const timerWidget = new WebviewWindow('timer-widget', {
        url: '/?widget=timer',
        title: 'ChronoDesk 计时器',
        width,
        height,
        x: workPosition && workSize ? workPosition.x + workSize.width - width - margin : undefined,
        y: workPosition && workSize ? workPosition.y + workSize.height - height - margin : undefined,
        decorations: false,
        resizable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        focus: false,
        visible: false,
      })
      timerWidget.once('tauri://created', async () => {
        widgetCreationPending.current = false
        if (cancelled) { await timerWidget.close(); return }
        await timerWidget.setAlwaysOnTop(true)
        await timerWidget.show()
      })
      timerWidget.once('tauri://error', () => { widgetCreationPending.current = false })
    }
    void syncWidget().catch(() => undefined)
    return () => { cancelled = true }
  }, [active, activeTask, now, state.settings.theme, widgetReady])
  useEffect(() => { if (!active || active.status !== 'running' || active.mode !== 'pomodoro') return; const limit = phaseDuration(active.phase, state.settings); if (sessionElapsed(active, now) < limit) return; const finished = { ...active, accumulatedMs: limit, endedAt: new Date().toISOString(), status: 'completed' as const }; const nextPhase: PomodoroPhase = active.phase === 'focus' ? (active.pomodoroIndex % state.settings.longBreakEvery === 0 ? 'long_break' : 'short_break') : 'focus'; const next: FocusSession = { id: createId('session'), taskId: active.taskId, projectId: active.projectId, mode: 'pomodoro', phase: nextPhase, pomodoroIndex: nextPhase === 'focus' ? active.pomodoroIndex + 1 : active.pomodoroIndex, startedAt: new Date().toISOString(), accumulatedMs: 0, status: nextPhase === 'focus' || state.settings.autoStartBreak ? 'running' : 'paused' }; update((current) => ({ ...current, sessions: [...current.sessions.filter((item) => item.id !== active.id), ...(isRecordableSession(active, now) ? [finished] : []), next] })); notify(nextPhase === 'focus' ? '休息结束，新的专注开始' : '专注完成，进入休息') }, [now])
  function createTask(draft: TaskDraft, force = false) {
    const matches = state.tasks.filter((task) => normalizeTaskKey(task) === normalizeTaskKey(draft))
    const recurringTask = matches.find((task) => task.recurrence === 'daily')
    const existing = recurringTask ?? matches[0]
    if (existing && !force) { setDuplicateCandidate({ draft, existing, recurringExists: Boolean(recurringTask) }); setModal(null); return }
    const iso = new Date().toISOString()
    const task: Task = { id: createId('task'), title: draft.title, description: '', projectId: draft.projectId, priority: draft.priority, recurrence: draft.recurrence, status: 'todo', plannedMs: draft.plannedMinutes * 60000, sortOrder: state.tasks.length, createdAt: iso, updatedAt: iso, todayAddedOn: draft.recurrence === 'none' ? dayKey : undefined }
    update((current) => ({ ...current, tasks: [...current.tasks, task] }))
    setSelectedTaskId(task.id); setModal(null); setDuplicateCandidate(undefined); notify('任务已创建')
  }
  function reuseDuplicate(asRecurring: boolean) {
    if (!duplicateCandidate) return
    const { existing } = duplicateCandidate
    const iso = new Date().toISOString()
    update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === existing.id ? { ...task, ...(asRecurring ? { recurrence: 'daily' as const, status: 'todo' as const, completedAt: undefined, todayAddedOn: undefined, todayDismissedOn: undefined } : {}), updatedAt: iso } : task) }))
    setSelectedTaskId(existing.id); setDuplicateCandidate(undefined); notify(asRecurring ? '已将任务设为长期任务，已加入今日任务' : '已复用已有任务')
  }
  function createProject(name: string, color: string) { const project: Project = { id: createId('project'), name, color, archived: false, createdAt: new Date().toISOString() }; update((current) => ({ ...current, projects: [...current.projects, project] })); setModal(null); notify('项目已创建') }
  function deleteProject(projectId: string) { const project = state.projects.find((item) => item.id === projectId); if (!project || !window.confirm(`删除项目“${project.name}”后，关联任务会保留为未分类。确定继续吗？`)) return; const iso = new Date().toISOString(); update((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== projectId), tasks: current.tasks.map((task) => task.projectId === projectId ? { ...task, projectId: '', updatedAt: iso } : task), sessions: current.sessions.map((session) => session.projectId === projectId ? { ...session, projectId: '' } : session) })); notify('项目已删除') }
  function reorderProjects(sourceId: string, targetId: string) { if (sourceId === targetId) return; update((current) => { const projects = [...current.projects]; const sourceIndex = projects.findIndex((project) => project.id === sourceId); const targetIndex = projects.findIndex((project) => project.id === targetId); if (sourceIndex < 0 || targetIndex < 0) return current; const [moved] = projects.splice(sourceIndex, 1); projects.splice(targetIndex, 0, moved); return { ...current, projects } }) }
  function toggleTask(taskId: string) { const iso = new Date().toISOString(); update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, status: task.status === 'done' ? 'todo' : 'done', completedAt: task.status === 'done' ? undefined : iso, updatedAt: iso } : task) })) }
  function addToToday(taskId: string) { update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? addTaskToToday(task, dayKey) : task) })); notify('任务已加入今日待办') }
  function dismissFromToday(taskId: string) { if (active?.taskId === taskId) return notify('当前任务正在计时，请先结束计时'); update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? dismissTaskForToday(task, dayKey) : task) })); notify('任务已从今日待办移除') }
  function updateTask(taskId: string, changes: Partial<Pick<Task, 'priority' | 'recurrence' | 'description'>>) { const iso = new Date().toISOString(); update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, ...changes, updatedAt: iso } : task) })) }
  function deleteTask(taskId: string) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; const message = task.recurrence === 'daily' ? '这是长期任务。删除后任务实体会移除，但历史专注会话仍会保留。确定继续吗？' : '删除任务不会删除历史计时记录，确定继续吗？'; if (!window.confirm(message)) return; update((current) => ({ ...current, tasks: current.tasks.filter((task) => task.id !== taskId) })); notify('任务已删除') }
  function deleteTasks(taskIds: string[]) { const ids = new Set(taskIds); if (state.sessions.some((session) => ids.has(session.taskId) && (session.status === 'running' || session.status === 'paused'))) { notify('选中的任务中有正在计时或已暂停的任务，请先结束计时'); return false } const includesRecurring = state.tasks.some((task) => ids.has(task.id) && task.recurrence === 'daily'); const message = includesRecurring ? `选中任务中包含长期任务。删除后任务实体会移除，但历史专注会话仍会保留。确定删除 ${ids.size} 个任务吗？` : `确定删除选中的 ${ids.size} 个任务吗？历史计时记录会保留。`; if (!window.confirm(message)) return false; update((current) => ({ ...current, tasks: current.tasks.filter((task) => !ids.has(task.id)) })); if (selectedTaskId && ids.has(selectedTaskId)) setSelectedTaskId(undefined); notify(`已删除 ${ids.size} 个任务`); return true }
  function exportData() { const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' })); link.download = `chronodesk-${new Date().toISOString().slice(0, 10)}.json`; link.click(); notify('数据已导出') }
  const titles: Record<View, string> = { today: '今日工作台', tasks: '所有任务', projects: '项目管理', history: '专注记录', stats: '数据统计', settings: '设置' }
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><img className="brand-logo" src="/logo.png" alt="ChronoDesk" /></div><div><strong>ChronoDesk</strong><span>个人效率工作台</span></div></div><nav className="main-nav"><NavItem icon={LayoutDashboard} label="今日工作台" active={view === 'today'} onClick={() => setView('today')} /><NavItem icon={Check} label="所有任务" count={state.tasks.filter((task) => task.status !== 'done').length} active={view === 'tasks'} onClick={() => setView('tasks')} /><NavItem icon={FolderKanban} label="项目管理" active={view === 'projects'} onClick={() => setView('projects')} /><NavItem icon={History} label="专注记录" active={view === 'history'} onClick={() => setView('history')} /><NavItem icon={BarChart3} label="数据统计" active={view === 'stats'} onClick={() => setView('stats')} /></nav><div className="sidebar-divider" /><div className="nav-caption">项目</div>{state.projects.slice(0, 4).map((project) => <button className={`project-link ${expandedProjectId === project.id ? 'selected' : ''}`} key={project.id} onClick={() => { setExpandedProjectId(project.id); setView('projects') }}><i style={{ background: project.color }} />{project.name}</button>)}{!state.projects.length && <span className="sidebar-empty">创建项目后会显示在这里</span>}<div className="sidebar-bottom"><NavItem icon={Settings} label="设置" active={view === 'settings'} onClick={() => setView('settings')} /><div className="data-status"><i />本地数据已保存</div><small>ChronoDesk v0.2.0 · Windows</small></div></aside><main className="main-content"><header className="topbar"><div className="breadcrumbs"><span>ChronoDesk</span><ChevronDown size={13} /><strong>{titles[view]}</strong></div><div className="top-actions"><button className="icon-button" aria-label="帮助" title="帮助" onClick={() => setHelpOpen(true)}><CircleHelp size={16} /></button></div></header>{view === 'today' && <TodayView tasks={state.tasks} projects={state.projects} sessions={state.sessions} now={now} dayKey={dayKey} todayFocus={todayFocus} completedToday={completedToday} settings={state.settings} activeTask={activeTask} active={active} mode={mode} setMode={setMode} onStart={startTimer} onPause={pauseTimer} onResume={resumeTimer} onFinish={() => finishTimer()} onNew={() => setModal('task')} onSelect={(id) => { setSelectedTaskId(id); setView('tasks') }} onToggle={toggleTask} onDismissToday={dismissFromToday} />}{view === 'tasks' && <TasksView tasks={state.tasks} projects={state.projects} sessions={state.sessions} now={now} dayKey={dayKey} selectedId={selectedTaskId} onNew={() => setModal('task')} onStart={startTimer} onSelect={setSelectedTaskId} onToggle={toggleTask} onDelete={deleteTask} onDeleteMany={deleteTasks} onAddToToday={addToToday} onUpdateTask={updateTask} />}{view === 'projects' && <ProjectsView projects={state.projects} tasks={state.tasks} sessions={state.sessions} expandedProjectId={expandedProjectId} onExpand={setExpandedProjectId} onSelectTask={(id) => { setSelectedTaskId(id); setView('tasks') }} onNew={() => setModal('project')} onDelete={deleteProject} onReorder={reorderProjects} />}{view === 'history' && <HistoryView sessions={state.sessions} tasks={state.tasks} projects={state.projects} />}{view === 'stats' && <StatsView sessions={state.sessions} tasks={state.tasks} projects={state.projects} dailyGoalMs={state.settings.dailyGoalMs} />}{view === 'settings' && <SettingsView settings={state.settings} onChange={(settings) => update((current) => ({ ...current, settings }))} onExport={exportData} />}</main>{modal === 'task' && <TaskModal projects={state.projects} onClose={() => setModal(null)} onCreate={createTask} />}{modal === 'project' && <ProjectModal onClose={() => setModal(null)} onCreate={createProject} />}{duplicateCandidate && <DuplicateTaskModal candidate={duplicateCandidate} onMakeRecurring={() => reuseDuplicate(true)} onCreateAnyway={() => createTask(duplicateCandidate.draft, true)} onClose={() => setDuplicateCandidate(undefined)} />}{helpOpen && <Modal title="帮助" eyebrow="ChronoDesk" onClose={() => setHelpOpen(false)}><div className="help-content"><strong>联系我们</strong><span>zerovista（小红书号）</span></div></Modal>}{toast && <div className="toast"><Check size={15} />{toast}</div>}</div>
}

function TimerWidget() {
  const [timer, setTimer] = useState<TimerWidgetPayload>({ taskTitle: '正在同步计时', elapsedMs: 0, status: 'paused', phase: 'focus', theme: 'light' })
  const lastSync = useRef(Date.now())
  const [now, setNow] = useState(Date.now())
  const widgetWindow = isTauriRuntime() ? getCurrentWindow() : undefined
  useEffect(() => { const interval = window.setInterval(() => setNow(Date.now()), 250); return () => clearInterval(interval) }, [])
  useEffect(() => { document.body.classList.add('timer-widget-body'); return () => document.body.classList.remove('timer-widget-body') }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen<TimerWidgetPayload>('timer-widget-state', ({ payload }) => { lastSync.current = Date.now(); setTimer(payload) }).then((stop) => { unlisten = stop })
    void emit('timer-widget-ready')
    return () => unlisten?.()
  }, [])
  const elapsed = timer.status === 'running' ? timer.elapsedMs + (now - lastSync.current) : timer.elapsedMs
  const phaseLabel = timer.phase === 'focus' ? '专注中' : timer.phase === 'short_break' ? '短休息' : '长休息'
  const sendAction = (action: TimerWidgetAction['action']) => { if (isTauriRuntime()) void emit('timer-widget-action', { action } satisfies TimerWidgetAction) }
  return <div className="timer-widget-root" data-theme={timer.theme}>
    <div className="timer-widget-drag" data-tauri-drag-region onMouseDown={() => { if (isTauriRuntime()) void widgetWindow?.startDragging() }}>
      <span>{phaseLabel}{timer.status === 'paused' ? ' · 已暂停' : ''}</span>
      <Clock3 size={16} />
    </div>
    <strong title={timer.taskTitle}>{timer.taskTitle}</strong>
    <div className="timer-widget-footer">
      <time>{formatDuration(elapsed)}</time>
      <div className="timer-widget-actions">
        <button className="timer-widget-pause" onClick={() => sendAction(timer.status === 'running' ? 'pause' : 'resume')} aria-label={timer.status === 'running' ? '暂停计时' : '继续计时'}>{timer.status === 'running' ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}</button>
        <button className="timer-widget-finish" onClick={() => sendAction('finish')} aria-label="结束并保存"><Check size={16} /></button>
      </div>
    </div>
  </div>
}

function NavItem({ icon: Icon, label, count, active, onClick }: { icon: typeof LayoutDashboard; label: string; count?: number; active: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? 'selected' : ''}`} onClick={onClick}><Icon size={16} /><span>{label}</span>{count !== undefined && <em>{count}</em>}</button> }
function TodayView({ tasks, projects, sessions, now, dayKey, todayFocus, completedToday, settings, activeTask, active, mode, setMode, onStart, onPause, onResume, onFinish, onNew, onSelect, onToggle, onDismissToday }: { tasks: Task[]; projects: Project[]; sessions: FocusSession[]; now: number; dayKey: string; todayFocus: number; completedToday: number; settings: ChronoState['settings']; activeTask?: Task; active?: FocusSession; mode: TimerMode; setMode: (mode: TimerMode) => void; onStart: (id: string, mode?: TimerMode) => void; onPause: () => void; onResume: () => void; onFinish: () => void; onNew: () => void; onSelect: (id: string) => void; onToggle: (id: string) => void; onDismissToday: (id: string) => void }) { const open = tasks.filter((task) => task.status !== 'done' && isTaskVisibleToday(task, dayKey)).sort((a, b) => a.sortOrder - b.sortOrder); const progress = Math.min(100, Math.round(todayFocus / settings.dailyGoalMs * 100)); return <div className="page today-page"><div className="page-heading"><div><span className="eyebrow">{formatDate(new Date())}</span><h1>今天，专注做好一件事。</h1><p>清晰地知道下一步做什么，时间自然会留下答案。</p></div><button className="primary-button" onClick={onNew}><Plus size={15} />新建任务</button></div><div className="daily-metrics"><Metric icon={Target} label="今日专注" value={formatDuration(todayFocus, false)} hint={`${progress}% · 目标 ${formatDuration(settings.dailyGoalMs, false)}`} /><Metric icon={Check} label="完成任务" value={String(completedToday)} hint={`还有 ${open.length} 个待完成`} /><Metric icon={Trophy} label="专注会话" value={String(sessions.filter((session) => session.status === 'completed' && isFocusSession(session) && isRecordableSession(session, now)).length)} hint="每一次记录都算数" /></div><div className="today-layout"><section><div className="section-heading"><div><h2>今天的任务</h2><span>{open.length ? `${open.length} 个待处理` : '今天暂时没有任务'}</span></div><button className="text-button" onClick={onNew}><Plus size={14} />快速新增</button></div>{open.length ? <div className="task-list">{open.map((task) => <TaskRow key={task.id} task={task} project={projects.find((project) => project.id === task.projectId)} sessions={sessions} now={now} onStart={onStart} onSelect={onSelect} onToggle={onToggle} todayMode dayKey={dayKey} onDismissToday={onDismissToday} />)}</div> : <EmptyState icon={Check} title="今天的清单是空的" description="新建一个任务，给今天一个明确的开始。" action="新建任务" onAction={onNew} />}</section><FocusPanel task={activeTask} session={active} mode={mode} setMode={setMode} now={now} onStart={onStart} onPause={onPause} onResume={onResume} onFinish={onFinish} /></div><section className="progress-strip"><div className="section-heading"><div><h2>今日进度</h2><span>只统计真实完成的专注时间</span></div><strong>{progress}%</strong></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></section></div> }
function FocusPanel({ task, session, mode, setMode, now, onStart, onPause, onResume, onFinish }: { task?: Task; session?: FocusSession; mode: TimerMode; setMode: (mode: TimerMode) => void; now: number; onStart: (id: string, mode?: TimerMode) => void; onPause: () => void; onResume: () => void; onFinish: () => void }) {
  const elapsed = session ? sessionElapsed(session, now) : 0
  return <section className={`focus-panel ${session ? 'active' : ''}`}><div className="section-heading"><div><span className="eyebrow">当前专注</span><h2>{task?.title ?? '选择一个任务开始'}</h2></div></div>{task ? <><span className="focus-context">{session?.phase === 'short_break' ? '短休息' : session?.phase === 'long_break' ? '长休息' : '专注阶段'} · {session?.mode === 'pomodoro' || mode === 'pomodoro' ? '番茄钟' : '正计时'}</span><div className="timer-tabs"><button className={mode === 'stopwatch' ? 'active' : ''} onClick={() => setMode('stopwatch')}>正计时</button><button className={mode === 'pomodoro' ? 'active' : ''} onClick={() => setMode('pomodoro')}>番茄钟</button></div><div className="big-timer">{formatDuration(elapsed)}</div><div className="focus-actions">{session?.status === 'running' ? <button className="pause-button" onClick={onPause}><Pause size={16} fill="currentColor" />暂停</button> : session?.status === 'paused' ? <button className="primary-button" onClick={onResume}><Play size={16} fill="currentColor" />继续</button> : <button className="primary-button" onClick={() => onStart(task.id, mode)}><Play size={16} fill="currentColor" />开始专注</button>}{session && <button className="finish-button" onClick={onFinish}><Check size={15} />结束并保存</button>}</div><span className="focus-hint">窗口失焦、切换页面或系统休眠不会影响计时</span></> : <div className="focus-empty-state"><div><Clock3 size={20} /></div><strong>还没有正在进行的专注</strong><span>从左侧任务列表开始一段专注时间。</span></div>}</section>
}
function TasksView({ tasks, projects, sessions, now, dayKey, selectedId, onNew, onStart, onSelect, onToggle, onDelete, onDeleteMany, onAddToToday, onUpdateTask }: { tasks: Task[]; projects: Project[]; sessions: FocusSession[]; now: number; dayKey: string; selectedId?: string; onNew: () => void; onStart: (id: string) => void; onSelect: (id: string) => void; onToggle: (id: string) => void; onDelete: (id: string) => void; onDeleteMany: (ids: string[]) => boolean; onAddToToday: (id: string) => void; onUpdateTask: (id: string, changes: Partial<Pick<Task, 'priority' | 'recurrence' | 'description'>>) => void }) {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0]
  const toggleSelection = (id: string) => setSelectedTaskIds((current) => current.includes(id) ? current.filter((taskId) => taskId !== id) : [...current, id])
  const cancelSelection = () => { setSelectedTaskIds([]); setSelectionMode(false) }
  const selectAll = () => setSelectedTaskIds(selectedTaskIds.length === tasks.length ? [] : tasks.map((task) => task.id))
  const deleteSelected = () => { if (onDeleteMany(selectedTaskIds)) cancelSelection() }
  return <div className="page tasks-page content-page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 任务</span><h1>所有任务</h1><p>把需要完成的事放在一个清晰的地方。</p></div><button className="primary-button" onClick={onNew}><Plus size={15} />新建任务</button></div><div className="content-columns"><section className="task-list-panel"><div className="list-toolbar"><span>{selectionMode ? `已选择 ${selectedTaskIds.length} / ${tasks.length} 个任务` : `${tasks.length} 个任务`}</span>{tasks.length > 0 && <div className="bulk-actions">{selectionMode ? <><button className="text-button" onClick={selectAll}>{selectedTaskIds.length === tasks.length ? '取消全选' : '全选'}</button><button className="danger-button" disabled={!selectedTaskIds.length} onClick={deleteSelected}><Trash2 size={14} />删除所选</button><button className="secondary-button" onClick={cancelSelection}>取消</button></> : <button className="secondary-button" onClick={() => setSelectionMode(true)}>批量管理</button>}</div>}</div>{tasks.length ? tasks.map((task) => <TaskRow key={task.id} task={task} project={projects.find((project) => project.id === task.projectId)} sessions={sessions} now={now} dayKey={dayKey} selected={task.id === selected?.id} selectionMode={selectionMode} selectedForBulk={selectedTaskIds.includes(task.id)} onStart={onStart} onSelect={onSelect} onToggle={onToggle} onToggleSelection={toggleSelection} onAddToToday={onAddToToday} />) : <EmptyState icon={Check} title="还没有任务" description="创建一个任务，开始组织你的时间。" action="新建任务" onAction={onNew} />}</section><TaskDetail task={selected} project={projects.find((project) => project.id === selected?.projectId)} sessions={sessions} now={now} dayKey={dayKey} onStart={onStart} onDelete={onDelete} onAddToToday={onAddToToday} onUpdateTask={onUpdateTask} /></div></div>
}
function TaskRow({ task, project, sessions, now, dayKey, selected, todayMode = false, selectionMode = false, selectedForBulk = false, onStart, onSelect, onToggle, onToggleSelection, onAddToToday, onDismissToday }: { task: Task; project?: Project; sessions: FocusSession[]; now: number; dayKey?: string; selected?: boolean; todayMode?: boolean; selectionMode?: boolean; selectedForBulk?: boolean; onStart: (id: string) => void; onSelect: (id: string) => void; onToggle: (id: string) => void; onToggleSelection?: (id: string) => void; onAddToToday?: (id: string) => void; onDismissToday?: (id: string) => void }) {
  const actual = sessions.filter((session) => session.taskId === task.id && isFocusSession(session)).reduce((sum, session) => sum + sessionElapsed(session, now), 0)
  const checked = selectionMode ? selectedForBulk : task.status === 'done'
  const handleRowClick = () => selectionMode ? onToggleSelection?.(task.id) : onSelect(task.id)
  return <div className={`task-row ${selected ? 'selected' : ''} ${task.status === 'done' ? 'task-done' : ''} ${selectionMode ? 'bulk-select-row' : ''}`} onClick={handleRowClick}><button className={`check-box ${checked ? 'checked' : ''}`} aria-label={selectionMode ? (checked ? '取消选择任务' : '选择任务') : (task.status === 'done' ? '标记为待办' : '标记为完成')} onClick={(event) => { event.stopPropagation(); selectionMode ? onToggleSelection?.(task.id) : onToggle(task.id) }}>{checked && <span className="check-mark" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="m3.25 8.25 3.1 3.1 6.4-6.7" /></svg></span>}</button><div className="task-main"><strong className={task.status === 'done' ? 'done-text' : ''}>{task.title}</strong><span><i style={{ background: project?.color }} />{project?.name ?? '未分类'}</span></div><span className={`priority ${task.priority}`}>{priorityNames[task.priority]}</span><span className="task-time">{formatDuration(actual, false)} <small>/ {formatDuration(task.plannedMs, false)}</small></span>{!selectionMode && <>{todayMode && task.status !== 'done' && <button className="row-dismiss" title="取消今日任务" aria-label="取消今日任务" onClick={(event) => { event.stopPropagation(); onDismissToday?.(task.id) }}><X size={14} /></button>}{!todayMode && (task.recurrence === 'daily' || task.todayDismissedOn === dayKey) && <button className="row-add-today" onClick={(event) => { event.stopPropagation(); onAddToToday?.(task.id) }}>加入今日</button>}<button className="row-start" title="开始计时" onClick={(event) => { event.stopPropagation(); onStart(task.id) }}><Play size={13} fill="currentColor" /></button></>}</div>
}
function TaskDescriptionEditor({ value, onSave }: { value: string; onSave: (description: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  if (!editing) return <button className={`task-description ${value ? 'has-description' : 'empty-description'}`} onClick={() => { setDraft(value); setEditing(true) }}>{value || '添加描述'}</button>
  return <div className="task-description-editor"><textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="写下任务描述…" /><div><button className="secondary-button" onClick={() => { setDraft(value); setEditing(false) }}>取消</button><button className="primary-button" onClick={() => { onSave(draft.trim()); setEditing(false) }}>保存</button></div></div>
}

function TaskDetail({ task, project, sessions, now, dayKey, onStart, onDelete, onAddToToday, onUpdateTask }: { task?: Task; project?: Project; sessions: FocusSession[]; now: number; dayKey: string; onStart: (id: string) => void; onDelete: (id: string) => void; onAddToToday: (id: string) => void; onUpdateTask: (id: string, changes: Partial<Pick<Task, 'priority' | 'recurrence' | 'description'>>) => void }) { if (!task) return <aside className="detail-panel empty-detail"><FolderKanban size={24} /><span>选择任务查看详情</span></aside>; const rows = sessions.filter((session) => session.taskId === task.id && isRecordableSession(session, now)).sort((a, b) => b.startedAt.localeCompare(a.startedAt)); const addedToday = task.todayAddedOn === dayKey && task.todayDismissedOn !== dayKey; return <aside className="detail-panel"><div className="detail-kicker">任务详情</div><div className="detail-title"><i style={{ background: project?.color }} /><div><h2>{task.title}</h2><span>{project?.name ?? '未分类'}</span></div></div><TaskDescriptionEditor key={task.id} value={task.description} onSave={(description) => onUpdateTask(task.id, { description })} />{task.recurrence === 'daily' && <button className="add-today-detail" onClick={() => onAddToToday(task.id)} disabled={addedToday}>{addedToday ? '已加入今日' : '加入今日'}</button>}<div className="task-detail-options"><div><strong>优先级</strong><div className="priority-picker">{(['low', 'medium', 'high'] as Priority[]).map((priority) => <button key={priority} className={task.priority === priority ? 'active' : ''} onClick={() => onUpdateTask(task.id, { priority })}>{priorityNames[priority]}</button>)}</div></div><label className="recurrence-toggle"><input type="checkbox" checked={task.recurrence === 'daily'} onChange={(event) => onUpdateTask(task.id, { recurrence: event.target.checked ? 'daily' : 'none' })} />长期任务</label></div><div className="detail-stats"><div><span>实际投入</span><strong>{formatDuration(rows.filter(isFocusSession).reduce((sum, session) => sum + sessionElapsed(session, now), 0), false)}</strong></div><div><span>目标时间</span><strong>{formatDuration(task.plannedMs, false)}</strong></div></div><button className="wide-start" onClick={() => onStart(task.id)}><Play size={14} fill="currentColor" />开始计时</button><div className="mini-history"><div className="section-heading"><h3>历史会话</h3><span>{rows.length} 条</span></div>{rows.slice(0, 5).map((session) => <div className="mini-session" key={session.id}><i className={`session-dot ${session.status}`} /><div><strong>{session.phase === 'focus' ? '专注' : '休息'} · {session.mode === 'pomodoro' ? '番茄钟' : '正计时'}</strong><span>{formatDate(new Date(session.startedAt))} · {formatTime(new Date(session.startedAt))}</span></div><b>{formatDuration(sessionElapsed(session, now), false)}</b></div>)}</div><button className="danger-button" onClick={() => onDelete(task.id)}><Trash2 size={14} />删除任务</button></aside> }
function ProjectsView({ projects, tasks, sessions, expandedProjectId, onExpand, onSelectTask, onNew, onDelete, onReorder }: { projects: Project[]; tasks: Task[]; sessions: FocusSession[]; expandedProjectId?: string; onExpand: (id: string | undefined) => void; onSelectTask: (id: string) => void; onNew: () => void; onDelete: (id: string) => void; onReorder: (sourceId: string, targetId: string) => void }) {
  const [menuId, setMenuId] = useState<string>()
  const [draggedId, setDraggedId] = useState<string>()
  const [dragOverId, setDragOverId] = useState<string>()
  const suppressClickRef = useRef(false)

  useEffect(() => {
    if (!menuId) return
    const closeMenu = () => setMenuId(undefined)
    document.addEventListener('click', closeMenu)
    return () => document.removeEventListener('click', closeMenu)
  }, [menuId])

  function clearDrag() {
    setDraggedId(undefined)
    setDragOverId(undefined)
    window.setTimeout(() => { suppressClickRef.current = false }, 200)
  }
  function dropProject(targetId: string) { if (draggedId && draggedId !== targetId) onReorder(draggedId, targetId); clearDrag() }
  function toggleExpanded(projectId: string) {
    if (suppressClickRef.current) return
    onExpand(expandedProjectId === projectId ? undefined : projectId)
  }

  return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 项目</span><h1>项目管理</h1><p>用项目给任务一个稳定的上下文。</p></div><button className="primary-button" onClick={onNew}><Plus size={15} />新建项目</button></div>{projects.length ? <div className="project-grid">{projects.map((project) => { const projectTasks = tasks.filter((task) => task.projectId === project.id); const total = sessions.filter((session) => session.projectId === project.id && isFocusSession(session)).reduce((sum, session) => sum + session.accumulatedMs, 0); const expanded = expandedProjectId === project.id; return <div className={`project-card ${expanded ? 'expanded' : ''} ${draggedId === project.id ? 'dragging' : ''} ${dragOverId === project.id ? 'drag-over' : ''}`} key={project.id} role="button" tabIndex={0} aria-expanded={expanded} onClick={() => toggleExpanded(project.id)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleExpanded(project.id) } }} draggable onDragStart={() => { suppressClickRef.current = true; setDraggedId(project.id) }} onDragOver={(event) => { event.preventDefault(); if (draggedId !== project.id) setDragOverId(project.id) }} onDrop={(event) => { event.preventDefault(); dropProject(project.id) }} onDragEnd={clearDrag}><div className="project-card-top"><span className="project-symbol" style={{ background: project.color }}><FolderKanban size={17} /></span><div className="project-actions"><button className="project-menu-button" aria-label={`打开${project.name}项目菜单`} title="项目菜单" onClick={(event) => { event.stopPropagation(); setMenuId(menuId === project.id ? undefined : project.id) }}><MoreHorizontal size={16} /></button>{menuId === project.id && <div className="project-menu" onClick={(event) => event.stopPropagation()}><button className="project-menu-danger" onClick={() => { setMenuId(undefined); onDelete(project.id) }}><Trash2 size={14} />删除项目</button></div>}</div></div><strong>{project.name}</strong><span>{projectTasks.length} 个任务 · {formatDuration(total, false)} 已投入</span><div className="project-progress"><i style={{ width: `${projectTasks.length ? projectTasks.filter((task) => task.status === 'done').length / projectTasks.length * 100 : 0}%`, background: project.color }} /></div>{expanded && <div className="project-task-list" onClick={(event) => event.stopPropagation()}><div className="project-task-heading">项目任务 <span>{projectTasks.length}</span></div>{projectTasks.length ? projectTasks.map((task) => <button className={`project-task-row ${task.status === 'done' ? 'done' : ''}`} key={task.id} onClick={() => onSelectTask(task.id)}><span className="project-task-title">{task.title}</span><span className="project-task-status">{task.status === 'done' ? '已完成' : '待完成'}</span><span className={`priority ${task.priority}`}>{priorityNames[task.priority]}</span></button>) : <span className="project-tasks-empty">此项目还没有任务</span>}</div>}</div> })}</div> : <EmptyState icon={FolderKanban} title="还没有项目" description="把相互关联的任务放在同一个项目中。" action="新建项目" onAction={onNew} />}</div>
}function HistoryView({ sessions, tasks, projects }: { sessions: FocusSession[]; tasks: Task[]; projects: Project[] }) { const rows = sessions.filter((session) => session.status === 'completed').sort((a, b) => b.startedAt.localeCompare(a.startedAt)); return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 记录</span><h1>专注记录</h1><p>每一次真实投入都会在这里留下记录。</p></div><button className="secondary-button"><Download size={14} />导出记录</button></div><div className="history-summary"><div><span>记录总数</span><strong>{rows.length}</strong></div><div><span>有效专注</span><strong>{formatDuration(rows.filter(isFocusSession).reduce((sum, session) => sum + session.accumulatedMs, 0), false)}</strong></div><div><span>番茄周期</span><strong>{rows.filter((session) => session.mode === 'pomodoro' && isFocusSession(session)).length}</strong></div></div><div className="history-table"><div className="history-head"><span>任务</span><span>项目</span><span>开始时间</span><span>模式</span><span>有效时长</span></div>{rows.length ? rows.map((session) => { const task = tasks.find((item) => item.id === session.taskId); const project = projects.find((item) => item.id === session.projectId); return <div className="history-row" key={session.id}><strong><i className="project-dot" style={{ background: project?.color }} />{task?.title ?? '已删除任务'}</strong><span>{project?.name ?? '未分类'}</span><span>{formatDate(new Date(session.startedAt))} {formatTime(new Date(session.startedAt))}</span><span>{session.mode === 'pomodoro' ? '番茄钟' : '正计时'}</span><strong>{formatDuration(session.accumulatedMs, false)}</strong></div> }) : <EmptyState icon={History} title="还没有专注记录" description="完成一段计时后，真实记录会显示在这里。" action="去开始计时" onAction={() => undefined} />}</div></div> }
function StatsView({ sessions, tasks, projects, dailyGoalMs }: { sessions: FocusSession[]; tasks: Task[]; projects: Project[]; dailyGoalMs: number }) { const completed = sessions.filter((session) => session.status === 'completed' && isFocusSession(session) && isRecordableSession(session, Date.now())); const total = completed.reduce((sum, session) => sum + session.accumulatedMs, 0); const days = Array.from({ length: 7 }, (_, index) => { const date = new Date(); date.setHours(0, 0, 0, 0); date.setDate(date.getDate() - 6 + index); const value = completed.filter((session) => new Date(session.startedAt).toDateString() === date.toDateString()).reduce((sum, session) => sum + session.accumulatedMs, 0); return { date, value } }); const max = Math.max(1, ...days.map((day) => day.value)); return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 分析</span><h1>数据统计</h1><p>用真实记录看见你的时间投入。</p></div><span className="data-note">只统计已完成的真实会话</span></div><div className="stats-grid"><StatCard label="总专注时长" value={formatDuration(total, false)} hint="所有已完成会话" /><StatCard label="平均每日" value={formatDuration(total / 7, false)} hint="最近 7 天" /><StatCard label="完成任务" value={String(tasks.filter((task) => task.status === 'done').length)} hint="当前任务列表" /><StatCard label="目标完成度" value={`${Math.min(100, Math.round(total / dailyGoalMs * 100))}%`} hint="按每日目标计算" /></div><div className="analytics-grid"><section className="chart-panel"><div className="section-heading"><div><h2>最近 7 天</h2><span>每日有效专注时长</span></div></div><div className="bar-chart">{days.map((day) => <div className="bar-column" key={day.date.toISOString()}><span>{day.value ? (day.value / 3600000).toFixed(1) : '0'}</span><div className="bar-track"><i style={{ height: `${day.value / max * 100}%` }} /></div><small>{day.date.toLocaleDateString('zh-CN', { weekday: 'short' })}</small></div>)}</div></section><section className="chart-panel"><div className="section-heading"><div><h2>项目分布</h2><span>累计有效专注时间</span></div></div>{projects.length ? projects.map((project) => { const totalProject = completed.filter((session) => session.projectId === project.id).reduce((sum, session) => sum + session.accumulatedMs, 0); return <div className="distribution-row" key={project.id}><span><i className="project-dot" style={{ background: project.color }} />{project.name}</span><strong>{formatDuration(totalProject, false)}</strong></div> }) : <div className="chart-empty">完成会话后这里会生成项目分布。</div>}</section></div></div> }
function SettingsView({ settings, onChange, onExport }: { settings: ChronoState['settings']; onChange: (settings: ChronoState['settings']) => void; onExport: () => void }) {
  const [section, setSection] = useState<SettingsSection>('preferences')
  const themes: Array<{ value: ChronoState['settings']['theme']; label: string; icon: typeof Sun }> = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Monitor },
  ]
  return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">ChronoDesk / 偏好</span><h1>设置</h1><p>让计时方式适应你的工作节奏。</p></div></div><div className="settings-layout"><nav className="settings-menu"><button className={section === 'preferences' ? 'active' : ''} onClick={() => setSection('preferences')}><Settings size={15} />计时与偏好</button><button className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}><Sun size={15} />外观</button><button className={section === 'data' ? 'active' : ''} onClick={() => setSection('data')}><Download size={15} />数据管理</button></nav><section className={`settings-content settings-content-${section}`}><SettingSection section="appearance" title="外观" description="选择适合当前环境的显示方式"><SettingRow label="主题" description="跟随系统时会响应 Windows 的主题变化"><div className="segmented theme-segmented">{themes.map(({ value, label, icon: Icon }) => <button className={settings.theme === value ? 'active' : ''} key={value} onClick={() => onChange({ ...settings, theme: value })}><Icon size={14} />{label}</button>)}</div></SettingRow></SettingSection><div className="settings-section settings-section-preferences"><SettingSection title="计时设置" description="番茄钟会在专注阶段结束时自动保存会话"><SettingRow label="默认计时模式" description="新任务开始时使用的模式"><div className="segmented">{(['stopwatch', 'pomodoro'] as TimerMode[]).map((item) => <button className={settings.defaultMode === item ? 'active' : ''} key={item} onClick={() => onChange({ ...settings, defaultMode: item })}>{item === 'stopwatch' ? '正计时' : '番茄钟'}</button>)}</div></SettingRow><SettingRow label="专注时长" description="番茄钟的单个专注阶段"><NumberField value={settings.focusMinutes} suffix="分钟" onChange={(value) => onChange({ ...settings, focusMinutes: value })} /></SettingRow><SettingRow label="休息时长" description="短休息和长休息"><div className="inline-fields"><NumberField value={settings.shortBreakMinutes} suffix="短休息" onChange={(value) => onChange({ ...settings, shortBreakMinutes: value })} /><NumberField value={settings.longBreakMinutes} suffix="长休息" onChange={(value) => onChange({ ...settings, longBreakMinutes: value })} /></div></SettingRow><SettingRow label="自动开始休息" description="专注阶段结束后立即进入休息"><button className={`toggle ${settings.autoStartBreak ? 'on' : ''}`} onClick={() => onChange({ ...settings, autoStartBreak: !settings.autoStartBreak })}><span /></button></SettingRow></SettingSection><SettingSection title="每日目标" description="用于今日进度和目标完成度"><SettingRow label="每日专注目标" description="根据你的实际工作时间设定"><NumberField value={Math.round(settings.dailyGoalMs / 3600000)} suffix="小时" onChange={(value) => onChange({ ...settings, dailyGoalMs: value * 3600000 })} /></SettingRow></SettingSection></div><div className="settings-section settings-section-data"><SettingSection title="数据管理" description="数据保存在本机，可随时导出"><SettingRow label="导出本地数据" description="包含任务、项目、会话和设置"><button className="secondary-button" onClick={onExport}><Download size={14} />导出 JSON</button></SettingRow></SettingSection></div></section></div></div>
}
function SettingSection({ section, title, description, children }: { section?: SettingsSection; title: string; description: string; children: React.ReactNode }) { return <section className={`setting-section ${section ? `setting-section-${section}` : ''}`}><div className="setting-heading"><h2>{title}</h2><span>{description}</span></div>{children}</section> }
function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong><span>{description}</span></div>{children}</div> }
function NumberField({ value, suffix, onChange }: { value: number; suffix: string; onChange: (value: number) => void }) { return <label className="number-field"><input type="number" min="1" max="240" value={value} onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))} /><span>{suffix}</span></label> }
function Metric({ icon: Icon, label, value, hint }: { icon: typeof Target; label: string; value: string; hint: string }) { return <div className="metric"><div className="metric-icon"><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div> }
function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) { return <div className="stat-card"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div> }
function EmptyState({ icon: Icon, title, description, action, onAction }: { icon: typeof Check; title: string; description: string; action: string; onAction: () => void }) { return <div className="empty-state"><div><Icon size={21} /></div><strong>{title}</strong><span>{description}</span><button className="secondary-button" onClick={onAction}>{action}</button></div> }
function TaskModal({ projects, onClose, onCreate }: { projects: Project[]; onClose: () => void; onCreate: (draft: TaskDraft) => void }) { const [title, setTitle] = useState(''); const [projectId, setProjectId] = useState(projects[0]?.id ?? ''); const [priority, setPriority] = useState<Priority>('medium'); const [minutes, setMinutes] = useState(30); const [recurrence, setRecurrence] = useState<TaskRecurrence>('none'); return <Modal title="新建任务" eyebrow="任务" onClose={onClose}><label className="form-label">任务名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成项目首页" /></label><label className="form-label">项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">未分类</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><div className="form-label">优先级<div className="choice-row">{(['low', 'medium', 'high'] as Priority[]).map((item) => <button type="button" className={priority === item ? 'active' : ''} key={item} onClick={() => setPriority(item)}>{priorityNames[item]}优先级</button>)}</div></div><label className="form-label">预计时长（分钟）<input type="number" min="1" value={minutes} onChange={(event) => setMinutes(Number(event.target.value) || 1)} /></label><label className="recurrence-toggle form-recurring"><input type="checkbox" checked={recurrence === 'daily'} onChange={(event) => setRecurrence(event.target.checked ? 'daily' : 'none')} />长期任务（每天完成后次日继续）</label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} onClick={() => onCreate({ title: title.trim(), projectId, priority, plannedMinutes: minutes, recurrence })}><Plus size={14} />创建任务</button></div></Modal> }
function DuplicateTaskModal({ candidate, onMakeRecurring, onCreateAnyway, onClose }: { candidate: DuplicateCandidate; onMakeRecurring: () => void; onCreateAnyway: () => void; onClose: () => void }) { return <Modal title={candidate.recurringExists ? '长期任务已存在' : '发现同名任务'} eyebrow="任务提醒" onClose={onClose}><div className="duplicate-task-message"><strong>{candidate.recurringExists ? `“${candidate.existing.title}”已经是长期任务` : `“${candidate.existing.title}”已经存在`}</strong><span>{candidate.recurringExists ? '同一项目下的长期任务无需重复创建。' : '同一项目下已有同名的一次性任务。可以将它设为长期任务，或忽略提醒并创建一次性任务。'}</span></div>{!candidate.recurringExists && <div className="duplicate-actions"><button className="primary-button" onClick={onMakeRecurring}>将已有任务设为长期任务</button><button className="text-button" onClick={onCreateAnyway}>忽略并创建一次性任务</button></div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>关闭</button></div></Modal> }
function ProjectModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, color: string) => void }) { const [name, setName] = useState(''); const [color, setColor] = useState(colors[0]); return <Modal title="新建项目" eyebrow="项目" onClose={onClose}><label className="form-label">项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：科研与论文" /></label><div className="form-label">项目颜色<div className="color-picker">{colors.map((item) => <button type="button" key={item} style={{ background: item }} className={color === item ? 'selected' : ''} aria-label={`选择项目颜色 ${item}`} onClick={() => setColor(item)}>{color === item && <span className="color-check" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="m3.25 8.25 3.1 3.1 6.4-6.7" /></svg></span>}</button>)}</div></div><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim()} onClick={() => onCreate(name.trim(), color)}><Plus size={14} />创建项目</button></div></Modal> }
function Modal({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}><div className="modal"><div className="modal-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div>{children}</div></div> }
function phaseDuration(phase: PomodoroPhase, settings: ChronoState['settings']) { return (phase === 'focus' ? settings.focusMinutes : phase === 'short_break' ? settings.shortBreakMinutes : settings.longBreakMinutes) * 60000 }
function closeRunning(session: FocusSession, now: number, behavior: ChronoState['settings']['switchBehavior']): FocusSession { return { ...session, accumulatedMs: sessionElapsed(session, now), status: behavior === 'complete' ? 'completed' : 'paused', pausedAt: new Date(now).toISOString(), ...(behavior === 'complete' ? { endedAt: new Date(now).toISOString() } : {}) } }
function formatDate(date: Date) { return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }
function formatTime(date: Date) { return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
