import React, { useState } from 'react';
import { api } from '../api.js';
import Media from './Media.jsx';

// Visual storyboard / timeline: shot cards with thumbnails + playable mock videos.
export default function Storyboard({ state, onAction }) {
  const { project, shots, candidates } = state;
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [dur, setDur] = useState(4);

  const addShot = () => onAction(async () => {
    if (!title.trim()) return;
    await api.post(`/api/projects/${project.id}/shots`, { title: title.trim(), description: desc, duration_seconds: dur });
    setTitle(''); setDesc('');
  });

  const move = (idx, dir) => onAction(async () => {
    const ids = shots.map((s) => s.id);
    const j = idx + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[idx], ids[j]] = [ids[j], ids[idx]];
    await api.post(`/api/projects/${project.id}/shots/reorder`, { shotIds: ids });
  });

  const approvedAsset = (shot, kind) => {
    const id = kind === 'image' ? shot.approved_image_asset_id : shot.approved_video_asset_id;
    if (!id) return null;
    const cand = candidates.find((c) => c.asset_id === id);
    return cand?.asset_path || null;
  };

  return (
    <div className="storyboard">
      <div className="shot-strip">
        {shots.map((shot, i) => {
          const img = approvedAsset(shot, 'image');
          const vid = approvedAsset(shot, 'video');
          const reviewCands = candidates.filter((c) => c.shot_id === shot.id && c.status === 'pending');
          return (
            <div key={shot.id} className={`shot-card status-${shot.status}`}>
              <div className="shot-num">#{shot.ord}</div>
              <div className="shot-thumb">
                {vid
                  ? <Media path={vid} video alt={shot.title} />
                  : img
                    ? <Media path={img} alt={shot.title} />
                    : reviewCands.length
                      ? <Media path={reviewCands[0].asset_path} video={reviewCands[0].kind === 'video'} alt={shot.title} className="dim" />
                      : <div className="thumb-placeholder">{statusIcon(shot.status)}</div>}
              </div>
              <div className="shot-body">
                <EditableText value={shot.title} onSave={(v) => onAction(() => api.patch(`/api/shots/${shot.id}`, { title: v }))} className="shot-title" />
                <EditableText value={shot.description} placeholder="description…" onSave={(v) => onAction(() => api.patch(`/api/shots/${shot.id}`, { description: v }))} className="shot-desc" />
                <div className="shot-meta">
                  <span>{shot.duration_seconds}s</span>
                  <span className={`status-pill st-${shot.status}`}>{shot.status.replace('_', ' ')}</span>
                </div>
              </div>
              <div className="shot-actions">
                <button title="move up" onClick={() => move(i, -1)}>↑</button>
                <button title="move down" onClick={() => move(i, 1)}>↓</button>
                {(shot.status === 'draft' || shot.status === 'failed') &&
                  <button title="start shot" onClick={() => onAction(() => api.post(`/api/shots/${shot.id}/start`))}>▶</button>}
                <button title="delete" onClick={() => onAction(() => api.del(`/api/shots/${shot.id}`))}>🗑</button>
              </div>
            </div>
          );
        })}
        <div className="shot-card add-shot">
          <div className="shot-body">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Shot title…" />
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What happens in this shot…" rows={2} />
            <label className="dur">duration <input type="number" min="1" max="30" value={dur} onChange={(e) => setDur(Number(e.target.value))} />s</label>
            <button className="btn primary" onClick={addShot}>+ Add shot</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function statusIcon(status) {
  return {
    draft: '✎', image_generating: '⟳', image_review: '👁',
    video_generating: '⟳', video_review: '👁', complete: '✓', failed: '⚠',
  }[status] || '·';
}

function EditableText({ value, onSave, className, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(value);
  if (!editing) {
    return (
      <div className={`${className} editable`} onClick={() => { setV(value); setEditing(true); }} title="click to edit">
        {value || <span className="placeholder">{placeholder || '—'}</span>}
      </div>
    );
  }
  return (
    <input
      autoFocus className={className} value={v}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { setEditing(false); if (v !== value) onSave(v); }}
      onKeyDown={(e) => e.key === 'Enter' && e.target.blur()}
    />
  );
}
