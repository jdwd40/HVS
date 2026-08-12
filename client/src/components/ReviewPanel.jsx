import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import Media from './Media.jsx';

// Review console: candidate grid, AI SELECTED highlight, live countdown,
// pause / override / reject-regenerate / immediate OK.
export default function ReviewPanel({ approval, state, onAction }) {
  const { candidates, serverTime } = state;
  const [, forceTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => forceTick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, []);

  const cands = candidates.filter(
    (c) => c.shot_id === approval.shot_id && c.kind === approval.kind && c.round === approval.round && c.status === 'pending'
  );
  const shot = state.shots.find((s) => s.id === approval.shot_id);
  const isPaused = approval.status === 'paused';
  const remainingMs = approval.deadline ? Math.max(0, approval.deadline - Date.now()) : null;
  const remaining = remainingMs != null ? (remainingMs / 1000).toFixed(1) : null;
  const pct = approval.deadline ? Math.min(100, (remainingMs / (approval.countdown_seconds * 1000)) * 100) : null;

  return (
    <section className={`review-panel ${isPaused ? 'paused' : ''}`}>
      <div className="review-head">
        <div>
          <span className="review-kind">{approval.kind === 'image' ? '🖼 IMAGE REVIEW' : '🎞 VIDEO REVIEW'}</span>
          <span className="review-shot">Shot #{shot?.ord} — {shot?.title}</span>
          <span className="review-round">round {approval.round}</span>
        </div>
        <div className="review-controls">
          {approval.deadline != null && !isPaused && (
            <div className="countdown" title="AUTO approves the selected candidate when this hits zero">
              <svg viewBox="0 0 36 36" className="countdown-ring">
                <circle cx="18" cy="18" r="15.9" className="ring-bg" />
                <circle cx="18" cy="18" r="15.9" className="ring-fg"
                  strokeDasharray={`${pct} ${100 - pct}`} />
              </svg>
              <span className="countdown-num">{remaining}s</span>
            </div>
          )}
          {isPaused
            ? <button className="btn warn" onClick={() => onAction(() => api.post(`/api/approvals/${approval.id}/resume`))}>▶ Resume countdown</button>
            : approval.deadline != null &&
              <button className="btn" onClick={() => onAction(() => api.post(`/api/approvals/${approval.id}/pause`))}>⏸ Pause</button>}
          <button className="btn primary" onClick={() => onAction(() => api.post(`/api/approvals/${approval.id}/approve`))}>✓ OK now</button>
          <button className="btn danger" onClick={() => onAction(() => api.post(`/api/approvals/${approval.id}/reject`))}>✗ Reject & regenerate</button>
        </div>
      </div>
      <div className="candidate-grid">
        {cands.map((c) => {
          const isUserSel = !!c.user_selected;
          const isAiSel = !!c.ai_selected;
          return (
            <div
              key={c.id}
              className={`candidate ${isUserSel ? 'user-selected' : ''} ${isAiSel && !isUserSel ? 'ai-selected' : ''}`}
              onClick={() => onAction(() => api.post(`/api/approvals/${approval.id}/select`, { candidateId: c.id }))}
              title="click to override selection"
            >
              <div className="candidate-media">
                <Media path={c.asset_path} video={c.kind === 'video'} alt={`candidate ${c.id}`} />
              </div>
              <div className="candidate-foot">
                {isAiSel && <span className="tag ai">AI SELECTED</span>}
                {isUserSel && <span className="tag user">YOUR PICK</span>}
                <span className="score">score {c.ai_score.toFixed(2)}</span>
              </div>
            </div>
          );
        })}
      </div>
      {state.project.mode === 'MANUAL' && (
        <div className="manual-note">MANUAL mode — this review waits for you. Pick a candidate, then OK or Reject.</div>
      )}
    </section>
  );
}
