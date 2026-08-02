import { useState, useEffect } from 'react';

/**
 * Phase 1 placeholder.
 * This will be replaced with the full operator console in Phase 7.
 * For now it confirms the full stack is wired up end-to-end.
 */
export default function App() {
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="min-h-screen bg-slate-900 flex flex-col items-center justify-center p-8">
      {/* Header */}
      <div className="mb-8 text-center">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="w-3 h-3 rounded-full bg-green-400 animate-pulse" />
          <span className="text-xs font-mono text-slate-400 uppercase tracking-widest">
            System Online
          </span>
        </div>
        <h1 className="text-3xl font-bold text-white">
          KSPDB Fault Management
        </h1>
        <p className="mt-2 text-slate-400 text-sm">
          Karnataka State Power Distribution Board — SD-07 Subdivision
        </p>
      </div>

      {/* Status card */}
      <div className="w-full max-w-lg bg-slate-800 rounded-2xl border border-slate-700 p-6 shadow-xl">
        {error && (
          <div className="flex items-center gap-3 p-4 bg-red-900/30 border border-red-700 rounded-xl text-red-300 text-sm mb-4">
            <span className="text-red-400">⚠</span>
            <span>Backend unreachable: {error}</span>
          </div>
        )}

        {!health && !error && (
          <div className="text-center py-6 text-slate-400 text-sm animate-pulse">
            Connecting to backend...
          </div>
        )}

        {health && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-slate-400 text-sm">Status</span>
              <span className="text-green-400 font-semibold text-sm">● Operational</span>
            </div>

            <hr className="border-slate-700" />

            <div className="grid grid-cols-2 gap-3">
              {[
                { label: 'Total Poles', value: health.network?.poles?.toLocaleString() },
                { label: 'Live Poles', value: health.network?.poles_live?.toLocaleString(), color: 'text-green-400' },
                { label: 'Dark Poles', value: health.network?.poles_dark?.toLocaleString(), color: 'text-red-400' },
                { label: 'Active Faults', value: health.active_tickets, color: health.active_tickets > 0 ? 'text-orange-400' : 'text-slate-300' },
                { label: 'Distribution Transformers', value: health.network?.dts },
                { label: 'Feeders', value: health.network?.feeders },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-slate-900 rounded-xl p-3 border border-slate-700">
                  <div className="text-slate-500 text-xs mb-1">{label}</div>
                  <div className={`font-mono font-bold text-lg ${color || 'text-slate-200'}`}>
                    {value ?? '—'}
                  </div>
                </div>
              ))}
            </div>

            <hr className="border-slate-700" />

            <div className="flex items-center justify-between text-xs text-slate-500">
              <span>
                Topology: {health.topology?.known_pct}% known / {100 - (health.topology?.known_pct ?? 0)}% inferred
              </span>
              <span>{new Date(health.timestamp).toLocaleTimeString()}</span>
            </div>
          </div>
        )}
      </div>

      <p className="mt-6 text-slate-600 text-xs text-center">
        Phase 1 scaffold — operator console coming in Phase 7
      </p>
    </div>
  );
}
