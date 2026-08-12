import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.js';
import Storyboard from './components/Storyboard.jsx';
import ReviewPanel from './components/ReviewPanel.jsx';
import QueuePanel from './components/QueuePanel.jsx';
import LibraryPanel from './components/LibraryPanel.jsx';

export default function App() {
  const [projects, setProjects] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [state, setState] = useState(null);
  const [control, setControl] = useState({ globalStop: false, automationPaused: false });
  const [tab, setTab] = useState('storyboard');
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  const refreshProjects = useCallback(async () => {
    try {
      const d = await api.get('/api/projects');
      setProjects(d.projects);
      if (!activeId && d.activeProjectId) setActiveId(d.activeProjectId);
      if (d.activeProjectId) setActiveId((cur) => cur || d.activeProjectId);
    } catch (e) { setError(e.message); }
  }, [activeId]);

  const refreshState = useCallback(async () => {
    if (!activeId) return;
    try {
      const [s, c] = await Promise.all([
        api.get(`/api/projects/${activeId}/state`),
        api.get('/api/control'),
      ]);
      setState(s);
      setControl(c);
    } catch (e) { setError(e.message); }
  }, [activeId]);

  useEffect(() => { refreshProjects(); }, []);
  useEffect(() => {
    refreshState();
    const t = setInterval(refreshState, 1000);
    return () => clearInterval(t);
  }, [refreshState]);

  const act = async (fn) => {
    setError('');
    try { await fn(); await refreshState(); await refreshProjects(); }
    catch (e) { setError(e.message); }
  };

  const createProject = () => act(async () => {
    if (!newName.trim()) return;
    const d = await api.post('/api/projects', { name: newName.trim() });
    setNewName('');
    setActiveId(d.project.id);
  });

  const openProject = (id) => act(async () => {
    await api.post(`/api/projects/${id}/open`);
    setActiveId(id);
  });

  const project = state?.project;
  const pendingApproval = state?.approvals?.find((a) => a.status === 'pending' || a.status === 'paused');

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◉</span> Hermes Video Studio
        </div>
        <div className="sidebar-section">
          <div className="sidebar-title">Projects</div>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`project-item ${p.id === activeId ? 'active' : ''}`}
              onClick={() => openProject(p.id)}
            >
              <span className="project-name">{p.name}</span>
              <span className={`badge mode-${p.mode.toLowerCase()}`}>{p.mode}</span>
              <span className="project-meta">{p.shots_complete}/{p.shot_count} shots</span>
            </button>
          ))}
          <div className="new-project">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New project name…"
              onKeyDown={(e) => e.key === 'Enter' && createProject()}
            />
            <button className="btn primary" onClick={createProject}>+ Create</button>
          </div>
        </div>
        <div className="sidebar-section control-box">
          <div className="sidebar-title">Master Control</div>
          <div className="control-row">
            <span>Automation</span>
            {control.automationPaused
              ? <button className="btn warn" onClick={() => act(() => api.post('/api/control/unpause'))}>▶ Resume</button>
              : <button className="btn" onClick={() => act(() => api.post('/api/control/pause'))}>⏸ Pause</button>}
          </div>
          <div className="control-row">
            <span>Global STOP</span>
            {control.globalStop
              ? <button className="btn danger active" onClick={() => act(() => api.post('/api/control/resume'))}>■ STOPPED — reset</button>
              : <button className="btn danger" onClick={() => act(() => api.post('/api/control/stop'))}>■ STOP</button>}
          </div>
        </div>
      </aside>

      <main className="main">
        {error && <div className="error-bar" onClick={() => setError('')}>{error} ✕</div>}
        {!project && (
          <div className="empty-state">
            <h1>Welcome to the studio</h1>
            <p>Create a project on the left to start producing.</p>
          </div>
        )}
        {project && (
          <>
            <header className="project-header">
              <div className="ph-left">
                <h1>{project.name}</h1>
                <span className="stage-pill">{project.stage}</span>
              </div>
              <div className="ph-right">
                <div className="mode-switch" title="AUTO: unattended approvals · MANUAL: pause on every review">
                  <button
                    className={project.mode === 'AUTO' ? 'on' : ''}
                    onClick={() => act(() => api.patch(`/api/projects/${project.id}`, { mode: 'AUTO' }))}
                  >AUTO</button>
                  <button
                    className={project.mode === 'MANUAL' ? 'on' : ''}
                    onClick={() => act(() => api.patch(`/api/projects/${project.id}`, { mode: 'MANUAL' }))}
                  >MANUAL</button>
                </div>
                <BudgetMeter project={project} />
                <label className="countdown-cfg">
                  countdown
                  <input
                    type="number" min="1" max="60" defaultValue={project.countdown_seconds}
                    onBlur={(e) => act(() => api.patch(`/api/projects/${project.id}`, { countdown_seconds: Number(e.target.value) || 5 }))}
                  />s
                </label>
                <button className="btn primary" onClick={() => act(() => api.post(`/api/projects/${project.id}/start`))}>
                  ▶ Start production
                </button>
              </div>
            </header>

            {pendingApproval && (
              <ReviewPanel
                approval={pendingApproval}
                state={state}
                onAction={(fn) => act(fn)}
              />
            )}

            <nav className="tabs">
              {['storyboard', 'queue', 'library'].map((t) => (
                <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
                  {t === 'storyboard' ? '🎬 Storyboard' : t === 'queue' ? '⚙ Queue' : '🗂 Library'}
                </button>
              ))}
            </nav>

            {tab === 'storyboard' && <Storyboard state={state} onAction={act} />}
            {tab === 'queue' && <QueuePanel state={state} onAction={act} />}
            {tab === 'library' && <LibraryPanel state={state} onAction={act} />}
          </>
        )}
      </main>
    </div>
  );
}

function BudgetMeter({ project }) {
  const pct = project.budget_hard > 0 ? Math.min(100, (project.spend / project.budget_hard) * 100) : 0;
  const softHit = project.spend >= project.budget_soft;
  const hardHit = project.spend >= project.budget_hard;
  return (
    <div className={`budget ${hardHit ? 'hard' : softHit ? 'soft' : ''}`} title={`soft $${project.budget_soft} · hard $${project.budget_hard}`}>
      <div className="budget-label">${project.spend.toFixed(2)} / ${project.budget_hard.toFixed(2)}</div>
      <div className="budget-bar"><div style={{ width: `${pct}%` }} /></div>
    </div>
  );
}
