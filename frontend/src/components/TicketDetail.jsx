import { useState, useCallback } from 'react';
import { api } from '../api';

const STATUS_FLOW = {
  detected:      { next: 'acknowledged',  label: 'Acknowledge',    cls: 'btn-primary' },
  acknowledged:  { next: 'crew_assigned', label: 'Assign Crew',    cls: 'btn-primary' },
  crew_assigned: { next: 'resolved',      label: 'Mark Resolved',  cls: 'btn-primary' },
  resolved:      { next: 'verified',      label: 'Verify',         cls: 'btn-primary' },
  verified:      { next: 'closed',        label: 'Close Ticket',   cls: 'btn-secondary' },
  closed:        null,
};

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)  return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

export default function TicketDetail({ ticket, onUpdated, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const transition = STATUS_FLOW[ticket?.status];

  const handleAdvance = useCallback(async () => {
    if (!transition || loading) return;
    setLoading(true);
    setError(null);
    try {
      await api.updateTicket(ticket.id, transition.next);
      onUpdated?.(ticket.id, transition.next);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [ticket, transition, loading, onUpdated]);

  if (!ticket) {
    return (
      <div className="empty-state" style={{ paddingTop: 80 }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/>
          <rect x="9" y="3" width="6" height="4" rx="1"/>
          <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
        </svg>
        <p>Select a ticket from the list<br />to see details here</p>
      </div>
    );
  }

  const confidenceColor = { HIGH: '#22c55e', MEDIUM: '#f59e0b', LOW: '#ef4444' };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header */}
      <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div className="flex items-center gap-2" style={{ marginBottom: 6 }}>
          <span className={`ticket-type-badge badge-${ticket.fault_type}`}>
            {ticket.fault_type}
          </span>
          <span className={`status-pill pill-${ticket.status}`}>{ticket.status.replace('_', ' ')}</span>
          {ticket.topology_mode === 'inferred' && (
            <span title="Topology inferred from GPS (MST)" style={{ fontSize: 10, color: '#f59e0b', marginLeft: 'auto' }}>
              ⚠ inferred topo
            </span>
          )}
        </div>
        <div style={{ fontSize: 10, fontFamily: 'var(--mono)', color: 'var(--text-muted)' }}>
          {ticket.id}
        </div>
      </div>

      {/* Scrollable content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px' }}>

        {/* Impact cards */}
        <div className="detail-grid" style={{ marginBottom: 14 }}>
          <div className="detail-card">
            <div className="num" style={{ color: 'var(--dark-pole)' }}>{ticket.affected_poles}</div>
            <div className="lbl">Poles Affected</div>
          </div>
          <div className="detail-card">
            <div className="num" style={{ color: '#f59e0b' }}>{ticket.estimated_households}</div>
            <div className="lbl">Households</div>
          </div>
        </div>

        {/* Confidence */}
        <div style={{ marginBottom: 14 }}>
          <div className="detail-label">Detection Confidence</div>
          <div className="flex items-center gap-2">
            <span className={`conf-dot conf-${ticket.confidence}`} />
            <span style={{ color: confidenceColor[ticket.confidence], fontWeight: 600, fontSize: 13 }}>
              {ticket.confidence}
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>· {ticket.topology_mode}</span>
          </div>
          {ticket.confidence_reason && (
            <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 }}>
              {ticket.confidence_reason}
            </div>
          )}
        </div>

        {/* Fault boundary */}
        {(ticket.upstream_pole_id || ticket.downstream_pole_id) && (
          <div style={{ marginBottom: 14 }}>
            <div className="detail-label">Fault Boundary</div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <div>
                <span style={{ color: 'var(--live)', marginRight: 6 }}>●</span>
                Last live: <span className="detail-mono">{ticket.upstream_pole_id || '—'}</span>
              </div>
              <div>
                <span style={{ color: 'var(--dark-pole)', marginRight: 6 }}>●</span>
                First dark: <span className="detail-mono">{ticket.downstream_pole_id || '—'}</span>
              </div>
            </div>
          </div>
        )}

        {/* Location */}
        <div style={{ marginBottom: 14 }}>
          <div className="detail-label">Location</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {ticket.ward && <span>{ticket.ward}</span>}
            {ticket.pincode && <span style={{ color: 'var(--text-muted)', marginLeft: 6 }}>({ticket.pincode})</span>}
          </div>
          {ticket.dt_id && (
            <div style={{ fontSize: 11, fontFamily: 'var(--mono)', color: 'var(--accent)', marginTop: 2 }}>
              {ticket.dt_id}
              {ticket.feeder_id && <span style={{ color: 'var(--text-muted)' }}> / {ticket.feeder_id}</span>}
            </div>
          )}
          <div style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'var(--mono)', marginTop: 2 }}>
            {ticket.fault_lat?.toFixed(5)}, {ticket.fault_lon?.toFixed(5)}
          </div>
        </div>

        {/* Timeline */}
        <div style={{ marginBottom: 14 }}>
          <div className="detail-label">Timeline</div>
          {[
            { key: 'detected_at',     label: 'Detected' },
            { key: 'acknowledged_at', label: 'Acknowledged' },
            { key: 'crew_assigned_at',label: 'Crew Assigned' },
            { key: 'resolved_at',     label: 'Resolved' },
            { key: 'verified_at',     label: 'Verified' },
            { key: 'closed_at',       label: 'Closed' },
          ].filter(({ key }) => ticket[key]).map(({ key, label }) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 3 }}>
              <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--mono)' }}>{timeAgo(ticket[key])}</span>
            </div>
          ))}
        </div>

        {/* AI Summary */}
        <div style={{ marginBottom: 14 }}>
          <div className="detail-label">AI Summary</div>
          {ticket.ai_summary ? (
            <div className="ai-summary-box">"{ticket.ai_summary}"</div>
          ) : (
            <div className="ai-summary-box" style={{ color: 'var(--text-muted)', fontStyle: 'normal', fontSize: 11 }}>
              No AI summary available
            </div>
          )}
        </div>

        {error && (
          <div style={{ color: '#f87171', fontSize: 11, marginBottom: 8, padding: '8px 10px', background: 'rgba(239,68,68,0.1)', borderRadius: 6 }}>
            {error}
          </div>
        )}
      </div>

      {/* Action buttons */}
      {transition && (
        <div className="action-row">
          <button className={`btn ${transition.cls}`} onClick={handleAdvance} disabled={loading}>
            {loading ? <span className="spinner" /> : transition.label}
          </button>
          {onClose && (
            <button className="btn btn-secondary" onClick={onClose}>← Back</button>
          )}
        </div>
      )}
    </div>
  );
}
