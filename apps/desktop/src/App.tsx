import { useEffect, useMemo, useState } from 'react'
import {
  Archive,
  ArrowUpRight,
  BarChart3,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Command,
  Download,
  FolderOpen,
  LayoutDashboard,
  Menu,
  Moon,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Tags,
  TimerReset,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { formatDuration } from '@tempo/domain'
import { id, loadStore, saveStore, type StoreState, type TempoEvent, type TempoSession } from './types'

type View = 'dashboard' | 'events' | 'calendar' | 'settings'

const navItems: Array<{ id: View; label: string; icon: typeof LayoutDashboard }> = [
  { id: 'dashboard', label: '概览', icon: LayoutDashboard },
  { id: 'events', label: '事件', icon: Clock3 },
  { id: 'calendar', label: '日历', icon: CalendarDays },
]

const categories = ['全部', '工作', '成长', '生活']

function App() {
  const [store, setStore] = useState<StoreState>(loadStore)
  const [view, setView] = useState<View>('dashboard')
  const [selectedEventId, setSelectedEventId] = useState<string | null>('deep-work')
  const [showCreate, setShowCreate] = useState(false)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('全部')
  const [now, setNow] = useState(Date.now())

  useEffect(() => saveStore(store), [store])
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = store.theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : store.theme
  }, [store.theme])

  const runningSessions = store.sessions.filter((session) => session.status === 'running')
  const selectedEvent = store.events.find((event) => event.id === selectedEventId) ?? store.events[0]
  const filteredEvents = useMemo(() => store.events.filter((event) => event.status === 'active' && (category === '全部' || event.category === category) && event.title.toLowerCase().includes(search.toLowerCase())), [store.events, category, search])
  const todayMs = useMemo(() => {
    const start = new Date(); start.setHours(0, 0, 0, 0)
    return store.sessions.reduce((sum, session) => {
      const sessionStart = new Date(session.startedAt).getTime()
      if (sessionStart < start.getTime()) return sum
      return sum + getSessionElapsed(session, now)
    }, 0)
  }, [store.sessions, now])

  function updateState(updater: (current: StoreState) => StoreState) { setStore((current) => updater(current)) }

  function startTimer(eventId: string) {
    if (!eventId || !store.events.some((event) => event.id === eventId)) return
    const existingRunning = store.sessions.filter((session) => session.status === 'running')
    if (existingRunning.length > 0 && !store.allowParallel) {
      updateState((current) => ({ ...current, sessions: current.sessions.map((session) => session.status === 'running' ? { ...session, status: 'paused', pausedAt: new Date().toISOString(), elapsedMs: getSessionElapsed(session, now) } : session) }))
    }
    const current = new Date().toISOString()
    const session: TempoSession = { id: id('session'), eventId, startedAt: current, elapsedMs: 0, status: 'running' }
    updateState((state) => ({ ...state, sessions: [...state.sessions, session], events: state.events.map((event) => event.id === eventId ? { ...event, lastSessionAt: current, updatedAt: current } : event) }))
    setSelectedEventId(eventId)
  }

  function pauseTimer(sessionId: string) {
    updateState((state) => ({ ...state, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, status: 'paused', pausedAt: new Date().toISOString(), elapsedMs: getSessionElapsed(session, now) } : session) }))
  }

  function resumeTimer(sessionId: string) {
    updateState((state) => ({ ...state, sessions: state.sessions.map((session) => session.id === sessionId ? { ...session, status: 'running', pausedAt: undefined, startedAt: new Date(now - session.elapsedMs).toISOString() } : session) }))
  }

  function completeTimer(sessionId: string) {
    updateState((state) => {
      const session = state.sessions.find((item) => item.id === sessionId)
      if (!session) return state
      const elapsedMs = getSessionElapsed(session, now)
      return { ...state, sessions: state.sessions.map((item) => item.id === sessionId ? { ...item, status: 'completed', endedAt: new Date().toISOString(), elapsedMs } : item), events: state.events.map((event) => event.id === session.eventId ? { ...event, totalMs: event.totalMs + elapsedMs, updatedAt: new Date().toISOString() } : event) }
    })
  }

  function createEvent(title: string, description: string, categoryName: string, color: string) {
    const event: TempoEvent = { id: id('event'), title, description, category: categoryName, color, status: 'active', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), totalMs: 0 }
    updateState((state) => ({ ...state, events: [event, ...state.events] }))
    setSelectedEventId(event.id)
    setShowCreate(false)
    setView('events')
  }

  function deleteEvent(eventId: string) {
    updateState((state) => ({ ...state, events: state.events.filter((event) => event.id !== eventId), sessions: state.sessions.filter((session) => session.eventId !== eventId) }))
    setSelectedEventId(null)
  }

  function exportData() {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `tempo-export-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href)
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Sparkles size={16} strokeWidth={2.4} /></div><span>tempo</span></div>
        <div className="workspace-switcher"><div className="avatar">林</div><div><strong>我的空间</strong><span>个人工作区</span></div><ChevronRight size={15} className="muted-icon" /></div>
        <div className="nav-group">
          <div className="nav-caption">工作台</div>
          {navItems.map(({ id: itemId, label, icon: Icon }) => <button key={itemId} className={`nav-item ${view === itemId ? 'selected' : ''}`} onClick={() => setView(itemId)}><Icon size={17} /><span>{label}</span>{itemId === 'events' && <span className="nav-count">{store.events.length}</span>}</button>)}
        </div>
        <div className="nav-group nav-group-secondary">
          <div className="nav-caption">收藏</div>
          {store.events.slice(0, 3).map((event) => <button key={event.id} className="nav-item compact" onClick={() => { setView('events'); setSelectedEventId(event.id) }}><span className="dot" style={{ background: event.color }} /><span>{event.title}</span></button>)}
          <button className="nav-item compact muted"><Plus size={15} /><span>添加收藏</span></button>
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => setView('settings')}><Settings size={17} /><span>设置</span></button>
          <div className="sync-mini"><span className="sync-dot" />本地已保存<span className="sync-time">刚刚</span></div>
          <div className="profile-row"><div className="avatar small">林</div><div><strong>林默</strong><span>离线模式</span></div><MoreHorizontal size={16} className="muted-icon" /></div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar"><div className="breadcrumbs"><span>我的空间</span><ChevronRight size={14} /><strong>{view === 'dashboard' ? '概览' : view === 'events' ? '事件' : view === 'calendar' ? '日历' : '设置'}</strong></div><div className="top-actions"><button className="icon-button search-button" title="搜索"><Search size={17} /><span>搜索</span><kbd>⌘ K</kbd></button><button className="icon-button" title="通知"><Bell size={17} /></button><button className="icon-button" title="帮助"><CircleHelp size={17} /></button></div></header>
        {view === 'dashboard' && <Dashboard events={store.events} sessions={store.sessions} now={now} todayMs={todayMs} onStart={startTimer} onPause={pauseTimer} onComplete={completeTimer} onSelect={(id) => { setSelectedEventId(id); setView('events') }} />}
        {view === 'events' && <EventsView events={filteredEvents} allEvents={store.events} selectedEvent={selectedEvent} sessions={store.sessions} now={now} search={search} category={category} onSearch={setSearch} onCategory={setCategory} onStart={startTimer} onPause={pauseTimer} onResume={resumeTimer} onComplete={completeTimer} onSelect={setSelectedEventId} onCreate={() => setShowCreate(true)} onDelete={deleteEvent} />}
        {view === 'calendar' && <CalendarView events={store.events} sessions={store.sessions} now={now} />}
        {view === 'settings' && <SettingsView store={store} onToggleParallel={() => updateState((state) => ({ ...state, allowParallel: !state.allowParallel }))} onTheme={(theme) => updateState((state) => ({ ...state, theme }))} onExport={exportData} />}
      </main>
      {showCreate && <CreateEventModal onClose={() => setShowCreate(false)} onCreate={createEvent} />}
    </div>
  )
}

function Dashboard({ events, sessions, now, todayMs, onStart, onPause, onComplete, onSelect }: { events: TempoEvent[]; sessions: TempoSession[]; now: number; todayMs: number; onStart: (id: string) => void; onPause: (id: string) => void; onComplete: (id: string) => void; onSelect: (id: string) => void }) {
  const running = sessions.filter((session) => session.status === 'running')
  const total = events.reduce((sum, event) => sum + event.totalMs, 0)
  const greeting = new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好'
  return <div className="page dashboard-page">
    <div className="page-heading"><div><div className="eyebrow">{formatDate(new Date())}</div><h1>{greeting}，林默</h1><p>今天也留一点专注的时间给自己。</p></div><button className="primary-button" disabled={!events.length} onClick={() => onStart(events[0]?.id)}><Play size={16} fill="currentColor" />开始计时</button></div>
    <section className="metric-grid"><Metric label="今日专注" value={formatDuration(todayMs)} hint="比昨天多 18 分钟" icon={Clock3} tone="blue" /><Metric label="累计记录" value={formatDuration(total)} hint={`${events.length} 个事件`} icon={BarChart3} tone="green" /><Metric label="连续记录" value="6 天" hint="继续保持节奏" icon={Sparkles} tone="orange" /></section>
    <section className="dashboard-grid"><div className="section-block active-block"><div className="section-title"><div><h2>正在进行</h2><span>{running.length ? `${running.length} 个计时中` : '此刻还没有计时'}</span></div><button className="text-button" onClick={() => onSelect(events[0]?.id)}>查看全部 <ArrowUpRight size={14} /></button></div>{running.length ? running.map((session) => <RunningCard key={session.id} session={session} event={events.find((event) => event.id === session.eventId)} now={now} onPause={onPause} onComplete={onComplete} />) : <EmptyRunning onStart={() => onStart(events[0]?.id)} />}</div><div className="section-block"><div className="section-title"><div><h2>最近事件</h2><span>按最近使用排序</span></div><button className="text-button" onClick={() => onSelect(events[0]?.id)}>全部事件 <ArrowUpRight size={14} /></button></div><div className="recent-list">{events.slice(0, 4).map((event) => <EventRow key={event.id} event={event} onStart={onStart} onSelect={onSelect} />)}</div></div></section>
    <section className="section-block timeline-block"><div className="section-title"><div><h2>今日时间线</h2><span>按本地时间显示</span></div><button className="icon-button"><MoreHorizontal size={17} /></button></div><Timeline events={events} sessions={sessions} /></section>
  </div>
}

function EventsView({ events, allEvents, selectedEvent, sessions, now, search, category, onSearch, onCategory, onStart, onPause, onResume, onComplete, onSelect, onCreate, onDelete }: { events: TempoEvent[]; allEvents: TempoEvent[]; selectedEvent?: TempoEvent; sessions: TempoSession[]; now: number; search: string; category: string; onSearch: (value: string) => void; onCategory: (value: string) => void; onStart: (id: string) => void; onPause: (id: string) => void; onResume: (id: string) => void; onComplete: (id: string) => void; onSelect: (id: string) => void; onCreate: () => void; onDelete: (id: string) => void }) {
  const eventSessions = sessions.filter((session) => session.eventId === selectedEvent?.id).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const currentSession = eventSessions.find((session) => session.status === 'running' || session.status === 'paused')
  return <div className="page events-page"><div className="page-heading compact-heading"><div><div className="eyebrow">工作台 / 事件</div><h1>事件</h1><p>把时间交给真正重要的事情。</p></div><button className="primary-button" onClick={onCreate}><Plus size={16} />新建事件</button></div><div className="events-layout"><section className="event-list-panel"><div className="event-toolbar"><div className="search-input"><Search size={16} /><input placeholder="搜索事件" value={search} onChange={(event) => onSearch(event.target.value)} />{search && <button onClick={() => onSearch('')}><X size={14} /></button>}</div><div className="category-tabs">{categories.map((item) => <button key={item} className={category === item ? 'active' : ''} onClick={() => onCategory(item)}>{item}</button>)}</div><button className="icon-button"><SlidersHorizontal size={16} /></button></div><div className="list-caption"><span>{events.length} 个事件</span><span>最近使用 <ChevronRight size={13} /></span></div><div className="event-list">{events.length ? events.map((event) => <EventRow key={event.id} event={event} selected={event.id === selectedEvent?.id} onStart={onStart} onSelect={onSelect} />) : <div className="empty-list"><Search size={24} /><strong>没有找到匹配的事件</strong><span>尝试换一个关键词或分类</span></div>}</div></section><aside className="event-detail"><div className="detail-header"><span className="detail-label">事件详情</span><button className="icon-button"><MoreHorizontal size={17} /></button></div>{selectedEvent ? <><div className="detail-hero"><div className="event-symbol" style={{ background: selectedEvent.color }}><Clock3 size={25} /></div><div><h2>{selectedEvent.title}</h2><span className="detail-category"><span className="dot" style={{ background: selectedEvent.color }} />{selectedEvent.category}</span></div></div><p className="detail-description">{selectedEvent.description || '还没有添加描述。'}</p><div className="detail-stats"><div><span>累计时间</span><strong>{formatDuration(selectedEvent.totalMs + (currentSession ? getSessionElapsed(currentSession, now) : 0))}</strong></div><div><span>记录次数</span><strong>{eventSessions.filter((session) => session.status === 'completed').length}</strong></div></div>{currentSession ? <div className="detail-running"><div><span className="live-indicator" />{currentSession.status === 'running' ? '正在计时' : '已暂停'}</div><strong>{formatDuration(getSessionElapsed(currentSession, now))}</strong><div className="detail-actions">{currentSession.status === 'running' ? <button className="secondary-button" onClick={() => onPause(currentSession.id)}><Pause size={15} />暂停</button> : <button className="secondary-button" onClick={() => onResume(currentSession.id)}><Play size={15} fill="currentColor" />继续</button>}<button className="complete-button" onClick={() => onComplete(currentSession.id)}><Check size={15} />完成</button></div></div> : <button className="wide-start" onClick={() => onStart(selectedEvent.id)}><Play size={16} fill="currentColor" />开始计时</button>}<div className="detail-section"><div className="section-title small"><div><h3>最近记录</h3><span>共 {eventSessions.length} 条</span></div><button className="icon-button"><MoreHorizontal size={16} /></button></div>{eventSessions.slice(0, 5).map((session) => <SessionRow key={session.id} session={session} now={now} />)}{!eventSessions.length && <div className="subtle-empty">完成一次计时后，记录会显示在这里。</div>}</div><button className="danger-button" onClick={() => onDelete(selectedEvent.id)}><Trash2 size={15} />删除事件</button></> : <div className="detail-empty"><FolderOpen size={28} /><span>选择一个事件查看详情</span></div>}</aside></div></div>
}

function CalendarView({ events, sessions, now }: { events: TempoEvent[]; sessions: TempoSession[]; now: number }) {
  const today = new Date(); const dates = Array.from({ length: 7 }, (_, index) => { const date = new Date(today); date.setDate(today.getDate() - 3 + index); return date })
  return <div className="page calendar-page"><div className="page-heading compact-heading"><div><div className="eyebrow">工作台 / 日历</div><h1>日历</h1><p>从时间的分布里，看见自己的节奏。</p></div><button className="secondary-button"><Download size={15} />导出数据</button></div><div className="calendar-toolbar"><button className="icon-button"><ChevronRight size={16} className="rotate-180" /></button><strong>{today.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })}</strong><button className="icon-button"><ChevronRight size={16} /></button><button className="today-button">今天</button><div className="view-switch"><button className="active">周</button><button>月</button></div></div><div className="calendar-strip">{dates.map((date) => <div key={date.toISOString()} className={`date-cell ${date.toDateString() === today.toDateString() ? 'today' : ''}`}><span>{date.toLocaleDateString('zh-CN', { weekday: 'short' })}</span><strong>{date.getDate()}</strong><div className="date-bar" style={{ width: `${Math.min(88, Math.max(12, ((date.getDate() * 17) % 78) + 10))}%` }} /></div>)}</div><div className="calendar-body"><div className="calendar-summary"><div className="summary-card"><span>本周专注</span><strong>12<span>h</span> 48<span>m</span></strong><small>比上周多 8%</small></div><div className="summary-card"><span>完成事件</span><strong>18</strong><small>平均每天 2.6 个</small></div><div className="summary-card"><span>最常用分类</span><strong className="summary-category"><span className="dot" style={{ background: '#86a9ff' }} />工作</strong><small>占本周 64%</small></div></div><div className="day-timeline"><div className="section-title"><div><h2>今天</h2><span>{formatDate(today)} · {Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div><button className="text-button">查看统计 <ArrowUpRight size={14} /></button></div><Timeline events={events} sessions={sessions} /></div></div></div>
}

function SettingsView({ store, onToggleParallel, onTheme, onExport }: { store: StoreState; onToggleParallel: () => void; onTheme: (theme: StoreState['theme']) => void; onExport: () => void }) {
  return <div className="page settings-page"><div className="page-heading compact-heading"><div><div className="eyebrow">我的空间 / 设置</div><h1>设置</h1><p>让 Tempo 更贴合你的工作方式。</p></div></div><div className="settings-layout"><nav className="settings-nav"><button className="active"><SlidersHorizontal size={16} />偏好设置</button><button><UserRound size={16} />账号与安全</button><button><Bell size={16} />通知</button><button><Download size={16} />数据与同步</button></nav><section className="settings-content"><SettingsSection title="外观" description="调整界面的明暗和显示方式"><div className="setting-row"><div className="setting-icon"><Sun size={17} /></div><div className="setting-copy"><strong>主题</strong><span>跟随系统或选择固定主题</span></div><div className="segmented-control">{(['light', 'dark', 'system'] as const).map((theme) => <button key={theme} className={store.theme === theme ? 'active' : ''} onClick={() => onTheme(theme)}>{theme === 'light' ? '浅色' : theme === 'dark' ? '深色' : '跟随系统'}</button>)}</div></div></SettingsSection><SettingsSection title="计时" description="决定事件如何在后台运行"><div className="setting-row"><div className="setting-icon"><TimerReset size={17} /></div><div className="setting-copy"><strong>允许并行计时</strong><span>开启后可以同时运行多个事件</span></div><button className={`toggle ${store.allowParallel ? 'on' : ''}`} onClick={onToggleParallel} aria-label="允许并行计时"><span /></button></div><div className="setting-row"><div className="setting-icon"><Command size={17} /></div><div className="setting-copy"><strong>全局快捷键</strong><span>快速开始或暂停当前事件</span></div><kbd>⌘ ⇧ T</kbd></div></SettingsSection><SettingsSection title="账户" description="当前使用本地工作区，登录后可跨设备同步"><div className="account-card"><div className="avatar">林</div><div><strong>林默</strong><span>本地模式 · 尚未连接云端</span></div><button className="secondary-button">连接账号 <ArrowUpRight size={14} /></button></div></SettingsSection><SettingsSection title="数据" description="导出一份完整的本地数据备份"><div className="setting-row"><div className="setting-icon"><Download size={17} /></div><div className="setting-copy"><strong>导出数据</strong><span>JSON 格式，包含事件和所有计时记录</span></div><button className="secondary-button" onClick={onExport}>导出 <Download size={14} /></button></div></SettingsSection></section></div></div>
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) { return <section className="settings-section"><div className="settings-section-heading"><h2>{title}</h2><span>{description}</span></div>{children}</section> }
function Metric({ label, value, hint, icon: Icon, tone }: { label: string; value: string; hint: string; icon: typeof Clock3; tone: string }) { return <div className="metric"><div className={`metric-icon ${tone}`}><Icon size={17} /></div><div><span>{label}</span><strong>{value}</strong><small>{hint}</small></div></div> }
function RunningCard({ session, event, now, onPause, onComplete }: { session: TempoSession; event?: TempoEvent; now: number; onPause: (id: string) => void; onComplete: (id: string) => void }) { if (!event) return null; return <div className="running-card"><div className="event-symbol small" style={{ background: event.color }}><Clock3 size={17} /></div><div className="running-copy"><strong>{event.title}</strong><span>{event.category} · 开始于 {formatTime(new Date(session.startedAt))}</span></div><strong className="running-duration">{formatDuration(getSessionElapsed(session, now))}</strong><button className="round-action" onClick={() => onPause(session.id)} title="暂停"><Pause size={15} fill="currentColor" /></button><button className="complete-icon" onClick={() => onComplete(session.id)} title="完成"><Check size={16} /></button></div> }
function EmptyRunning({ onStart }: { onStart: () => void }) { return <div className="empty-running"><div className="empty-icon"><Clock3 size={23} /></div><div><strong>准备好开始了吗？</strong><span>选择一个事件，给它一段完整的注意力。</span></div><button className="secondary-button" onClick={onStart}><Play size={14} fill="currentColor" />开始</button></div> }
function EventRow({ event, selected, onStart, onSelect }: { event: TempoEvent; selected?: boolean; onStart: (id: string) => void; onSelect: (id: string) => void }) { return <div className={`event-row ${selected ? 'selected' : ''}`} onClick={() => onSelect(event.id)}><div className="event-symbol tiny" style={{ background: event.color }}><Clock3 size={14} /></div><div className="event-row-copy"><strong>{event.title}</strong><span>{event.category} · {formatDuration(event.totalMs)}</span></div><span className="event-last">{event.lastSessionAt ? formatRelative(event.lastSessionAt) : '尚未记录'}</span><button className="row-play" onClick={(click) => { click.stopPropagation(); onStart(event.id) }} title="开始计时"><Play size={14} fill="currentColor" /></button></div> }
function SessionRow({ session, now }: { session: TempoSession; now: number }) { return <div className="session-row"><span className={`session-status ${session.status}`} /> <div><strong>{formatDate(new Date(session.startedAt))}</strong><span>{formatTime(new Date(session.startedAt))} {session.endedAt ? `— ${formatTime(new Date(session.endedAt))}` : '— 进行中'}</span></div><strong>{formatDuration(getSessionElapsed(session, now))}</strong></div> }
function Timeline({ events, sessions, now = Date.now() }: { events: TempoEvent[]; sessions: TempoSession[]; now?: number }) { const items = sessions.length ? sessions.slice(-4) : events.slice(0, 3).map((event, index) => ({ id: `sample-${index}`, eventId: event.id, startedAt: new Date(Date.now() - (index + 1) * 3600000).toISOString(), elapsedMs: Math.max(1800000, event.totalMs / 4), status: 'completed' as const })) ; return <div className="timeline"><div className="time-axis"><span>08:00</span><span>12:00</span><span>16:00</span><span>20:00</span></div><div className="timeline-track">{items.map((session, index) => { const event = events.find((item) => item.id === session.eventId); if (!event) return null; const left = 8 + index * 22; const width = Math.min(34, Math.max(10, getSessionElapsed(session, now) / 180000)); return <div key={session.id} className="timeline-item" style={{ left: `${left}%`, width: `${width}%`, background: event.color }} title={`${event.title} · ${formatDuration(getSessionElapsed(session, now))}`}><span>{event.title}</span></div> })}</div></div> }
function CreateEventModal({ onClose, onCreate }: { onClose: () => void; onCreate: (title: string, description: string, category: string, color: string) => void }) { const [title, setTitle] = useState(''); const [description, setDescription] = useState(''); const [category, setCategory] = useState('工作'); const [color, setColor] = useState('#86a9ff'); return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="modal"><div className="modal-header"><div><span className="eyebrow">新建</span><h2>创建一个事件</h2></div><button className="icon-button" onClick={onClose}><X size={18} /></button></div><label>名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：写作、健身、阅读" /></label><label>描述 <span className="optional">可选</span><textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="给这段时间一个清晰的意图" rows={3} /></label><label>分类<div className="form-options">{categories.slice(1).map((item) => <button type="button" key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div></label><label>颜色<div className="color-options">{['#86a9ff', '#8fceb7', '#efb477', '#b59bdc', '#e69a9a'].map((item) => <button type="button" key={item} className={color === item ? 'selected' : ''} style={{ background: item }} onClick={() => setColor(item)}>{color === item && <Check size={14} />}</button>)}</div></label><div className="modal-actions"><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={!title.trim()} onClick={() => onCreate(title.trim(), description.trim(), category, color)}><Plus size={16} />创建事件</button></div></div></div> }

function getSessionElapsed(session: TempoSession, now: number) { return session.status === 'running' ? Math.max(session.elapsedMs, now - new Date(session.startedAt).getTime()) : session.elapsedMs }
function formatDate(date: Date) { return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }) }
function formatTime(date: Date) { return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }
function formatRelative(iso: string) { const diff = Date.now() - new Date(iso).getTime(); if (diff < 86400000) return '今天'; if (diff < 172800000) return '昨天'; return `${Math.floor(diff / 86400000)} 天前` }

export default App
