import React from 'react';
import { api } from '../api.js';

// Queue monitor: NOW / NEXT / QUEUED / COMPLETE / FAILED with controls.
export default function QueuePanel({ state, onAction }) {
  const { queue } = state;
  const sections = [
    ['NOW', queue.now],
    ['QUEUED', queue.queued],
    ['FAILED', queue.failed],
    ['CANCELLED', queue.cancelled],
    ['COMPLETE', queue.complete],
  ];
  const nextId = queue.next?.id;
  return (
    <div className="queue-panel">
      {sections.map(([label, jobs]) => (
        <div key={label} className="queue-section">
          <h3>{label} <span className="count">{jobs.length}</span></h3>
          {jobs.length === 0 && <div className="queue-empty">—</div>}
          {jobs.map((j) => (
            <div key={j.id} className={`job-row st-${j.status.toLowerCase()}`}>
              <span className="job-id">#{j.id}</span>
              <span className="job-kind">{j.kind}</span>
              <span className="job-shot">shot {j.shot_id}</span>
              <span className="job-round">r{j.round}</span>
              {j.id === nextId && <span className="tag next">NEXT</span>}
              <span className="job-attempts">attempts {j.attempts}</span>
              {j.cost > 0 && <span className="job-cost">${j.cost.toFixed(3)}</span>}
              {j.error && <span className="job-error" title={j.error}>⚠ {j.error}</span>}
              <span className="job-actions">
                {(j.status === 'QUEUED' || j.status === 'NOW') &&
                  <button className="btn small danger" onClick={() => onAction(() => api.post(`/api/jobs/${j.id}/cancel`))}>cancel</button>}
                {(j.status === 'FAILED' || j.status === 'CANCELLED') &&
                  <button className="btn small" onClick={() => onAction(() => api.post(`/api/jobs/${j.id}/retry`))}>retry</button>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
