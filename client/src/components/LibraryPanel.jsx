import React, { useState } from 'react';
import { api } from '../api.js';
import Media from './Media.jsx';

// Library: references + asset browser + generation history.
export default function LibraryPanel({ state, onAction }) {
  const [sub, setSub] = useState('assets');
  return (
    <div className="library">
      <div className="sub-tabs">
        {[['assets', 'Assets'], ['refs', 'References'], ['history', 'History']].map(([k, label]) => (
          <button key={k} className={sub === k ? 'on' : ''} onClick={() => setSub(k)}>{label}</button>
        ))}
      </div>
      {sub === 'assets' && <AssetBrowser state={state} />}
      {sub === 'refs' && <RefLibrary state={state} onAction={onAction} />}
      {sub === 'history' && <History state={state} />}
    </div>
  );
}

function AssetBrowser({ state }) {
  const [filter, setFilter] = useState('all');
  const assets = state.assets.filter((a) => filter === 'all' || a.type === filter);
  return (
    <div>
      <div className="asset-filter">
        {['all', 'image', 'video'].map((f) => (
          <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <span className="count">{assets.length} assets</span>
      </div>
      <div className="asset-grid">
        {assets.map((a) => {
          const meta = JSON.parse(a.meta || '{}');
          return (
            <div key={a.id} className="asset-card">
              <div className="asset-media">
                <Media path={a.path} video={a.type === 'video'} alt={meta.label || a.path} />
              </div>
              <div className="asset-meta">
                <div className="asset-label">{meta.label || a.path}</div>
                <div className="asset-sub">{a.type} · shot {a.shot_id} · {meta.provider}</div>
                <div className="asset-sub">{a.created_at}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RefLibrary({ state, onAction }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('note');
  const [content, setContent] = useState('');
  const add = () => onAction(async () => {
    if (!name.trim()) return;
    await api.post(`/api/projects/${state.project.id}/refs`, { name: name.trim(), kind, content });
    setName(''); setContent('');
  });
  return (
    <div>
      <div className="ref-form">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Reference name…" />
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="note">note</option>
          <option value="link">link</option>
          <option value="file">file (text)</option>
        </select>
        <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder={kind === 'link' ? 'https://…' : 'content…'} rows={2} />
        <button className="btn primary" onClick={add}>+ Add reference</button>
      </div>
      <div className="ref-list">
        {state.refs.map((r) => (
          <div key={r.id} className="ref-row">
            <span className={`tag kind-${r.kind}`}>{r.kind}</span>
            <span className="ref-name">{r.name}</span>
            {r.kind === 'link'
              ? <a href={r.content} target="_blank" rel="noreferrer" className="ref-content">{r.content}</a>
              : <span className="ref-content">{r.path ? `/media/${r.path}` : r.content.slice(0, 120)}</span>}
            <button className="btn small danger" onClick={() => onAction(() => api.del(`/api/refs/${r.id}`))}>✕</button>
          </div>
        ))}
        {state.refs.length === 0 && <div className="queue-empty">No references yet.</div>}
      </div>
    </div>
  );
}

function History({ state }) {
  const [history, setHistory] = useState([]);
  React.useEffect(() => {
    api.get(`/api/history?project_id=${state.project.id}`).then((d) => setHistory(d.history));
  }, [state.project.id, state.project.updated_at]);
  return (
    <div className="history-list">
      {history.map((h) => (
        <div key={h.id} className="history-row">
          <span className="history-time">{h.created_at}</span>
          {h.kind && <span className="tag">{h.kind}</span>}
          {h.cost > 0 && <span className="job-cost">${h.cost.toFixed(3)}</span>}
          <span>{h.detail}</span>
        </div>
      ))}
      {history.length === 0 && <div className="queue-empty">Nothing yet.</div>}
    </div>
  );
}
