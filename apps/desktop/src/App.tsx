import { useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Clock3, Download, FileUp, FolderKanban, History, LayoutDashboard, Monitor, Moon, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Settings, Sun, Target, Trash2, Trophy, X } from 'lucide-react'
import { getVersion } from '@tauri-apps/api/app'
import { emit, emitTo, listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { LogicalPosition, LogicalSize } from '@tauri-apps/api/dpi'
import { currentMonitor, getCurrentWindow } from '@tauri-apps/api/window'
import { relaunch } from '@tauri-apps/plugin-process'
import { check, type Update } from '@tauri-apps/plugin-updater'
import desktopPackage from '../package.json'
import { addTaskToToday, createId, defaultSettings, defaultState, formatDuration, isFocusSession, isRecordableSession, isTaskVisibleToday, loadState, normalizeTaskKey, removeTaskCompletion, rolloverRecurringTasks, saveState, sessionElapsed, setTaskCompletion, taskCompletionForDay, todayKey, tomorrowKey, transitionActiveSession, type ChronoState, type FocusSession, type PomodoroPhase, type Priority, type Project, type Task, type TaskRecurrence, type TimerMode } from './types'

type View = 'today' | 'tasks' | 'projects' | 'history' | 'stats' | 'settings'
type SettingsSection = 'preferences' | 'appearance' | 'data'
type UpdateCheckStatus = 'idle' | 'checking' | 'latest' | 'error'
const colors = ['#334155', '#52677f', '#71869b', '#7c849e', '#668b8b']
const priorityNames: Record<Priority, string> = { high: '高', medium: '中', low: '低' }
type TimerWidgetSession = { timerId: string; taskId: string; taskTitle: string; elapsedMs: number; status: 'running' | 'paused'; phase: PomodoroPhase }
type TimerWidgetPayload = { sessions: TimerWidgetSession[]; theme: 'light' | 'dark' }
type TimerWidgetAction = { action: 'pause' | 'resume' | 'finish'; timerId: string }
type TaskDraft = { title: string; projectId: string; priority: Priority; plannedMinutes: number; recurrence: TaskRecurrence }
type ProjectDraft = { id?: string; name: string; color: string }
type DuplicateCandidate = { draft: TaskDraft; existing: Task; recurringExists: boolean }
const isTauriRuntime = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

type FilePickerFileHandle = { getFile: () => Promise<File> }
type FilePickerSaveHandle = { createWritable: () => Promise<{ write: (value: string) => Promise<void>; close: () => Promise<void> }> }
type FilePickerWindow = Window & {
  showOpenFilePicker?: (options: { multiple?: boolean; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FilePickerFileHandle[]>
  showSaveFilePicker?: (options: { suggestedName: string; types?: Array<{ description: string; accept: Record<string, string[]> }> }) => Promise<FilePickerSaveHandle>
}

function parseImportedState(value: unknown): ChronoState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const parsed = value as Partial<ChronoState>
  if (!Array.isArray(parsed.projects) || !Array.isArray(parsed.tasks) || !Array.isArray(parsed.sessions) || !parsed.settings || typeof parsed.settings !== 'object') return undefined
  return {
    projects: parsed.projects as Project[],
    tasks: parsed.tasks as Task[],
    sessions: parsed.sessions as FocusSession[],
    taskCompletions: Array.isArray(parsed.taskCompletions) ? parsed.taskCompletions : [],
    settings: { ...defaultSettings, ...parsed.settings },
  }
}

export default function App() {
  const isTimerWidget = new URLSearchParams(window.location.search).get('widget') === 'timer'
  return isTimerWidget ? <TimerWidget /> : <MainApp />
}

function MainApp() {
  const [state, setState] = useState<ChronoState>(defaultState)
  const [storageReady, setStorageReady] = useState(false)
  const [storageError, setStorageError] = useState<string>()
  const [appVersion, setAppVersion] = useState(desktopPackage.version)
  const [view, setView] = useState<View>('today')
  const [selectedTaskId, setSelectedTaskId] = useState<string>()
  const [todaySelectedTaskId, setTodaySelectedTaskId] = useState<string>()
  const [activeTimerId, setActiveTimerId] = useState<string>()
  const [expandedProjectId, setExpandedProjectId] = useState<string>()
  const [mode, setMode] = useState<TimerMode>(state.settings.defaultMode)
  const [now, setNow] = useState(Date.now())
  const [modal, setModal] = useState<'task' | 'project' | null>(null)
  const [projectToEdit, setProjectToEdit] = useState<Project>()
  const [duplicateCandidate, setDuplicateCandidate] = useState<DuplicateCandidate>()
  const [todayTaskAction, setTodayTaskAction] = useState<Task>()
  const [helpOpen, setHelpOpen] = useState(false)
  const [toast, setToast] = useState('')
  const [availableUpdate, setAvailableUpdate] = useState<Update>()
  const [updateInstalling, setUpdateInstalling] = useState(false)
  const updateCheckStarted = useRef(false)
  const [phasePrompt, setPhasePrompt] = useState<'break' | 'focus' | 'stopwatch-goal'>()
  const stopwatchReminderShown = useRef(new Set<string>())
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; confirmLabel?: string; cancelLabel?: string; onConfirm: () => void }>()
  const [widgetReady, setWidgetReady] = useState(0)
  const widgetCreationPending = useRef(false)
  useEffect(() => {
    let cancelled = false
    void loadState().then((loaded) => {
      if (cancelled) return
      setState(loaded)
      setMode(loaded.settings.defaultMode)
      setStorageReady(true)
    }).catch((error) => {
      if (cancelled) return
      setStorageError(error instanceof Error ? error.message : '无法读取本地数据')
    })
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!storageReady || storageError) return
    void saveState(state).catch((error) => setStorageError(error instanceof Error ? error.message : '无法保存本地数据'))
  }, [state, storageReady, storageError])
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
    if (!isTauriRuntime()) return
    void getVersion().then(setAppVersion).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!isTauriRuntime() || updateCheckStarted.current) return
    updateCheckStarted.current = true
    void check({ timeout: 10000 }).then((update) => {
      if (update) setAvailableUpdate(update)
    }).catch(() => undefined)
  }, [])
  useEffect(() => {
    if (!helpOpen) return
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setHelpOpen(false) }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [helpOpen])
  const activeSessions = state.sessions.filter((session) => session.status === 'running' || session.status === 'paused')
  const preferredActiveTaskId = view === 'today' ? todaySelectedTaskId : selectedTaskId
  const selectedSession = preferredActiveTaskId ? activeSessions.find((session) => session.taskId === preferredActiveTaskId) : undefined
  const active = selectedSession ?? (!preferredActiveTaskId ? activeSessions.find((session) => session.id === activeTimerId) ?? activeSessions[0] : undefined)
  const backgroundActive = activeSessions.find((session) => session.id === activeTimerId) ?? activeSessions[0]
  const activeTask = state.tasks.find((task) => task.id === active?.taskId) ?? state.tasks.find((task) => task.id === preferredActiveTaskId)
  const todayStart = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }, [now])
  const dayKey = todayKey(now)
  const todaySessions = state.sessions.filter((session) => new Date(session.startedAt).getTime() >= todayStart)
  const todayFocus = todaySessions.filter((session) => isFocusSession(session) && isRecordableSession(session, now)).reduce((sum, session) => sum + sessionElapsed(session, now), 0)
  const todayTasks = state.tasks.filter((task) => isTaskVisibleToday(task, dayKey) || taskCompletionForDay(task.id, state.taskCompletions, dayKey))
  const completedToday = new Set(todayTasks.filter((task) => {
    const record = taskCompletionForDay(task.id, state.taskCompletions, dayKey)
    return record?.status === 'completed' || (task.recurrence === 'none' && task.status === 'done' && task.completedAt && todayKey(new Date(task.completedAt).getTime()) === dayKey)
  }).map((task) => task.id)).size
  const update = (fn: (value: ChronoState) => ChronoState) => setState((value) => fn(value))
  const notify = (message: string) => setToast(message)
  const installAvailableUpdate = async () => {
    if (!availableUpdate || updateInstalling) return
    setUpdateInstalling(true)
    try {
      await availableUpdate.downloadAndInstall()
      await relaunch()
    } catch {
      setUpdateInstalling(false)
      notify('更新安装失败，请稍后重试')
    }
  }

  function startTimer(taskId: string, requestedMode = mode) {
    const task = state.tasks.find((item) => item.id === taskId); if (!task) return
    if (activeSessions.some((session) => session.taskId === taskId)) return notify('当前任务已经在计时')
    const iso = new Date().toISOString()
    const session: FocusSession = { id: createId('session'), taskId, projectId: task.projectId, mode: requestedMode, phase: 'focus', pomodoroIndex: 1, startedAt: iso, accumulatedMs: 0, status: 'running' }
    update((current) => ({ ...current, sessions: [...current.sessions, session], tasks: current.tasks.map((item) => item.id === taskId ? { ...item, status: 'running', updatedAt: iso } : item) }))
    setActiveTimerId(session.id)
    setSelectedTaskId(taskId); setTodaySelectedTaskId(taskId); notify(requestedMode === 'pomodoro' ? '番茄钟已开始' : '计时已开始')
  }
  function pauseTimer(timerId = active?.id ?? activeTimerId ?? activeSessions[0]?.id) {
    const target = activeSessions.find((session) => session.id === timerId)
    if (!target || target.status !== 'running') return
    const timestamp = Date.now()
    update((current) => transitionActiveSession(current, target, [{ ...target, accumulatedMs: sessionElapsed(target, timestamp), pausedAt: new Date(timestamp).toISOString(), status: 'paused' }]))
    setActiveTimerId(target.id); notify('计时已暂停')
  }
  function resumeTimer(timerId = active?.id ?? activeTimerId ?? activeSessions[0]?.id) {
    const target = activeSessions.find((session) => session.id === timerId)
    if (!target || target.status !== 'paused') return
    const iso = new Date().toISOString()
    update((current) => transitionActiveSession(current, target, [{ ...target, startedAt: iso, pausedAt: undefined, status: 'running' }]))
    setActiveTimerId(target.id); notify('计时已继续')
  }
  function finishTimer(cancelled = false, timerId = active?.id ?? activeTimerId ?? activeSessions[0]?.id) {
    const target = activeSessions.find((session) => session.id === timerId)
    if (!target) return
    const active = target
    const timestamp = Date.now()
    const elapsed = sessionElapsed(active, timestamp)
    const iso = new Date(timestamp).toISOString()
    const ended = { ...active, accumulatedMs: elapsed, endedAt: iso, status: cancelled ? 'cancelled' as const : 'completed' as const }
    const recordable = isRecordableSession(active, timestamp)
    const enterStopwatchBreak = !cancelled && active.mode === 'stopwatch' && active.phase === 'focus' && elapsed >= state.settings.stopwatchFocusMinutes * 60000
    const breakSession: FocusSession | undefined = enterStopwatchBreak ? { id: createId('session'), taskId: active.taskId, projectId: active.projectId, mode: 'stopwatch', phase: 'short_break', pomodoroIndex: active.pomodoroIndex, startedAt: iso, accumulatedMs: 0, status: state.settings.phaseEndReminderEnabled ? 'paused' : 'running' } : undefined
    update((current) => {
      const next = transitionActiveSession(current, active, [...(recordable ? [ended] : []), ...(breakSession ? [breakSession] : [])])
      return next === current ? current : { ...next, tasks: current.tasks.map((task) => task.id === active.taskId ? { ...task, status: 'todo' as const, updatedAt: iso } : task) }
    })
    setActiveTimerId(breakSession?.id)
    if (breakSession && state.settings.phaseEndReminderEnabled) setPhasePrompt('break')
    else if (breakSession) setPhasePrompt(undefined)
    notify(enterStopwatchBreak ? '专注已保存，开始 10 分钟休息' : recordable ? (cancelled ? '会话已取消，实际时长已保留' : '会话已保存') : '未满 1 分钟，本次会话未记录')
  }
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen('timer-widget-ready', () => setWidgetReady((value) => value + 1)).then((stop) => { unlisten = stop })
    return () => unlisten?.()
  }, [])
  const widgetActions = useRef({ pauseTimer, resumeTimer, finishTimer })
  widgetActions.current = { pauseTimer, resumeTimer, finishTimer }
  useEffect(() => {
    if (!isTauriRuntime()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void listen<TimerWidgetAction>('timer-widget-action', ({ payload }) => {
      if (disposed) return
      const actions = widgetActions.current
      if (payload.action === 'pause') actions.pauseTimer(payload.timerId)
      if (payload.action === 'resume') actions.resumeTimer(payload.timerId)
      if (payload.action === 'finish') actions.finishTimer(false, payload.timerId)
    }).then((stop) => { if (disposed) stop(); else unlisten = stop })
    return () => { disposed = true; unlisten?.() }
  }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let unlisten: (() => void) | undefined
    void listen<{ taskId: string }>('timer-widget-select', ({ payload }) => {
      if (!payload?.taskId) return
      setSelectedTaskId(payload.taskId)
      setTodaySelectedTaskId(payload.taskId)
      setView('today')
    }).then((stop) => { unlisten = stop })
    return () => unlisten?.()
  }, [])
  useEffect(() => {
    if (!isTauriRuntime()) return
    let cancelled = false
    const syncWidget = async () => {
      const widget = await WebviewWindow.getByLabel('timer-widget')
      if (!activeSessions.length) {
        await widget?.close().catch(() => undefined)
        return
      }
      const payload: TimerWidgetPayload = {
        sessions: activeSessions.map((session) => ({
          timerId: session.id,
          taskId: session.taskId,
          taskTitle: state.tasks.find((task) => task.id === session.taskId)?.title ?? '任务已删除',
          elapsedMs: sessionElapsed(session, now),
          status: session.status as 'running' | 'paused',
          phase: session.phase,
        })),
        theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      }
      const width = activeSessions.length === 1 ? 220 : 240
      const height = activeSessions.length === 1 ? 80 : Math.min(180, 38 + Math.min(activeSessions.length, 3) * 42)
      if (widget) {
        await widget.setSize(new LogicalSize(width, height)).catch(() => undefined)
        const monitor = await currentMonitor()
        const workPosition = monitor?.workArea.position.toLogical(monitor.scaleFactor)
        const workSize = monitor?.workArea.size.toLogical(monitor.scaleFactor)
        if (workPosition && workSize) await widget.setPosition(new LogicalPosition(workPosition.x + workSize.width - width - 16, workPosition.y + workSize.height - height - 16)).catch(() => undefined)
        await emitTo('timer-widget', 'timer-widget-state', payload).catch(() => undefined)
        return
      }
      if (widgetCreationPending.current) return
      widgetCreationPending.current = true
      const monitor = await currentMonitor()
      if (cancelled) { widgetCreationPending.current = false; return }
      const margin = 16
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
  }, [activeSessions, now, state.tasks, state.settings.theme, widgetReady])
  useEffect(() => {
    if (!backgroundActive || backgroundActive.status !== 'running') return
    const elapsed = sessionElapsed(backgroundActive, now)
    if (backgroundActive.mode === 'stopwatch' && backgroundActive.phase === 'focus') {
      if (elapsed >= state.settings.stopwatchFocusMinutes * 60000 && !stopwatchReminderShown.current.has(backgroundActive.id)) {
        stopwatchReminderShown.current.add(backgroundActive.id)
        if (state.settings.phaseEndReminderEnabled) setPhasePrompt('stopwatch-goal')
      }
      return
    }
    if (backgroundActive.mode === 'pomodoro' && backgroundActive.phase === 'focus' && elapsed < phaseDuration('focus', state.settings)) return
    if (backgroundActive.mode === 'stopwatch' && backgroundActive.phase === 'short_break' && elapsed < state.settings.stopwatchBreakMinutes * 60000) return
    if (backgroundActive.mode === 'pomodoro' && backgroundActive.phase !== 'focus' && elapsed < phaseDuration(backgroundActive.phase, state.settings)) return
    const limit = backgroundActive.mode === 'stopwatch' ? state.settings.stopwatchBreakMinutes * 60000 : phaseDuration(backgroundActive.phase, state.settings)
    const finished = { ...backgroundActive, accumulatedMs: limit, endedAt: new Date().toISOString(), status: 'completed' as const }
    const nextPhase: PomodoroPhase = backgroundActive.phase === 'focus'
      ? (backgroundActive.mode === 'pomodoro' && backgroundActive.pomodoroIndex % Math.max(1, state.settings.longBreakEvery) === 0 ? 'long_break' : 'short_break')
      : 'focus'
    const shouldPrompt = state.settings.phaseEndReminderEnabled
    const next: FocusSession = { id: createId('session'), taskId: backgroundActive.taskId, projectId: backgroundActive.projectId, mode: backgroundActive.mode, phase: nextPhase, pomodoroIndex: nextPhase === 'focus' ? backgroundActive.pomodoroIndex + 1 : backgroundActive.pomodoroIndex, startedAt: new Date().toISOString(), accumulatedMs: 0, status: shouldPrompt ? 'paused' : 'running' }
    update((current) => transitionActiveSession(current, backgroundActive, [...(isRecordableSession(backgroundActive, now) ? [finished] : []), next]))
    if (shouldPrompt) setPhasePrompt(nextPhase === 'focus' ? 'focus' : 'break')
  }, [now])
  function createTask(draft: TaskDraft, force = false) {
    const matches = state.tasks.filter((task) => normalizeTaskKey(task) === normalizeTaskKey(draft))
    const recurringTask = matches.find((task) => task.recurrence === 'daily')
    const existing = recurringTask ?? matches[0]
    if (existing && !force) { setDuplicateCandidate({ draft, existing, recurringExists: Boolean(recurringTask) }); setModal(null); return }
    const iso = new Date().toISOString()
    const addedToToday = view === 'today'
    const task: Task = { id: createId('task'), title: draft.title, description: '', projectId: draft.projectId, priority: draft.priority, recurrence: draft.recurrence, status: 'todo', plannedMs: draft.plannedMinutes * 60000, sortOrder: state.tasks.length, createdAt: iso, updatedAt: iso, todayAddedOn: addedToToday ? dayKey : undefined, todayDismissedOn: addedToToday ? undefined : dayKey }
    update((current) => ({ ...current, tasks: [...current.tasks, task] }))
    setSelectedTaskId(task.id); setModal(null); setDuplicateCandidate(undefined); notify('任务已创建')
    if (view === 'tasks' && draft.recurrence === 'none') setConfirmDialog({ title: '加入今天的任务？', message: '这个普通任务已创建。是否将它加入今天的任务列表？', cancelLabel: '否', confirmLabel: '是', onConfirm: () => { addToToday(task.id); notify('任务已加入今天') } })
  }
  function reuseDuplicate(asRecurring: boolean) {
    if (!duplicateCandidate) return
    const { existing } = duplicateCandidate
    const iso = new Date().toISOString()
    update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === existing.id ? { ...task, ...(asRecurring ? { recurrence: 'daily' as const, status: 'todo' as const, completedAt: undefined, todayAddedOn: view === 'today' ? dayKey : undefined, todayDismissedOn: view === 'today' ? undefined : dayKey } : {}), updatedAt: iso } : task) }))
    setSelectedTaskId(existing.id); setDuplicateCandidate(undefined); notify(asRecurring ? '已将任务设为长期任务，已加入今日任务' : '已复用已有任务')
  }
  function saveProject(draft: ProjectDraft) {
    if (draft.id) {
      update((current) => ({ ...current, projects: current.projects.map((project) => project.id === draft.id ? { ...project, name: draft.name, color: draft.color } : project) }))
      setProjectToEdit(undefined); notify('项目已更新'); return
    }
    const project: Project = { id: createId('project'), name: draft.name, color: draft.color, archived: false, createdAt: new Date().toISOString() }
    update((current) => ({ ...current, projects: [...current.projects, project] })); setModal(null); notify('项目已创建')
  }
  function deleteProject(projectId: string) { const project = state.projects.find((item) => item.id === projectId); if (!project) return; setConfirmDialog({ title: '删除项目', message: `删除项目“${project.name}”后，关联任务会保留为未分类。确定继续吗？`, confirmLabel: '删除项目', onConfirm: () => { const iso = new Date().toISOString(); update((current) => ({ ...current, projects: current.projects.filter((item) => item.id !== projectId), tasks: current.tasks.map((task) => task.projectId === projectId ? { ...task, projectId: '', updatedAt: iso } : task), sessions: current.sessions.map((session) => session.projectId === projectId ? { ...session, projectId: '' } : session) })); notify('项目已删除') } }) }
  function reorderProjects(sourceId: string, targetId: string) { if (sourceId === targetId) return; update((current) => { const projects = [...current.projects]; const sourceIndex = projects.findIndex((project) => project.id === sourceId); const targetIndex = projects.findIndex((project) => project.id === targetId); if (sourceIndex < 0 || targetIndex < 0) return current; const [moved] = projects.splice(sourceIndex, 1); projects.splice(targetIndex, 0, moved); return { ...current, projects } }) }
  function toggleTask(taskId: string) {
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return
    const iso = new Date().toISOString()
    const completing = task.status !== 'done'
    update((current) => ({
      ...current,
      tasks: current.tasks.map((item) => item.id === taskId ? { ...item, status: completing ? 'done' as const : 'todo' as const, completedAt: completing ? iso : undefined, updatedAt: iso } : item),
      taskCompletions: task.recurrence === 'none'
        ? (completing ? setTaskCompletion(current.taskCompletions, taskId, 'completed', dayKey, iso) : removeTaskCompletion(current.taskCompletions, taskId, dayKey))
        : current.taskCompletions,
    }))
  }
  function toggleTodayTask(taskId: string) {
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return
    const record = taskCompletionForDay(taskId, state.taskCompletions, dayKey)
    const completing = record?.status !== 'completed'
    const iso = new Date().toISOString()
    update((current) => ({
      ...current,
      tasks: current.tasks.map((item) => item.id === taskId ? { ...item, ...(task.recurrence === 'none' ? { status: completing ? 'done' as const : 'todo' as const, completedAt: completing ? iso : undefined } : {}), ...(!completing ? { todayAddedOn: dayKey, todayDismissedOn: undefined } : {}), updatedAt: iso } : item),
      taskCompletions: completing ? setTaskCompletion(current.taskCompletions, taskId, 'completed', dayKey, iso) : removeTaskCompletion(current.taskCompletions, taskId, dayKey),
    }))
    notify(completing ? (task.recurrence === 'daily' ? '长期任务已记录今日完成' : '任务已完成') : '已取消今日完成')
  }
  function addToToday(taskId: string) { update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? addTaskToToday(task, dayKey) : task) })); notify('任务已加入今日待办') }
  function openTodayTaskAction(taskId: string) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; if (activeSessions.some((session) => session.taskId === taskId)) return notify('当前任务正在计时，请先结束计时'); setTodayTaskAction(task) }
  function cancelTodayTask(taskId: string) {
    if (activeSessions.some((session) => session.taskId === taskId)) return notify('请先结束计时，再取消今天的安排')
    const task = state.tasks.find((item) => item.id === taskId)
    if (!task) return
    const iso = new Date().toISOString()
    update((current) => ({
      ...current,
      tasks: task.recurrence === 'none'
        ? current.tasks.filter((item) => item.id !== taskId)
        : current.tasks.map((item) => item.id === taskId ? { ...item, todayDismissedOn: dayKey, updatedAt: iso } : item),
      taskCompletions: removeTaskCompletion(current.taskCompletions, taskId, dayKey),
    }))
    notify(task.recurrence === 'none' ? '已取消创建任务' : '已取消今天的任务安排，长期任务仍保留在所有任务中')
  }
  function setTodayTaskStatus(taskId: string, status: 'incomplete' | 'deferred') {
    if (activeSessions.some((session) => session.taskId === taskId)) return notify('当前任务正在计时，请先结束计时')
    const nextDay = tomorrowKey(now)
    update((current) => ({
      ...current,
      tasks: current.tasks.map((task) => task.id === taskId ? { ...task, todayAddedOn: nextDay, todayDismissedOn: undefined, status: 'todo' as const, completedAt: undefined, updatedAt: new Date().toISOString() } : task),
      taskCompletions: setTaskCompletion(current.taskCompletions, taskId, status, dayKey),
    }))
    notify(status === 'deferred' ? '任务已顺延到明天' : '任务已标记为未完成')
  }
  function updateTask(taskId: string, changes: Partial<Pick<Task, 'title' | 'projectId' | 'plannedMs' | 'priority' | 'recurrence' | 'description'>>) { const iso = new Date().toISOString(); update((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === taskId ? { ...task, ...changes, updatedAt: iso } : task) })) }
  function deleteTask(taskId: string) { const task = state.tasks.find((item) => item.id === taskId); if (!task) return; if (activeSessions.some((session) => session.taskId === taskId)) return notify('请先结束该任务的计时，再删除任务'); const message = task.recurrence === 'daily' ? '这是长期任务。删除后任务实体会移除，但历史专注会话仍会保留。确定继续吗？' : '删除任务不会删除历史计时记录，确定继续吗？'; setConfirmDialog({ title: '删除任务', message, confirmLabel: '删除任务', onConfirm: () => { update((current) => ({ ...current, tasks: current.tasks.filter((item) => item.id !== taskId) })); notify('任务已删除') } }) }
  useEffect(() => {
    const handleTodayDelete = (event: Event) => {
      const payload = (event as CustomEvent<{ taskId: string; actionLabel?: string }>).detail
      if (payload?.taskId) cancelTodayTask(payload.taskId)
    }
    window.addEventListener('chronodesk-delete-today-task', handleTodayDelete)
    return () => window.removeEventListener('chronodesk-delete-today-task', handleTodayDelete)
  }, [state.tasks, state.sessions])
  function deleteTasks(taskIds: string[], onComplete: () => void) { const ids = new Set(taskIds); if (state.sessions.some((session) => ids.has(session.taskId) && (session.status === 'running' || session.status === 'paused'))) { notify('选中的任务中有正在计时或已暂停的任务，请先结束计时'); return } const includesRecurring = state.tasks.some((task) => ids.has(task.id) && task.recurrence === 'daily'); const message = includesRecurring ? `选中任务中包含长期任务。删除后任务实体会移除，但历史专注会话仍会保留。确定删除 ${ids.size} 个任务吗？` : `确定删除选中的 ${ids.size} 个任务吗？历史计时记录会保留。`; setConfirmDialog({ title: '批量删除任务', message, confirmLabel: '删除所选', onConfirm: () => { update((current) => ({ ...current, tasks: current.tasks.filter((task) => !ids.has(task.id)) })); if (selectedTaskId && ids.has(selectedTaskId)) setSelectedTaskId(undefined); onComplete(); notify(`已删除 ${ids.size} 个任务`) } }) }
  async function exportData() {
    const exportPayload = { ...state, appVersion, exportedAt: new Date().toISOString() }
    const json = JSON.stringify(exportPayload, null, 2)
    const suggestedName = `chronodesk-${new Date().toISOString().slice(0, 10)}.json`
    const pickerWindow = window as FilePickerWindow
    try {
      if (pickerWindow.showSaveFilePicker) {
        const handle = await pickerWindow.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'ChronoDesk JSON 数据', accept: { 'application/json': ['.json'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(json)
        await writable.close()
      } else {
        const link = document.createElement('a')
        link.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        link.download = suggestedName
        link.click()
        URL.revokeObjectURL(link.href)
      }
      notify('数据已导出')
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      notify('导出失败，请重试')
    }
  }
  async function importData() {
    const pickerWindow = window as FilePickerWindow
    try {
      let file: File | undefined
      if (pickerWindow.showOpenFilePicker) {
        const handles = await pickerWindow.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'ChronoDesk JSON 数据', accept: { 'application/json': ['.json'] } }],
        })
        file = await handles[0]?.getFile()
      } else {
        file = await new Promise<File | undefined>((resolve) => {
          const input = document.createElement('input')
          input.type = 'file'
          input.accept = '.json,application/json'
          input.onchange = () => resolve(input.files?.[0])
          input.click()
        })
      }
      if (!file) return
      const imported = parseImportedState(JSON.parse(await file.text()))
      if (!imported) return notify('导入失败：文件不是有效的 ChronoDesk 数据备份')
      setConfirmDialog({
        title: '导入本地数据',
        message: `将恢复 ${imported.tasks.length} 个任务、${imported.projects.length} 个项目和 ${imported.sessions.length} 条专注记录，并覆盖当前本地数据。确定继续吗？`,
        confirmLabel: '导入并覆盖',
        onConfirm: () => {
          setState(imported)
          setActiveTimerId(undefined)
          setSelectedTaskId(undefined)
          setTodaySelectedTaskId(undefined)
          setMode(imported.settings.defaultMode)
          setPhasePrompt(undefined)
          notify('数据已导入')
        },
      })
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      notify('导入失败：请确认选择的是 ChronoDesk 导出的 JSON 文件')
    }
  }
  function continueFocusInsteadOfBreak() {
    if (!backgroundActive || backgroundActive.phase === 'focus') { setPhasePrompt(undefined); return }
    const next: FocusSession = { id: createId('session'), taskId: backgroundActive.taskId, projectId: backgroundActive.projectId, mode: backgroundActive.mode, phase: 'focus', pomodoroIndex: backgroundActive.pomodoroIndex + (backgroundActive.mode === 'pomodoro' ? 1 : 0), startedAt: new Date().toISOString(), accumulatedMs: 0, status: 'running' }
    update((current) => transitionActiveSession(current, backgroundActive, [next]))
    setActiveTimerId(next.id)
    setPhasePrompt(undefined); notify('已继续专注，本轮结束后仍会提醒休息')
  }
  function deleteSessions(sessionIds: string[], onComplete: () => void) {
    if (!sessionIds.length) return
    const ids = new Set(sessionIds)
    setConfirmDialog({ title: '删除专注记录', message: `确定删除选中的 ${sessionIds.length} 条专注记录吗？任务不会受到影响。`, confirmLabel: '删除记录', onConfirm: () => { update((current) => ({ ...current, sessions: current.sessions.filter((session) => !ids.has(session.id)) })); onComplete(); notify(`已删除 ${sessionIds.length} 条专注记录`) } })
  }
  const titles: Record<View, string> = { today: '今日工作台', tasks: '所有任务', projects: '项目管理', history: '专注记录', stats: '数据统计', settings: '设置' }
  if (!storageReady || storageError) {
    return <div className="app-shell"><main className="main-content"><section className="page empty-state"><strong>{storageError ? '本地数据读取失败' : '正在读取本地数据…'}</strong><span>{storageError ? `${storageError}。为避免覆盖原有数据，应用已停止写入。请关闭应用后重试，或使用之前导出的 JSON 备份恢复。` : '正在恢复你的任务和专注记录，请稍候。'}</span></section></main></div>
  }
  return <div className="app-shell"><aside className="sidebar"><div className="brand"><div className="brand-mark"><img className="brand-logo" src="/logo.png" alt="ChronoDesk" /></div><div><strong>ChronoDesk</strong><span>个人效率工作台</span></div></div><nav className="main-nav"><NavItem icon={LayoutDashboard} label="今日工作台" active={view === 'today'} onClick={() => setView('today')} /><NavItem icon={Check} label="所有任务" count={state.tasks.filter((task) => task.status !== 'done').length} active={view === 'tasks'} onClick={() => setView('tasks')} /><NavItem icon={FolderKanban} label="项目管理" active={view === 'projects'} onClick={() => setView('projects')} /><NavItem icon={History} label="专注记录" active={view === 'history'} onClick={() => setView('history')} /><NavItem icon={BarChart3} label="数据统计" active={view === 'stats'} onClick={() => setView('stats')} /></nav><div className="sidebar-divider" /><div className="nav-caption">项目</div>{state.projects.slice(0, 4).map((project) => <button className={`project-link ${expandedProjectId === project.id ? 'selected' : ''}`} key={project.id} onClick={() => { setExpandedProjectId(project.id); setView('projects') }}><i style={{ background: project.color }} />{project.name}</button>)}{!state.projects.length && <span className="sidebar-empty">创建项目后会显示在这里</span>}<div className="sidebar-bottom"><NavItem icon={Settings} label="设置" active={view === 'settings'} onClick={() => setView('settings')} /><div className="data-status"><i />本地数据已保存</div><small>ChronoDesk v{appVersion} · Windows</small></div></aside><main className="main-content"><header className="topbar"><div className="breadcrumbs"><span>ChronoDesk</span><ChevronDown size={13} /><strong>{titles[view]}</strong></div><div className="top-actions"><button className="icon-button" aria-label="帮助与建议" title="帮助与建议" onClick={() => setHelpOpen(true)}><CircleHelp size={16} /></button></div></header>{view === 'today' && <TodayView tasks={state.tasks} projects={state.projects} sessions={state.sessions} now={now} dayKey={dayKey} todayFocus={todayFocus} completedToday={completedToday} settings={state.settings} activeTask={activeTask} selectedId={todaySelectedTaskId} active={active} mode={mode} setMode={setMode} onStart={startTimer} onPause={pauseTimer} onResume={resumeTimer} onFinish={() => finishTimer()} onNew={() => setModal('task')} onSelect={setTodaySelectedTaskId} onToggle={toggleTodayTask} taskCompletions={state.taskCompletions} onManageToday={openTodayTaskAction} />}{view === 'tasks' && <TasksView tasks={state.tasks} projects={state.projects} sessions={state.sessions} now={now} dayKey={dayKey} selectedId={selectedTaskId} onNew={() => setModal('task')} onStart={startTimer} onSelect={setSelectedTaskId} onToggle={toggleTask} onDelete={deleteTask} onDeleteMany={deleteTasks} onAddToToday={addToToday} onUpdateTask={updateTask} taskCompletions={state.taskCompletions} />}{view === 'projects' && <ProjectsView projects={state.projects} tasks={state.tasks} sessions={state.sessions} expandedProjectId={expandedProjectId} onExpand={setExpandedProjectId} onSelectTask={(id) => { setSelectedTaskId(id); setView('tasks') }} onNew={() => setModal('project')} onDelete={deleteProject} onReorder={reorderProjects} onEdit={setProjectToEdit} />}{view === 'history' && <HistoryView sessions={state.sessions} tasks={state.tasks} projects={state.projects} onDeleteSessions={deleteSessions} />}{view === 'stats' && <StatsView sessions={state.sessions} tasks={state.tasks} projects={state.projects} dailyGoalMs={state.settings.dailyGoalMs} taskCompletions={state.taskCompletions} />}{view === 'settings' && <SettingsView settings={state.settings} onChange={(settings) => update((current) => ({ ...current, settings }))} onExport={exportData} onImport={importData} />}</main>{modal === 'task' && <TaskModal projects={state.projects} onClose={() => setModal(null)} onCreate={createTask} />}{modal === 'project' && <ProjectModal onClose={() => setModal(null)} onCreate={saveProject} />}{projectToEdit && <ProjectModal project={projectToEdit} onClose={() => setProjectToEdit(undefined)} onCreate={saveProject} />}{duplicateCandidate && <DuplicateTaskModal candidate={duplicateCandidate} onMakeRecurring={() => reuseDuplicate(true)} onCreateAnyway={() => createTask(duplicateCandidate.draft, true)} onClose={() => setDuplicateCandidate(undefined)} />}{todayTaskAction && <TodayTaskActionModal task={todayTaskAction} onClose={() => setTodayTaskAction(undefined)} onMarkIncomplete={() => { setTodayTaskStatus(todayTaskAction.id, 'incomplete'); setTodayTaskAction(undefined) }} onDefer={() => { setTodayTaskStatus(todayTaskAction.id, 'deferred'); setTodayTaskAction(undefined) }} />}{helpOpen && <Modal title="帮助与建议" eyebrow="ChronoDesk" onClose={() => setHelpOpen(false)}><div className="help-content"><strong>产品建议与使用帮助</strong><span>欢迎通过小红书联系：<b>zerovista</b></span></div></Modal>}{availableUpdate && <Modal title="发现新版本" eyebrow="应用更新" onClose={() => setAvailableUpdate(undefined)}><div className="update-prompt"><strong>ChronoDesk {availableUpdate.version} 已发布</strong><span>{availableUpdate.body || '本次更新包含功能改进和问题修复。'}</span></div><div className="modal-actions"><button className="secondary-button" disabled={updateInstalling} onClick={() => setAvailableUpdate(undefined)}>稍后</button><button className="primary-button" disabled={updateInstalling} onClick={() => { void installAvailableUpdate() }}>{updateInstalling ? '正在更新' : '立即更新'}</button></div></Modal>}{phasePrompt && active && <Modal title={phasePrompt === 'stopwatch-goal' ? '已达到默认专注时长' : phasePrompt === 'break' ? '专注完成，休息一下' : '休息结束，准备开始'} eyebrow="番茄钟提醒" onClose={() => setPhasePrompt(undefined)}><div className="phase-prompt"><strong>{phasePrompt === 'stopwatch-goal' ? `已连续专注 ${state.settings.stopwatchFocusMinutes} 分钟，计时会继续累计。手动结束后会保存本段并开始休息。` : phasePrompt === 'break' ? `建议休息 ${active.mode === 'stopwatch' ? state.settings.stopwatchBreakMinutes : active.phase === 'long_break' ? state.settings.longBreakMinutes : state.settings.shortBreakMinutes} 分钟。` : '休息时间已结束，可以开始下一轮专注。'}</strong><span>{phasePrompt === 'stopwatch-goal' ? '你可以继续计时，准备好后手动结束专注。' : phasePrompt === 'break' ? '开始休息后会按设定时长计时。' : '点击按钮开始新的专注阶段。'}</span></div><div className="modal-actions"><button className="secondary-button" onClick={() => phasePrompt === 'stopwatch-goal' ? setPhasePrompt(undefined) : continueFocusInsteadOfBreak()}>{phasePrompt === 'stopwatch-goal' ? '继续正计时' : '稍后开始'}</button><button className="primary-button" onClick={() => phasePrompt === 'stopwatch-goal' ? finishTimer() : (setPhasePrompt(undefined), resumeTimer())}>{phasePrompt === 'stopwatch-goal' ? '结束专注并休息' : '开始'}</button></div></Modal>}{confirmDialog && <Modal title={confirmDialog.title} eyebrow="请确认操作" onClose={() => setConfirmDialog(undefined)}><p className="confirm-message">{confirmDialog.message}</p><div className="modal-actions"><button className="secondary-button" onClick={() => setConfirmDialog(undefined)}>取消</button><button className="danger-button confirm-danger" onClick={() => { const action = confirmDialog.onConfirm; setConfirmDialog(undefined); action() }}>{confirmDialog.confirmLabel ?? '确定'}</button></div></Modal>}{toast && <div className="toast" role="status"><Check size={15} />{toast}</div>}</div>
}

function TimerWidget() {
  const [timer, setTimer] = useState<TimerWidgetPayload>({ sessions: [], theme: 'light' })
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
  const elapsedFor = (session: TimerWidgetSession) => session.status === 'running' ? session.elapsedMs + (now - lastSync.current) : session.elapsedMs
  const phaseLabel = (phase: PomodoroPhase) => phase === 'focus' ? '专注中' : phase === 'short_break' ? '短休息' : '长休息'
  const sendAction = (timerId: string, action: TimerWidgetAction['action']) => { if (isTauriRuntime()) void emit('timer-widget-action', { action, timerId } satisfies TimerWidgetAction) }
  return <div className="timer-widget-root" data-theme={timer.theme}>
    <div className="timer-widget-drag" data-tauri-drag-region onMouseDown={() => { if (isTauriRuntime()) void widgetWindow?.startDragging() }}>
      <span>{timer.sessions.length} 个专注任务</span>
      <Clock3 size={16} />
    </div>
    <div className="timer-widget-list">
      {timer.sessions.map((session) => <div className="timer-widget-session" key={session.timerId} onClick={() => { if (isTauriRuntime()) void emit('timer-widget-select', { taskId: session.taskId }) }}>
        <div className="timer-widget-session-info" title={session.taskTitle}>
          <strong>{session.taskTitle}</strong>
          <span>{phaseLabel(session.phase)}{session.status === 'paused' ? ' · 已暂停' : ''}</span>
        </div>
        <time>{formatDuration(elapsedFor(session))}</time>
        <div className="timer-widget-actions">
          <button className="timer-widget-pause" onClick={() => sendAction(session.timerId, session.status === 'running' ? 'pause' : 'resume')} aria-label={session.status === 'running' ? `暂停${session.taskTitle}` : `继续${session.taskTitle}`}>{session.status === 'running' ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" />}</button>
          <button className="timer-widget-finish" onClick={() => sendAction(session.timerId, 'finish')} aria-label={`结束并保存${session.taskTitle}`}><Check size={13} /></button>
        </div>
      </div>)}
    </div>
  </div>
}

function NavItem({ icon: Icon, label, count, active, onClick }: { icon: typeof LayoutDashboard; label: string; count?: number; active: boolean; onClick: () => void }) { return <button className={`nav-item ${active ? 'selected' : ''}`} onClick={onClick}><Icon size={16} /><span>{label}</span>{count !== undefined && <em>{count}</em>}</button> }
function TodayView({ tasks, projects, sessions, now, dayKey, todayFocus, completedToday, taskCompletions, settings, activeTask, selectedId, active, mode, setMode, onStart, onPause, onResume, onFinish, onNew, onSelect, onToggle, onManageToday }: { tasks: Task[]; projects: Project[]; sessions: FocusSession[]; now: number; dayKey: string; todayFocus: number; completedToday: number; taskCompletions: ChronoState['taskCompletions']; settings: ChronoState['settings']; activeTask?: Task; selectedId?: string; active?: FocusSession; mode: TimerMode; setMode: (mode: TimerMode) => void; onStart: (id: string, mode?: TimerMode) => void; onPause: () => void; onResume: () => void; onFinish: () => void; onNew: () => void; onSelect: (id: string) => void; onToggle: (id: string) => void; onManageToday: (id: string) => void }) { const visibleTasks = tasks.filter((task) => isTaskVisibleToday(task, dayKey) || taskCompletionForDay(task.id, taskCompletions, dayKey)); const isCompletedToday = (task: Task) => { const record = taskCompletionForDay(task.id, taskCompletions, dayKey); return record?.status === 'completed' || (task.recurrence === 'none' && task.status === 'done' && Boolean(task.completedAt) && todayKey(new Date(task.completedAt as string).getTime()) === dayKey); }; const open = visibleTasks.sort((a, b) => Number(isCompletedToday(a)) - Number(isCompletedToday(b)) || a.sortOrder - b.sortOrder); const selectedTask = open.find((task) => task.id === selectedId); const progress = Math.min(100, Math.round(todayFocus / settings.dailyGoalMs * 100)); const pendingToday = open.filter((task) => !isCompletedToday(task)).length; const clearSelectionOnBlank = (event: React.MouseEvent<HTMLElement>) => { if (event.target === event.currentTarget) onSelect('') }; return <div className="page today-page"><div className="page-heading"><div><span className="eyebrow">{formatDate(new Date())}</span><h1>今天，专注做好一件事。</h1><p>清晰地知道下一步做什么，时间自然会留下答案。</p></div><button className="primary-button" onClick={onNew}><Plus size={15} />新建任务</button></div><div className="daily-metrics"><Metric icon={Target} label="今日专注" value={formatDuration(todayFocus, false)} hint={`${progress}% · 目标 ${formatDuration(settings.dailyGoalMs, false)}`} /><Metric icon={Check} label="完成任务" value={String(completedToday)} hint={`还有 ${pendingToday} 个待完成`} /><Metric icon={Trophy} label="专注会话" value={String(sessions.filter((session) => session.status === 'completed' && isFocusSession(session) && isRecordableSession(session, now) && todayKey(new Date(session.startedAt).getTime()) === dayKey).length)} hint="每一次记录都算数" /></div><div className="today-layout"><section onClick={clearSelectionOnBlank}><div className="section-heading" onClick={clearSelectionOnBlank}><div><h2>今天的任务</h2><span>{open.length ? `${open.length} 个任务` : '今天暂时没有任务'}</span></div><button className="text-button" onClick={onNew}><Plus size={14} />快速新增</button></div>{open.length ? <div className="task-list" onClick={clearSelectionOnBlank}>{open.map((task) => <TaskRow key={task.id} task={task} project={projects.find((project) => project.id === task.projectId)} sessions={sessions} now={now} selected={task.id === selectedTask?.id} onStart={onStart} onSelect={onSelect} onToggle={onToggle} todayMode dayKey={dayKey} taskCompletions={taskCompletions} onManageToday={onManageToday} />)}</div> : <EmptyState icon={Check} title="今天的清单是空的" description="新建一个任务，给今天一个明确的开始。" action="新建任务" onAction={onNew} />}</section><FocusPanel task={active ? activeTask : selectedTask} session={active} mode={mode} setMode={setMode} settings={settings} now={now} onStart={onStart} onPause={onPause} onResume={onResume} onFinish={onFinish} /></div><section className="progress-strip"><div className="section-heading"><div><h2>今日进度</h2><span>只统计真实完成的专注时间</span></div><strong>{progress}%</strong></div><div className="progress-track"><i style={{ width: `${progress}%` }} /></div></section></div> }

function TodayTaskActionModal({ task, onClose, onMarkIncomplete, onDefer }: { task: Task; onClose: () => void; onMarkIncomplete: () => void; onDefer: () => void }) {
  const requestDelete = () => { window.dispatchEvent(new CustomEvent('chronodesk-delete-today-task', { detail: { taskId: task.id, actionLabel: '取消创建任务' } })); onClose() }
  return <Modal title="今日任务处理" eyebrow="未完成任务" onClose={onClose}><div className="today-task-action-message"><strong>“{task.title}”还没有完成</strong><span>选择今天的处理方式，任务本身和历史记录不会被删除。</span></div><div className="today-task-action-options"><button className="secondary-button" onClick={onMarkIncomplete}>标记未完成</button><button className="primary-button" onClick={onDefer}>顺延一天</button></div><div className="today-task-action-delete"><button className="danger-button" onClick={requestDelete}><Trash2 size={15} />取消创建任务</button></div><div className="modal-actions"><button className="text-button" onClick={onClose}>取消</button></div></Modal>
}
function FocusPanel({ task, session, mode, setMode, settings, now, onStart, onPause, onResume, onFinish }: { task?: Task; session?: FocusSession; mode: TimerMode; setMode: (mode: TimerMode) => void; settings: ChronoState['settings']; now: number; onStart: (id: string, mode?: TimerMode) => void; onPause: () => void; onResume: () => void; onFinish: () => void }) {
  const elapsed = session ? sessionElapsed(session, now) : 0
  const currentMode = session?.mode ?? mode
  const durationSummary = currentMode === 'stopwatch'
    ? `默认专注 ${settings.stopwatchFocusMinutes} 分钟 · 休息 ${settings.stopwatchBreakMinutes} 分钟`
    : `单轮专注 ${settings.focusMinutes} 分钟 · 短休息 ${settings.shortBreakMinutes} 分钟 · 每 ${settings.longBreakEvery} 轮长休息 ${settings.longBreakMinutes} 分钟`
  return <section className={`focus-panel ${session ? 'active' : ''}`}><div className="section-heading"><div><span className="eyebrow">当前专注</span><h2>{task?.title ?? (session ? '任务已删除' : '选择一个任务开始')}</h2></div></div>{task || session ? <div className="focus-active-content"><span className="focus-context">{session ? (session.phase === 'short_break' ? '短休息' : session.phase === 'long_break' ? '长休息' : '专注阶段') : '准备开始'} · {currentMode === 'pomodoro' ? '番茄钟' : '正计时'}</span><label className="timer-mode-select"><span>计时方式</span><select aria-label="计时方式" value={currentMode} disabled={Boolean(session)} onChange={(event) => setMode(event.target.value as TimerMode)}><option value="stopwatch">正计时</option><option value="pomodoro">番茄钟</option></select></label><div className="focus-duration-summary">{durationSummary}</div><div className="focus-active-center"><div className="big-timer">{formatDuration(elapsed)}</div><div className="focus-actions">{session?.status === 'running' ? <button className="pause-button" onClick={onPause}><Pause size={16} fill="currentColor" />暂停</button> : session?.status === 'paused' ? <button className="primary-button" onClick={onResume}><Play size={16} fill="currentColor" />继续</button> : task ? <button className="primary-button" onClick={() => onStart(task.id, mode)}><Play size={16} fill="currentColor" />开始专注</button> : <span className="focus-orphan-note">该任务已删除，可结束并保存当前计时。</span>}{session && <button className="finish-button" onClick={onFinish}><Check size={15} />结束并保存</button>}</div></div><span className="focus-hint">窗口失焦、切换页面或系统休眠不会影响计时</span></div> : <div className="focus-empty-state"><div><Clock3 size={20} /></div><strong>还没有正在进行的专注</strong><span>从左侧任务列表开始一段专注时间。</span></div>}</section>
}
function TasksView({ tasks, projects, sessions, now, dayKey, selectedId, taskCompletions, onNew, onStart, onSelect, onToggle, onDelete, onDeleteMany, onAddToToday, onUpdateTask }: { tasks: Task[]; projects: Project[]; sessions: FocusSession[]; now: number; dayKey: string; selectedId?: string; taskCompletions: ChronoState['taskCompletions']; onNew: () => void; onStart: (id: string) => void; onSelect: (id: string) => void; onToggle: (id: string) => void; onDelete: (id: string) => void; onDeleteMany: (ids: string[], onComplete: () => void) => void; onAddToToday: (id: string) => void; onUpdateTask: (id: string, changes: Partial<Pick<Task, 'title' | 'projectId' | 'plannedMs' | 'priority' | 'recurrence' | 'description'>>) => void }) {
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])
  const selected = tasks.find((task) => task.id === selectedId) ?? tasks[0]
  const toggleSelection = (id: string) => setSelectedTaskIds((current) => current.includes(id) ? current.filter((taskId) => taskId !== id) : [...current, id])
  const cancelSelection = () => { setSelectedTaskIds([]); setSelectionMode(false) }
  const selectAll = () => setSelectedTaskIds(selectedTaskIds.length === tasks.length ? [] : tasks.map((task) => task.id))
  const deleteSelected = () => onDeleteMany(selectedTaskIds, cancelSelection)
  return <div className="page tasks-page content-page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 任务</span><h1>所有任务</h1><p>把需要完成的事放在一个清晰的地方。</p></div><button className="primary-button" onClick={onNew}><Plus size={15} />新建任务</button></div><div className="content-columns"><section className="task-list-panel"><div className="list-toolbar"><span>{selectionMode ? `已选择 ${selectedTaskIds.length} / ${tasks.length} 个任务` : `${tasks.length} 个任务`}</span>{tasks.length > 0 && <div className="bulk-actions">{selectionMode ? <><button className="text-button" onClick={selectAll}>{selectedTaskIds.length === tasks.length ? '取消全选' : '全选'}</button><button className="danger-button" disabled={!selectedTaskIds.length} onClick={deleteSelected}><Trash2 size={14} />删除所选</button><button className="secondary-button" onClick={cancelSelection}>取消</button></> : <button className="secondary-button" onClick={() => setSelectionMode(true)}>批量管理</button>}</div>}</div>{tasks.length ? tasks.map((task) => <TaskRow key={task.id} task={task} project={projects.find((project) => project.id === task.projectId)} sessions={sessions} now={now} dayKey={dayKey} taskCompletions={taskCompletions} selected={task.id === selected?.id} selectionMode={selectionMode} selectedForBulk={selectedTaskIds.includes(task.id)} onStart={onStart} onSelect={onSelect} onToggle={onToggle} onToggleSelection={toggleSelection} />) : <EmptyState icon={Check} title="还没有任务" description="创建一个任务，开始组织你的时间。" action="新建任务" onAction={onNew} />}</section><TaskDetail key={selected?.id ?? 'empty'} task={selected} projects={projects} project={projects.find((project) => project.id === selected?.projectId)} sessions={sessions} now={now} dayKey={dayKey} onStart={onStart} onDelete={onDelete} onAddToToday={onAddToToday} onUpdateTask={onUpdateTask} /></div></div>
}
function TaskRow({ task, project, sessions, now, dayKey, taskCompletions = [], selected, todayMode = false, selectionMode = false, selectedForBulk = false, onStart, onSelect, onToggle, onToggleSelection, onManageToday }: { task: Task; project?: Project; sessions: FocusSession[]; now: number; dayKey?: string; taskCompletions?: ChronoState['taskCompletions']; selected?: boolean; todayMode?: boolean; selectionMode?: boolean; selectedForBulk?: boolean; onStart: (id: string) => void; onSelect: (id: string) => void; onToggle: (id: string) => void; onToggleSelection?: (id: string) => void; onManageToday?: (id: string) => void }) {
  const actual = sessions.filter((session) => session.taskId === task.id && isFocusSession(session)).reduce((sum, session) => sum + sessionElapsed(session, now), 0)
  const todayRecord = todayMode && dayKey ? taskCompletionForDay(task.id, taskCompletions, dayKey) : undefined
  const completedByTask = todayMode && dayKey && task.status === 'done' && task.completedAt && todayKey(new Date(task.completedAt).getTime()) === dayKey
  const checked = selectionMode ? selectedForBulk : todayMode ? todayRecord?.status === 'completed' || Boolean(completedByTask) : task.status === 'done'
  const longCount = task.recurrence === 'daily' ? taskCompletions.filter((completion) => completion.taskId === task.id && completion.status === 'completed').length : 0
  const completionTime = todayMode ? (todayRecord?.completedAt ?? (completedByTask ? task.completedAt : undefined)) : task.completedAt
  const checkLabel = selectionMode
    ? (checked ? '取消选择任务' : '选择任务')
    : todayRecord?.status === 'incomplete'
      ? '今日标记未完成，点击标记完成'
      : todayRecord?.status === 'deferred'
        ? '今日任务已顺延，点击标记完成'
        : checked ? '标记为待办' : '标记为完成'
  const handleRowClick = () => selectionMode ? onToggleSelection?.(task.id) : onSelect(task.id)
  const statusClass = todayMode && todayRecord?.status ? `today-status-${todayRecord.status}` : ''
  return <div className={`task-row ${selected ? 'selected' : ''} ${(todayMode ? checked : task.status === 'done') ? 'task-done' : ''} ${selectionMode ? 'bulk-select-row' : ''}`} onClick={handleRowClick}><button className={`check-box ${checked ? 'checked' : ''} ${statusClass}`} aria-label={checkLabel} onClick={(event) => { event.stopPropagation(); selectionMode ? onToggleSelection?.(task.id) : onToggle(task.id) }}>{todayRecord?.status === 'incomplete' ? <span className="today-status-mark" aria-hidden="true">×</span> : todayRecord?.status === 'deferred' ? <span className="today-status-mark" aria-hidden="true">↷</span> : checked && <span className="check-mark" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="m3.25 8.25 3.1 3.1 6.4-6.7" /></svg></span>}</button><div className="task-main"><strong className={checked ? 'done-text' : ''}>{task.title}{task.recurrence === 'daily' && <em className="recurrence-badge">长期任务</em>}{longCount > 0 && !todayMode && <small className="recurrence-count">已完成 {longCount} 次</small>}{completionTime && <small className="task-completed-at">完成于 {formatTime(new Date(completionTime))}</small>}</strong><span><i style={{ background: project?.color }} />{project?.name ?? '未分类'}</span></div><span className={`priority ${task.priority}`}>{priorityNames[task.priority]}</span><span className="task-time">{formatDuration(actual, false)} <small>/ {formatDuration(task.plannedMs, false)}</small></span>{!selectionMode && <>{todayMode && <button className="row-dismiss" title="今日任务处理" aria-label="今日任务处理" onClick={(event) => { event.stopPropagation(); onManageToday?.(task.id) }}><X size={14} /></button>}{!todayMode && <button className="row-start" title="开始计时" onClick={(event) => { event.stopPropagation(); onStart(task.id) }}><Play size={13} fill="currentColor" /></button>}</>}</div>
}
function TaskDescriptionEditor({ value, onSave }: { value: string; onSave: (description: string) => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  if (!editing) return <button className={`task-description ${value ? 'has-description' : 'empty-description'}`} onClick={() => { setDraft(value); setEditing(true) }}>{value || '添加描述'}</button>
  return <div className="task-description-editor"><textarea autoFocus value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="写下任务描述…" /><div><button className="secondary-button" onClick={() => { setDraft(value); setEditing(false) }}>取消</button><button className="primary-button" onClick={() => { onSave(draft.trim()); setEditing(false) }}>保存</button></div></div>
}

function TaskDetail({ task, projects, project, sessions, now, dayKey, onStart, onDelete, onAddToToday, onUpdateTask }: { task?: Task; projects: Project[]; project?: Project; sessions: FocusSession[]; now: number; dayKey: string; onStart: (id: string) => void; onDelete: (id: string) => void; onAddToToday: (id: string) => void; onUpdateTask: (id: string, changes: Partial<Pick<Task, 'title' | 'projectId' | 'plannedMs' | 'priority' | 'recurrence' | 'description'>>) => void }) {
  const [editOpen, setEditOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  if (!task) return <aside className="detail-panel empty-detail"><FolderKanban size={24} /><span>选择任务查看详情</span></aside>
  const rows = sessions.filter((session) => session.taskId === task.id && isRecordableSession(session, now)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const addedToday = task.todayAddedOn === dayKey && task.todayDismissedOn !== dayKey
  return <aside className="detail-panel"><div className="detail-kicker">任务详情</div><div className="detail-title"><i style={{ background: project?.color }} /><div className="detail-title-content"><h2>{task.title}</h2><span>{project?.name ?? '未分类'}</span></div><button className="secondary-button detail-edit-button" onClick={() => setEditOpen(true)}><Pencil size={14} />编辑任务</button></div><TaskDescriptionEditor key={task.id} value={task.description} onSave={(description) => onUpdateTask(task.id, { description })} />{task.recurrence === 'daily' && <button className="add-today-detail" onClick={() => onAddToToday(task.id)} disabled={addedToday}>{addedToday ? '已添加到今日任务' : '添加到今日任务'}</button>}<div className="task-detail-options"><div><strong>优先级</strong><div className="priority-picker">{(['low', 'medium', 'high'] as Priority[]).map((priority) => <button key={priority} className={task.priority === priority ? 'active' : ''} onClick={() => onUpdateTask(task.id, { priority })}>{priorityNames[priority]}</button>)}</div></div><label className="recurrence-toggle"><input type="checkbox" checked={task.recurrence === 'daily'} onChange={(event) => onUpdateTask(task.id, { recurrence: event.target.checked ? 'daily' : 'none' })} />长期任务</label></div><div className="detail-stats"><div><span>实际投入</span><strong>{formatDuration(rows.filter(isFocusSession).reduce((sum, session) => sum + sessionElapsed(session, now), 0), false)}</strong></div><div><span>目标时间</span><strong>{formatDuration(task.plannedMs, false)}</strong></div></div><button className="wide-start" onClick={() => onStart(task.id)}><Play size={14} fill="currentColor" />开始计时</button><button className="danger-button detail-delete-button" onClick={() => onDelete(task.id)}><Trash2 size={14} /><span>删除任务</span></button><div className="mini-history"><button className="mini-history-toggle" aria-expanded={historyOpen} onClick={() => setHistoryOpen((open) => !open)}><span>历史会话 <small>{rows.length} 条</small></span><ChevronDown size={16} className={historyOpen ? 'expanded' : ''} /></button>{historyOpen && (rows.length ? rows.slice(0, 5).map((session) => <div className="mini-session" key={session.id}><i className={`session-dot ${session.status}`} /><div><strong>{session.phase === 'focus' ? '专注' : '休息'} · {session.mode === 'pomodoro' ? '番茄钟' : '正计时'}</strong><span>{formatDate(new Date(session.startedAt))} · {formatTime(new Date(session.startedAt))}</span></div><b>{formatDuration(sessionElapsed(session, now), false)}</b></div>) : <span className="mini-history-empty">暂无历史会话</span>)}</div>{editOpen && <TaskEditModal task={task} projects={projects} onClose={() => setEditOpen(false)} onSave={(changes) => { onUpdateTask(task.id, changes); setEditOpen(false) }} />}</aside>
}
function ProjectsView({ projects, tasks, sessions, expandedProjectId, onExpand, onSelectTask, onNew, onDelete, onReorder, onEdit }: { projects: Project[]; tasks: Task[]; sessions: FocusSession[]; expandedProjectId?: string; onExpand: (id: string | undefined) => void; onSelectTask: (id: string) => void; onNew: () => void; onDelete: (id: string) => void; onReorder: (sourceId: string, targetId: string) => void; onEdit: (project: Project) => void }) {
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

  return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 项目</span><h1>项目管理</h1><p>用项目给任务一个稳定的上下文。</p></div><button className="primary-button" onClick={onNew}><Plus size={15} />新建项目</button></div>{projects.length ? <div className="project-grid">{projects.map((project) => { const projectTasks = tasks.filter((task) => task.projectId === project.id); const total = sessions.filter((session) => session.projectId === project.id && isFocusSession(session)).reduce((sum, session) => sum + session.accumulatedMs, 0); const expanded = expandedProjectId === project.id; return <div className={`project-card ${expanded ? 'expanded' : ''} ${draggedId === project.id ? 'dragging' : ''} ${dragOverId === project.id ? 'drag-over' : ''}`} key={project.id} role="button" tabIndex={0} aria-expanded={expanded} onClick={() => toggleExpanded(project.id)} onKeyDown={(event) => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleExpanded(project.id) } }} draggable onDragStart={() => { suppressClickRef.current = true; setDraggedId(project.id) }} onDragOver={(event) => { event.preventDefault(); if (draggedId !== project.id) setDragOverId(project.id) }} onDrop={(event) => { event.preventDefault(); dropProject(project.id) }} onDragEnd={clearDrag}><div className="project-card-top"><span className="project-symbol" style={{ background: project.color }}><FolderKanban size={17} /></span><div className="project-actions"><button className="project-menu-button" aria-label={`打开${project.name}项目菜单`} title="项目菜单" onClick={(event) => { event.stopPropagation(); setMenuId(menuId === project.id ? undefined : project.id) }}><MoreHorizontal size={16} /></button>{menuId === project.id && <div className="project-menu" onClick={(event) => event.stopPropagation()}><button onClick={() => { setMenuId(undefined); onEdit(project) }}><Pencil size={14} />编辑项目</button><button className="project-menu-danger" onClick={() => { setMenuId(undefined); onDelete(project.id) }}><Trash2 size={14} />删除项目</button></div>}</div></div><strong>{project.name}</strong><span>{projectTasks.length} 个任务 · {formatDuration(total, false)} 已投入</span><div className="project-progress"><i style={{ width: `${projectTasks.length ? projectTasks.filter((task) => task.status === 'done').length / projectTasks.length * 100 : 0}%`, background: project.color }} /></div>{expanded && <div className="project-task-list" onClick={(event) => event.stopPropagation()}><div className="project-task-heading">项目任务 <span>{projectTasks.length}</span></div>{projectTasks.length ? projectTasks.map((task) => <button className={`project-task-row ${task.status === 'done' ? 'done' : ''}`} key={task.id} onClick={() => onSelectTask(task.id)}><span className="project-task-title">{task.title}</span><span className="project-task-status">{task.status === 'done' ? '已完成' : '待完成'}</span><span className={`priority ${task.priority}`}>{priorityNames[task.priority]}</span></button>) : <span className="project-tasks-empty">此项目还没有任务</span>}</div>}</div> })}</div> : <EmptyState icon={FolderKanban} title="还没有项目" description="把相互关联的任务放在同一个项目中。" action="新建项目" onAction={onNew} />}</div>
}function HistoryView({ sessions, tasks, projects, onDeleteSessions }: { sessions: FocusSession[]; tasks: Task[]; projects: Project[]; onDeleteSessions: (ids: string[], onComplete: () => void) => void }) {
  const rows = sessions.filter((session) => session.status === 'completed').sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const toggle = (id: string) => setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleAll = () => setSelectedIds(selectedIds.length === rows.length ? [] : rows.map((session) => session.id))
  return <div className="page history-page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 记录</span><h1>专注记录</h1><p>每一次真实投入都会在这里留下记录。</p></div><button className="secondary-button"><Download size={14} />导出记录</button></div><div className="history-summary"><div><span>记录总数</span><strong>{rows.length}</strong></div><div><span>有效专注</span><strong>{formatDuration(rows.filter(isFocusSession).reduce((sum, session) => sum + session.accumulatedMs, 0), false)}</strong></div><div><span>番茄周期</span><strong>{rows.filter((session) => session.mode === 'pomodoro' && isFocusSession(session)).length}</strong></div></div><div className={`history-table ${selectionMode ? 'selection-mode' : ''}`}><div className="history-toolbar"><span>{selectionMode && selectedIds.length ? `已选择 ${selectedIds.length} 条记录` : `${rows.length} 条记录`}</span><div>{selectionMode ? <><button className="text-button" onClick={toggleAll} disabled={!rows.length}>{selectedIds.length === rows.length && rows.length ? '取消全选' : '全选'}</button><button className="danger-button" disabled={!selectedIds.length} onClick={() => onDeleteSessions(selectedIds, () => setSelectedIds([]))}><Trash2 size={14} />删除所选</button><button className="secondary-button" onClick={() => { setSelectedIds([]); setSelectionMode(false) }}>退出</button></> : <button className="secondary-button" disabled={!rows.length} onClick={() => setSelectionMode(true)}>批量管理</button>}</div></div><div className="history-head"><span className="history-check-column"></span><span>任务</span><span>项目</span><span>开始时间</span><span>模式</span><span>有效时长</span></div>{rows.length ? rows.map((session) => { const task = tasks.find((item) => item.id === session.taskId); const project = projects.find((item) => item.id === session.projectId); return <div className="history-row history-selectable" key={session.id}><span className="history-check-column">{selectionMode && <input type="checkbox" aria-label={`选择记录 ${task?.title ?? '已删除任务'}`} checked={selectedIds.includes(session.id)} onChange={() => toggle(session.id)} />}</span><strong><i className="project-dot" style={{ background: project?.color }} />{task?.title ?? '已删除任务'}</strong><span>{project?.name ?? '未分类'}</span><span>{formatDate(new Date(session.startedAt))} {formatTime(new Date(session.startedAt))}</span><span>{session.mode === 'pomodoro' ? '番茄钟' : '正计时'}</span><strong>{formatDuration(session.accumulatedMs, false)}</strong></div> }) : <EmptyState icon={History} title="还没有专注记录" description="完成一段计时后，真实记录会显示在这里。" action="去开始计时" onAction={() => undefined} />}</div></div>
}
function StatsView({ sessions, tasks, projects, dailyGoalMs, taskCompletions }: { sessions: FocusSession[]; tasks: Task[]; projects: Project[]; dailyGoalMs: number; taskCompletions: ChronoState['taskCompletions'] }) {
  const [period, setPeriod] = useState<'month' | 'year'>('month')
  const [cursor, setCursor] = useState(() => new Date())
  const [selectedBucketKey, setSelectedBucketKey] = useState<string>()
  const taskIds = new Set(tasks.map((task) => task.id))
  const completed = sessions.filter((session) => taskIds.has(session.taskId) && session.status === 'completed' && isFocusSession(session) && isRecordableSession(session, Date.now()))
  const year = cursor.getFullYear()
  const month = cursor.getMonth()
  const count = period === 'month' ? new Date(year, month + 1, 0).getDate() : 12
  const buckets = Array.from({ length: count }, (_, index) => {
    const date = period === 'month' ? new Date(year, month, index + 1) : new Date(year, index, 1)
    const value = completed.filter((session) => {
      const started = new Date(session.startedAt)
      return period === 'month' ? started.getFullYear() === year && started.getMonth() === month && started.getDate() === date.getDate() : started.getFullYear() === year && started.getMonth() === index
    }).reduce((sum, session) => sum + session.accumulatedMs, 0)
    return { date, value, key: period === 'month' ? `${year}-${month}-${index}` : `${year}-${index}` }
  })
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0)
  const average = total / count
  const goalTotal = dailyGoalMs * (period === 'month' ? count : 365 + (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 1 : 0))
  const title = period === 'month' ? `${year} 年 ${month + 1} 月` : `${year} 年`
  const movePeriod = (direction: number) => { setCursor((current) => new Date(period === 'month' ? current.getFullYear() : current.getFullYear() + direction, period === 'month' ? current.getMonth() + direction : 0, 1)); setSelectedBucketKey(undefined) }
  const changePeriod = (next: 'month' | 'year') => { setPeriod(next); setSelectedBucketKey(undefined) }
  const completedTaskRows = [
    ...tasks.filter((task) => task.recurrence === 'none' && task.completedAt).map((task) => ({ task, day: todayKey(new Date(task.completedAt as string).getTime()), completedAt: task.completedAt as string, recurring: false })),
    ...taskCompletions.filter((completion) => taskIds.has(completion.taskId) && completion.status === 'completed' && completion.completedAt).map((completion) => { const task = tasks.find((item) => item.id === completion.taskId); return { task, day: completion.day, completedAt: completion.completedAt as string, recurring: task?.recurrence === 'daily' } }).filter((row) => row.recurring),
  ].filter((row) => row.day.startsWith(period === 'month' ? `${year}-${String(month + 1).padStart(2, '0')}` : `${year}-`)).sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  const selectedBucket = buckets.find((bucket) => bucket.key === selectedBucketKey)
  const visibleCompletedTaskRows = selectedBucketKey
    ? completedTaskRows.filter((row) => period === 'month' ? row.day === `${year}-${String(month + 1).padStart(2, '0')}-${String(selectedBucket?.date.getDate() ?? 0).padStart(2, '0')}` : row.day.startsWith(`${year}-${String((selectedBucket?.date.getMonth() ?? 0) + 1).padStart(2, '0')}`))
    : completedTaskRows
  const selectedLabel = selectedBucket ? (period === 'month' ? `${year}年${month + 1}月${selectedBucket.date.getDate()}日` : `${year}年${selectedBucket.date.getMonth() + 1}月`) : ''
  return <div className="page stats-page"><div className="page-heading compact"><div><span className="eyebrow">工作台 / 分析</span><h1>数据统计</h1><p>用真实记录看见你的时间投入。</p></div><span className="data-note">只统计已完成的真实会话</span></div><div className="stats-grid"><StatCard label="专注总时长" value={formatDuration(total, false)} hint={title} /><StatCard label="平均每日" value={formatDuration(average, false)} hint={period === 'month' ? '所选月份' : '所选年度日均'} /><StatCard label="完成任务" value={String(visibleCompletedTaskRows.length)} hint={selectedLabel || "所选周期"} /><StatCard label="目标完成度" value={`${goalTotal ? Math.min(100, Math.round(total / goalTotal * 100)) : 0}%`} hint={`每日目标 ${formatDuration(dailyGoalMs, false)}`} /></div><div className="analytics-grid"><section className="chart-panel"><div className="section-heading stats-chart-heading"><div><h2>{period === 'month' ? '月度专注' : '年度专注'}</h2><span>{period === 'month' ? '按天查看专注时间' : '按月查看专注时间'}</span></div><div className="chart-controls"><div className="segmented"><button className={period === 'month' ? 'active' : ''} onClick={() => changePeriod('month')}>月度</button><button className={period === 'year' ? 'active' : ''} onClick={() => changePeriod('year')}>年度</button></div><button className="secondary-button period-arrow" aria-label="上一个周期" onClick={() => movePeriod(-1)}><ChevronLeft size={18} /></button><strong className="period-title">{title}</strong><button className="secondary-button period-arrow" aria-label="下一个周期" onClick={() => movePeriod(1)}><ChevronRight size={18} /></button></div></div><div className={`bar-chart ${period === 'month' ? 'daily-chart' : 'monthly-chart'}`} style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}>{buckets.map((bucket, index) => { const target = period === 'month' ? dailyGoalMs : dailyGoalMs * new Date(year, index + 1, 0).getDate(); const ratio = target > 0 ? Math.min(100, bucket.value / target * 100) : 0; return <button type="button" className={"bar-column " + (selectedBucketKey === bucket.key ? "selected" : "")} key={bucket.key} title={`${period === "month" ? `${month + 1}月${index + 1}日` : `${index + 1}月`} · ${formatDuration(bucket.value, false)}`} aria-label={`${period === "month" ? `${month + 1}月${index + 1}日` : `${index + 1}月`}，${formatDuration(bucket.value, false)}`} aria-pressed={selectedBucketKey === bucket.key} onClick={() => setSelectedBucketKey(selectedBucketKey === bucket.key ? undefined : bucket.key)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setSelectedBucketKey(selectedBucketKey === bucket.key ? undefined : bucket.key) } }}><span>{bucket.value ? formatDuration(bucket.value, false) : '0'}</span><div className="bar-track"><i style={{ height: `${ratio}%` }} /></div><small>{period === 'month' ? `${index + 1}` : `${index + 1}月`}</small></button> })}</div></section><section className="chart-panel"><div className="section-heading"><div><h2>项目分布</h2><span>累计有效专注时间</span></div></div>{projects.length ? projects.map((project) => { const totalProject = completed.filter((session) => session.projectId === project.id).reduce((sum, session) => sum + session.accumulatedMs, 0); return <div className="distribution-row" key={project.id}><span><i className="project-dot" style={{ background: project.color }} />{project.name}</span><strong>{formatDuration(totalProject, false)}</strong></div> }) : <div className="chart-empty">完成会话后这里会生成项目分布。</div>}</section></div><section className="completed-task-panel"><div className="section-heading"><div><h2>每日完成任务</h2><span>{selectedLabel ? `当前查看 ${selectedLabel}` : period === "month" ? "按天查看所选月份的完成记录" : "按月查看所选年度的完成记录"}</span></div><div className="completed-task-heading-actions"><strong>{visibleCompletedTaskRows.length} 条</strong>{selectedBucketKey && <button className="text-button" onClick={() => setSelectedBucketKey(undefined)}>查看全部</button>}</div></div>{visibleCompletedTaskRows.length ? visibleCompletedTaskRows.map((row, index) => <div className="completed-task-row" key={`${row.task?.id ?? 'deleted'}-${row.day}-${row.completedAt}-${index}`}><span>{row.day}</span><strong>{row.task?.title ?? '已删除任务'}</strong><small>{row.recurring ? '长期任务' : '普通任务'} · {formatTime(new Date(row.completedAt))}</small></div>) : <div className="chart-empty">当前周期还没有完成任务。</div>}</section></div>
}
function SettingsView({ settings, onChange, onExport, onImport }: { settings: ChronoState['settings']; onChange: (settings: ChronoState['settings']) => void; onExport: () => void | Promise<void>; onImport: () => void | Promise<void> }) {
  const [section, setSection] = useState<SettingsSection>('preferences')
  const themes: Array<{ value: ChronoState['settings']['theme']; label: string; icon: typeof Sun }> = [
    { value: 'light', label: '浅色', icon: Sun },
    { value: 'dark', label: '深色', icon: Moon },
    { value: 'system', label: '跟随系统', icon: Monitor },
  ]
  const isDataSection = () => section === 'data'
  if (isDataSection()) return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">ChronoDesk / 偏好</span><h1>设置</h1><p>让计时方式适应你的工作节奏。</p></div></div><div className="settings-layout"><nav className="settings-menu"><button className={section === 'preferences' ? 'active' : ''} onClick={() => setSection('preferences')}><Settings size={15} />计时与偏好</button><button className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}><Sun size={15} />外观</button><button className={section === 'data' ? 'active' : ''} onClick={() => setSection('data')}><Download size={15} />数据管理</button></nav><section className="settings-content settings-content-data"><SettingSection title="数据管理" description="数据保存在本机，可随时导出或恢复"><SettingRow label="导出本地数据" description="选择保存目录，包含任务、项目、会话和设置"><button className="secondary-button" onClick={() => { void onExport() }}><Download size={14} />选择位置并导出</button></SettingRow><SettingRow label="导入本地数据" description="选择之前导出的 JSON 备份并恢复记录"><button className="secondary-button" onClick={() => { void onImport() }}><FileUp size={14} />导入 JSON</button></SettingRow><UpdateCheckRow /></SettingSection></section></div></div>
  return <div className="page"><div className="page-heading compact"><div><span className="eyebrow">ChronoDesk / 偏好</span><h1>设置</h1><p>让计时方式适应你的工作节奏。</p></div></div><div className="settings-layout"><nav className="settings-menu"><button className={section === 'preferences' ? 'active' : ''} onClick={() => setSection('preferences')}><Settings size={15} />计时与偏好</button><button className={section === 'appearance' ? 'active' : ''} onClick={() => setSection('appearance')}><Sun size={15} />外观</button><button className={section === 'data' ? 'active' : ''} onClick={() => setSection('data')}><Download size={15} />数据管理</button></nav><section className={`settings-content settings-content-${section}`}><SettingSection section="appearance" title="外观" description="选择适合当前环境的显示方式"><SettingRow label="主题" description="跟随系统时会响应 Windows 的主题变化"><div className="segmented theme-segmented">{themes.map(({ value, label, icon: Icon }) => <button className={settings.theme === value ? 'active' : ''} key={value} onClick={() => onChange({ ...settings, theme: value })}><Icon size={14} />{label}</button>)}</div></SettingRow></SettingSection><div className="settings-section settings-section-preferences"><SettingSection title="正计时" description="达到默认专注目标时提醒；计时继续累计，手动结束后开始休息"><SettingRow label="默认专注时长" description="正计时达到此时长时提示你休息"><NumberField value={settings.stopwatchFocusMinutes} suffix="分钟" onChange={(value) => onChange({ ...settings, stopwatchFocusMinutes: value })} /></SettingRow><SettingRow label="休息时长" description="结束正计时专注后进入的休息阶段"><NumberField value={settings.stopwatchBreakMinutes} suffix="分钟" onChange={(value) => onChange({ ...settings, stopwatchBreakMinutes: value })} /></SettingRow></SettingSection><SettingSection title="番茄钟" description="专注和休息按设定阶段自动切换"><SettingRow label="单轮专注时长" description="番茄钟的单个专注阶段"><NumberField value={settings.focusMinutes} suffix="分钟" onChange={(value) => onChange({ ...settings, focusMinutes: value })} /></SettingRow><SettingRow label="休息时长" description="短休息和长休息"><div className="inline-fields"><NumberField value={settings.shortBreakMinutes} suffix="短休息" onChange={(value) => onChange({ ...settings, shortBreakMinutes: value })} /><NumberField value={settings.longBreakMinutes} suffix="长休息" onChange={(value) => onChange({ ...settings, longBreakMinutes: value })} /></div></SettingRow><SettingRow label="长休息间隔" description="完成几轮专注后进入长休息"><NumberField value={settings.longBreakEvery} suffix="轮专注" onChange={(value) => onChange({ ...settings, longBreakEvery: Math.max(1, Math.round(value)) })} /></SettingRow></SettingSection><SettingSection title="阶段结束提醒" description="开启后阶段结束时暂停并提醒；关闭后番茄钟及休息阶段自动继续"><label className="switch-control"><input type="checkbox" checked={settings.phaseEndReminderEnabled} onChange={(event) => onChange({ ...settings, phaseEndReminderEnabled: event.target.checked })} /><span>{settings.phaseEndReminderEnabled ? '开启' : '关闭'}</span></label></SettingSection><SettingSection title="每日目标" description="用于今日进度和目标完成度"><SettingRow label="每日专注目标" description="根据你的实际工作时间设定"><NumberField value={Math.round(settings.dailyGoalMs / 3600000)} suffix="小时" onChange={(value) => onChange({ ...settings, dailyGoalMs: value * 3600000 })} /></SettingRow></SettingSection></div><div className="settings-section settings-section-data"><SettingSection title="数据管理" description="数据保存在本机，可随时导出或恢复"><SettingRow label="导出本地数据" description="选择保存目录，包含任务、项目、会话和设置"><button className="secondary-button" onClick={() => { void onExport() }}><Download size={14} />选择位置并导出</button></SettingRow><SettingRow label="导入本地数据" description="选择之前导出的 JSON 备份并恢复记录"><button className="secondary-button" onClick={() => { void onImport() }}><FileUp size={14} />导入 JSON</button></SettingRow></SettingSection></div></section></div></div>
}
function UpdateCheckRow() {
  const [status, setStatus] = useState<UpdateCheckStatus>('idle')
  const [update, setUpdate] = useState<Update | null>(null)
  const [installing, setInstalling] = useState(false)
  const checkForUpdate = async () => {
    if (!isTauriRuntime()) { setStatus('error'); return }
    setStatus('checking')
    try {
      const found = await check({ timeout: 10000 })
      if (found) { setStatus('idle'); setUpdate(found) }
      else setStatus('latest')
    } catch {
      setStatus('error')
    }
  }
  const closeUpdate = () => { void update?.close(); setUpdate(null) }
  const installUpdate = async () => {
    if (!update || installing) return
    setInstalling(true)
    try {
      await update.downloadAndInstall()
      await relaunch()
    } catch {
      setInstalling(false)
      setStatus('error')
      closeUpdate()
    }
  }
  return <><SettingRow label="检查应用更新" description={status === 'checking' ? '正在连接更新服务…' : status === 'latest' ? '当前已是最新版本' : status === 'error' ? '检查失败，请确认网络或 GitHub Release 后重试' : '手动检查 GitHub Releases 中是否有新版本'}><button className="secondary-button" disabled={status === 'checking'} onClick={() => { void checkForUpdate() }}><RefreshCw size={14} />{status === 'checking' ? '检查中' : '检查更新'}</button></SettingRow>{update && <Modal title="发现新版本" eyebrow="应用更新" onClose={installing ? () => undefined : closeUpdate}><div className="update-prompt"><strong>ChronoDesk {update.version} 已发布</strong><span>{update.body || '本次更新包含功能改进和问题修复。'}</span></div><div className="modal-actions"><button className="secondary-button" disabled={installing} onClick={closeUpdate}>稍后</button><button className="primary-button" disabled={installing} onClick={() => { void installUpdate() }}>{installing ? '正在更新' : '立即更新'}</button></div></Modal>}</>
}
function SettingSection({ section, title, description, children }: { section?: SettingsSection; title: string; description: string; children: React.ReactNode }) { return <section className={`setting-section ${section ? `setting-section-${section}` : ''}`}><div className="setting-heading"><h2>{title}</h2><span>{description}</span></div>{children}</section> }
function SettingRow({ label, description, children }: { label: string; description: string; children: React.ReactNode }) { return <div className="setting-row"><div><strong>{label}</strong><span>{description}</span></div><div className="setting-control">{children}</div></div> }
function NumberField({ value, suffix, onChange }: { value: number; suffix: string; onChange: (value: number) => void }) { return <label className="number-field"><input type="number" min="1" max="240" value={value} onChange={(event) => onChange(Math.max(1, Number(event.target.value) || 1))} /><span>{suffix}</span></label> }
function Metric({ icon: Icon, label, value, hint }: { icon: typeof Target; label: string; value: string; hint: string }) { return <div className="metric"><div className="metric-icon"><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div> }
function StatCard({ label, value, hint }: { label: string; value: string; hint: string }) { return <div className="stat-card"><span>{label}</span><strong>{value}</strong><small>{hint}</small></div> }
function EmptyState({ icon: Icon, title, description, action, onAction }: { icon: typeof Check; title: string; description: string; action: string; onAction: () => void }) { return <div className="empty-state"><div><Icon size={21} /></div><strong>{title}</strong><span>{description}</span><button className="secondary-button" onClick={onAction}>{action}</button></div> }
function TaskModal({ projects, onClose, onCreate }: { projects: Project[]; onClose: () => void; onCreate: (draft: TaskDraft) => void }) { const [title, setTitle] = useState(''); const [projectId, setProjectId] = useState(projects[0]?.id ?? ''); const [priority, setPriority] = useState<Priority>('medium'); const [minutes, setMinutes] = useState(45); const [recurrence, setRecurrence] = useState<TaskRecurrence>('none'); return <Modal title="新建任务" eyebrow="任务" onClose={onClose}><label className="form-label">任务名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：完成项目首页" /></label><label className="form-label">项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">未分类</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><div className="form-label">优先级<div className="choice-row">{(['low', 'medium', 'high'] as Priority[]).map((item) => <button type="button" className={priority === item ? 'active' : ''} key={item} onClick={() => setPriority(item)}>{priorityNames[item]}优先级</button>)}</div></div><label className="form-label">预计时长（分钟）<input type="number" min="1" value={minutes} onChange={(event) => setMinutes(Number(event.target.value) || 1)} /></label><label className="recurrence-toggle form-recurring"><input type="checkbox" checked={recurrence === 'daily'} onChange={(event) => setRecurrence(event.target.checked ? 'daily' : 'none')} />长期任务（每天完成后次日继续）</label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} onClick={() => onCreate({ title: title.trim(), projectId, priority, plannedMinutes: minutes, recurrence })}><Plus size={14} />创建任务</button></div></Modal> }
function TaskEditModal({ task, projects, onClose, onSave }: { task: Task; projects: Project[]; onClose: () => void; onSave: (changes: Pick<Task, 'title' | 'projectId' | 'plannedMs'>) => void }) {
  const [title, setTitle] = useState(task.title)
  const [projectId, setProjectId] = useState(task.projectId)
  const [minutes, setMinutes] = useState(Math.max(1, Math.round(task.plannedMs / 60000)))
  return <Modal title="编辑任务" eyebrow="任务" onClose={onClose}><label className="form-label">任务名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} /></label><label className="form-label">项目<select value={projectId} onChange={(event) => setProjectId(event.target.value)}><option value="">未分类</option>{projects.map((project) => <option value={project.id} key={project.id}>{project.name}</option>)}</select></label><label className="form-label">预计时长（分钟）<input type="number" min="1" value={minutes} onChange={(event) => setMinutes(Math.max(1, Number(event.target.value) || 1))} /></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} onClick={() => onSave({ title: title.trim(), projectId, plannedMs: minutes * 60000 })}>保存修改</button></div></Modal>
}
function DuplicateTaskModal({ candidate, onMakeRecurring, onCreateAnyway, onClose }: { candidate: DuplicateCandidate; onMakeRecurring: () => void; onCreateAnyway: () => void; onClose: () => void }) { return <Modal title={candidate.recurringExists ? '长期任务已存在' : '发现同名任务'} eyebrow="任务提醒" onClose={onClose}><div className="duplicate-task-message"><strong>{candidate.recurringExists ? `“${candidate.existing.title}”已经是长期任务` : `“${candidate.existing.title}”已经存在`}</strong><span>{candidate.recurringExists ? '同一项目下的长期任务无需重复创建。' : '同一项目下已有同名的一次性任务。可以将它设为长期任务，或忽略提醒并创建一次性任务。'}</span></div>{!candidate.recurringExists && <div className="duplicate-actions"><button className="primary-button" onClick={onMakeRecurring}>将已有任务设为长期任务</button><button className="text-button" onClick={onCreateAnyway}>忽略并创建一次性任务</button></div>}<div className="modal-actions"><button className="secondary-button" onClick={onClose}>关闭</button></div></Modal> }
function ProjectModal({ project, onClose, onCreate }: { project?: Project; onClose: () => void; onCreate: (draft: ProjectDraft) => void }) { const [name, setName] = useState(project?.name ?? ''); const [color, setColor] = useState(project?.color ?? colors[0]); return <Modal title={project ? '编辑项目' : '新建项目'} eyebrow="项目" onClose={onClose}><label className="form-label">项目名称<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：科研与论文" /></label><div className="form-label">项目颜色<div className="color-picker">{colors.map((item) => <button type="button" key={item} style={{ background: item }} className={color === item ? 'selected' : ''} aria-label={`选择项目颜色 ${item}`} onClick={() => setColor(item)}>{color === item && <span className="color-check" aria-hidden="true"><svg viewBox="0 0 16 16" focusable="false"><path d="m3.25 8.25 3.1 3.1 6.4-6.7" /></svg></span>}</button>)}</div></div><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!name.trim()} onClick={() => onCreate({ id: project?.id, name: name.trim(), color })}>{project ? '保存修改' : <><Plus size={14} />创建项目</>}</button></div></Modal> }
function Modal({ title, eyebrow, onClose, children }: { title: string; eyebrow: string; onClose: () => void; children: React.ReactNode }) { const isCreationPrompt = title === '加入今天的任务？'; return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !isCreationPrompt && onClose()}><div className="modal"><div className="modal-header"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2></div><button className="icon-button" onClick={onClose}><X size={17} /></button></div>{children}</div></div> }
function phaseDuration(phase: PomodoroPhase, settings: ChronoState['settings']) { return (phase === 'focus' ? settings.focusMinutes : phase === 'short_break' ? settings.shortBreakMinutes : settings.longBreakMinutes) * 60000 }
function formatDate(date: Date) { return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }
function formatTime(date: Date) { return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
