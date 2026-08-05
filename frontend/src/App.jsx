import { useState, useEffect, useCallback, useRef } from 'react';
import './index.css';
import { api } from './api';
import { useSocket } from './hooks/useSocket';
import NetworkMap from './components/NetworkMap';
import TicketDetail from './components/TicketDetail';
import SimulatorPanel from './components/SimulatorPanel';

function timeAgo(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)   return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  return `${Math.round(diff / 3600)}h ago`;
}

function useToasts() {
  const [toasts, setToasts] = useState([]);
  const add = useCallback((msg, type = 'info') => {
    const id = Date.now();
    setToasts(t => [...t, { id, msg, type }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3500);
  }, []);
  return { toasts, add };
}

export default function App() {
  const [topology,        setTopology]        = useState(null);
  const [tickets,         setTickets]         = useState([]);
  const [selectedTicket,  setSelectedTicket]  = useState(null);
  const [selectedTab,     setSelectedTab]     = useState('tickets');
  const [showDetail,      setShowDetail]      = useState(false);
  const [loadingTopo,     setLoadingTopo]     = useState(true);
  const [darkCount,       setDarkCount]       = useState(0);

  const { toasts, add: addToast } = useToasts();
  const topologyRef = useRef(null);

  const handleSocketEvent = useCallback((event, data) => {
    switch (event) {
      case 'ticket:new': {
        addToast(`🔴 New fault ticket: ${data.fault_type.toUpperCase()} (${data.affected_poles} poles)`, 'error');
        setTickets(prev => [data, ...prev]);
        break;
      }
      case 'ticket:updated': {
        setTickets(prev => prev.map(t => t.id === data.id ? { ...t, ...data } : t));
        setSelectedTicket(prev => prev?.id === data.id ? { ...prev, ...data } : prev);
        if (data.auto_verified) addToast(`✅ Ticket auto-verified — all poles restored`, 'success');
        break;
      }
      case 'watchdog:poles_flagged': {
        if (data?.flagged > 0) {
          addToast(`⏱ Watchdog flagged ${data.flagged} silent pole(s) as dark`, 'info');
          refreshTopology();
        }
        break;
      }
      case 'telemetry:event': {
        setDarkCount(prev => {
          if (data.energized === false) return prev + 1;
          if (data.energized === true)  return Math.max(0, prev - 1);
          return prev;
        });
        break;
      }
      case 'simulator:fault_injected': {
        addToast(`⚡ Fault injected — ${data.silent + data.explicit} poles affected`, 'info');
        refreshTopology();
        refreshTickets();
        break;
      }
      case 'simulator:reset': {
        addToast(`↺ System reset — ${data.restored} poles restored`, 'success');
        refreshTopology();
        refreshTickets();
        break;
      }
      case 'simulator:repair_injected': {
        addToast(`🔧 Repair injected — ${data.restored} poles restored`, 'success');
        refreshTopology();
        refreshTickets();
        break;
      }
      default: break;
    }
  }, []);

  const { connected } = useSocket(handleSocketEvent);

  async function refreshTopology() {
    try {
      const data = await api.getTopology();
      topologyRef.current = data;
      setTopology(data);
      const dark = data.poles.filter(p => p.energized === false).length;
      setDarkCount(dark);
    } catch (e) {
      console.error('Topology load failed:', e);
    }
  }

  async function refreshTickets() {
    try {
      const data = await api.getTickets();
      setTickets(data.tickets);
    } catch (e) {
      console.error('Tickets load failed:', e);
    }
  }

  useEffect(() => {
    (async () => {
      setLoadingTopo(true);
      await Promise.all([refreshTopology(), refreshTickets()]);
      setLoadingTopo(false);
    })();
  }, []);

  const selectTicket = useCallback(async (ticket) => {
    setSelectedTicket(ticket);
    setShowDetail(true);
    setSelectedTab('tickets');
    try {
      const full = await api.getTicket(ticket.id);
      setSelectedTicket(full);
    } catch {}
  }, []);

  const handleTicketUpdated = useCallback((id, newStatus) => {
    setTickets(prev => prev.map(t => t.id === id ? { ...t, status: newStatus } : t));
    setSelectedTicket(prev => prev?.id === id ? { ...prev, status: newStatus } : prev);
    addToast(`Ticket → ${newStatus.replace('_', ' ')}`, 'success');
  }, []);

  const liveCount    = topology ? topology.poles.filter(p => p.energized === true).length : 0;
  const totalPoles   = topology?.poles.length ?? 0;
  const openTickets  = tickets.filter(t => !['verified','closed'].includes(t.status)).length;

  return (
    <>
      <div className="app-layout">
        <header className="header">
          <div className="header-logo">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
            <div>
              <div>KSPDB Fault Management</div>
              <div className="header-subtitle">Karnataka State Power Distribution Board</div>
            </div>
          </div>

          <div className="header-spacer" />

          <div className="stat-chip">
            <span className="dot" style={{ background: 'var(--live)' }} />
            <span className="val">{liveCount.toLocaleString()}</span>
            <span>live</span>
          </div>
          <div className="stat-chip">
            <span className="dot" style={{ background: 'var(--dark-pole)' }} />
            <span className="val">{darkCount.toLocaleString()}</span>
            <span>dark</span>
          </div>
          <div className="stat-chip">
            <span className="dot" style={{ background: '#f59e0b' }} />
            <span className="val">{openTickets}</span>
            <span>open faults</span>
          </div>
          <div className="stat-chip">
            <span className="dot" style={{ background: 'var(--text-muted)' }} />
            <span className="val">{totalPoles.toLocaleString()}</span>
            <span>poles</span>
          </div>

          <div className="flex items-center gap-2" style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>
            <div className={`connection-dot ${connected ? '' : 'disconnected'}`} />
            {connected ? 'Live' : 'Reconnecting…'}
          </div>
        </header>

        <main className="map-area">
          {loadingTopo ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', flexDirection: 'column', gap: 16 }}>
              <div className="spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
              <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>Loading network topology…</div>
            </div>
          ) : (
            <NetworkMap
              topology={topology}
              tickets={tickets}
              selectedTicket={selectedTicket}
              onPoleClick={(pole) => addToast(`${pole.pole_id} — ${pole.energized === true ? 'LIVE' : pole.energized === false ? 'DARK' : 'UNKNOWN'}`, 'info')}
              onTicketSelect={selectTicket}
            />
          )}

          {!loadingTopo && (
            <div className="map-legend">
              <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.6px', color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>Legend</div>
              <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--live)' }} />Live pole</div>
              <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--dark-pole)' }} />Dark pole</div>
              <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--unknown)' }} />No device</div>
              <div className="legend-item"><div className="legend-dot" style={{ background: '#6366f1', borderRadius: 3 }} />DT</div>
              <div className="legend-item"><div className="legend-dot" style={{ background: 'var(--dark-pole)', boxShadow: '0 0 8px var(--dark-pole)' }} />Fault pin</div>
            </div>
          )}
        </main>

        <aside className="sidebar">
          <div className="sidebar-tabs">
            <button
              className={`sidebar-tab ${selectedTab === 'tickets' ? 'active' : ''}`}
              onClick={() => { setSelectedTab('tickets'); setShowDetail(false); }}
            >
              Fault Tickets
              {openTickets > 0 && (
                <span style={{ marginLeft: 6, background: 'var(--dark-pole)', color: 'white', borderRadius: '10px', padding: '0 5px', fontSize: 9, fontWeight: 700 }}>
                  {openTickets}
                </span>
              )}
            </button>
            <button
              className={`sidebar-tab ${selectedTab === 'simulator' ? 'active' : ''}`}
              onClick={() => setSelectedTab('simulator')}
            >
              Simulator
            </button>
          </div>

          <div className="sidebar-content">
            {selectedTab === 'tickets' && !showDetail && (
              tickets.length === 0 ? (
                <div className="empty-state">
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                    <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
                    <polyline points="22 4 12 14.01 9 11.01"/>
                  </svg>
                  <p>No fault tickets.<br />All systems nominal.</p>
                </div>
              ) : (
                <>
                  <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between' }}>
                    <span>{tickets.length} ticket{tickets.length !== 1 ? 's' : ''} total</span>
                    <span>{openTickets} open</span>
                  </div>
                  {tickets.map(ticket => (
                    <div
                      key={ticket.id}
                      className={`ticket-item ${selectedTicket?.id === ticket.id ? 'selected' : ''}`}
                      onClick={() => selectTicket(ticket)}
                    >
                      <div className="ticket-header">
                        <span className={`ticket-type-badge badge-${ticket.fault_type}`}>{ticket.fault_type}</span>
                        <span className={`status-pill pill-${ticket.status}`}>{ticket.status.replace('_', ' ')}</span>
                        <span className="ticket-id">{ticket.id.slice(0, 8)}</span>
                      </div>
                      <div className="ticket-location">
                        {ticket.dt_id && <span className="mono" style={{ fontSize: 11 }}>{ticket.dt_id}</span>}
                        {ticket.ward && <span>· {ticket.ward}</span>}
                      </div>
                      <div className="ticket-meta">
                        <span className={`conf-dot conf-${ticket.confidence}`} />
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{ticket.confidence}</span>
                        <span className="ticket-poles-count">{ticket.affected_poles} poles</span>
                        {ticket.estimated_households > 0 && (
                          <span className="ticket-poles-count">· {ticket.estimated_households} HH</span>
                        )}
                        <span className="ticket-time">{timeAgo(ticket.detected_at)}</span>
                      </div>
                    </div>
                  ))}
                </>
              )
            )}

            {selectedTab === 'tickets' && showDetail && (
              <TicketDetail
                ticket={selectedTicket}
                onUpdated={handleTicketUpdated}
                onClose={() => setShowDetail(false)}
              />
            )}

            {selectedTab === 'simulator' && (
              <SimulatorPanel
                onResult={({ type }) => {
                  if (type === 'fault' || type === 'reset') {
                    refreshTickets();
                  }
                }}
              />
            )}
          </div>
        </aside>
      </div>

      <div className="toast-container">
        {toasts.map(({ id, msg, type }) => (
          <div key={id} className={`toast toast-${type}`}>{msg}</div>
        ))}
      </div>
    </>
  );
}
