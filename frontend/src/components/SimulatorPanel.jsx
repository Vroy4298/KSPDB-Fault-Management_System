import { useState, useEffect } from 'react';
import { api } from '../api';

const SCENARIO_ICONS = {
  span_small:     '⚡',
  span_large:     '⚡⚡',
  dt_blackout:    '🔌',
  feeder_trip:    '🔴',
  sensor_failure: '📡',
  multi_fault:    '⚡⚡',
  clean_span:     '✅',
};

export default function SimulatorPanel({ onResult }) {
  const [scenarios, setScenarios]   = useState([]);
  const [status, setStatus]         = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [loading, setLoading]       = useState(null); // scenario id being run
  const [customDt, setCustomDt]     = useState('');

  useEffect(() => {
    api.getScenarios().then(d => setScenarios(d.scenarios)).catch(console.error);
    refreshStatus();
  }, []);

  async function refreshStatus() {
    try { setStatus(await api.getSimulatorStatus()); } catch { /* ignore */ }
  }

  async function runScenario(scenario) {
    setLoading(scenario.id);
    setLastResult(null);
    try {
      const body = {
        scenario_id: scenario.id,
        ...(customDt ? { dt_id: customDt } : {}),
      };
      const result = await api.injectFault(body);
      setLastResult({ type: 'success', data: result });
      onResult?.({ type: 'fault', result });
    } catch (e) {
      setLastResult({ type: 'error', data: e.message });
    } finally {
      setLoading(null);
      await refreshStatus();
    }
  }

  async function doReset(clearTickets) {
    setLoading('reset');
    try {
      const r = await api.resetSimulator(clearTickets);
      setLastResult({ type: 'success', data: r });
      onResult?.({ type: 'reset', result: r });
    } catch (e) {
      setLastResult({ type: 'error', data: e.message });
    } finally {
      setLoading(null);
      await refreshStatus();
    }
  }

  return (
    <div className="sim-panel">
      {/* Live status */}
      {status && (
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8,
          marginBottom: 14,
        }}>
          {[
            { label: 'Live Poles',   val: status.poles.live   ?? 0, color: 'var(--live)' },
            { label: 'Dark Poles',   val: status.poles.dark   ?? 0, color: 'var(--dark-pole)' },
            { label: 'Open Tickets', val: Object.entries(status.tickets).filter(([k]) => !['verified','closed'].includes(k)).reduce((a,[,v]) => a + v, 0), color: '#f59e0b' },
          ].map(({ label, val, color }) => (
            <div key={label} className="detail-card" style={{ textAlign: 'center' }}>
              <div className="num" style={{ color, fontSize: 18 }}>{val}</div>
              <div className="lbl">{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* Optional DT override */}
      <div style={{ marginBottom: 12 }}>
        <div className="sim-section-title">Optional: Target DT</div>
        <input
          type="text"
          placeholder="e.g. D-0001 (leave blank for random)"
          value={customDt}
          onChange={e => setCustomDt(e.target.value)}
          style={{
            width: '100%',
            padding: '7px 10px',
            background: 'var(--bg-card)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            color: 'var(--text-primary)',
            fontFamily: 'var(--mono)',
            fontSize: 12,
          }}
        />
      </div>

      {/* Scenario cards */}
      <div className="sim-section-title">Inject Scenario</div>
      {scenarios.map(s => (
        <div
          key={s.id}
          className="sim-scenario-card"
          onClick={() => loading ? null : runScenario(s)}
          style={{ opacity: loading && loading !== s.id ? 0.5 : 1 }}
        >
          <div className="flex items-center gap-2" style={{ marginBottom: 3 }}>
            <span style={{ fontSize: 14 }}>{SCENARIO_ICONS[s.id] || '⚡'}</span>
            <span className="sim-scenario-name">{s.name}</span>
            {loading === s.id && <span className="spinner" style={{ marginLeft: 'auto' }} />}
          </div>
          <div className="sim-scenario-desc">{s.description}</div>
          <div style={{ marginTop: 5, fontSize: 10, color: '#f59e0b' }}>
            Expected: {s.expected_ticket}
          </div>
        </div>
      ))}

      {/* Reset controls */}
      <div className="sim-section-title" style={{ marginTop: 16 }}>Reset</div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-secondary w-full" onClick={() => doReset(false)} disabled={!!loading}>
          {loading === 'reset' ? <span className="spinner" /> : 'Restore Poles'}
        </button>
        <button className="btn btn-danger w-full" onClick={() => doReset(true)} disabled={!!loading}>
          Full Reset
        </button>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 6, lineHeight: 1.5 }}>
        "Restore Poles" restores energized state. "Full Reset" also closes all open tickets.
      </div>

      {/* Last result */}
      {lastResult && (
        <>
          <div className="sim-section-title" style={{ marginTop: 14 }}>Last Result</div>
          <div className="sim-result" style={{
            borderColor: lastResult.type === 'error' ? 'rgba(239,68,68,0.3)' : 'var(--border-bright)',
            color: lastResult.type === 'error' ? '#f87171' : 'var(--text-secondary)',
          }}>
            {JSON.stringify(lastResult.data, null, 2)}
          </div>
        </>
      )}

      {/* Refresh */}
      <button
        className="btn btn-secondary w-full"
        style={{ marginTop: 12 }}
        onClick={refreshStatus}
      >
        ↻ Refresh Status
      </button>
    </div>
  );
}
