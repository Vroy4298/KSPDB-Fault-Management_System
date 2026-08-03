// API helpers — all calls go through /api (proxied by nginx/vite to backend:3000)

const BASE = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export const api = {
  // Topology
  getTopology:          () => req('GET',  '/topology'),
  getDtTopology:        (id) => req('GET', `/topology/dt/${id}`),

  // Tickets
  getTickets:           (status) => req('GET', `/tickets${status ? `?status=${status}` : ''}`),
  getTicket:            (id) => req('GET',  `/tickets/${id}`),
  updateTicket:         (id, status) => req('PATCH', `/tickets/${id}`, { status }),

  // Simulator
  getScenarios:         () => req('GET',  '/simulator/scenarios'),
  getSimulatorStatus:   () => req('GET',  '/simulator/status'),
  injectFault:          (body) => req('POST', '/simulator/fault',  body),
  repairFault:          (body) => req('POST', '/simulator/repair', body),
  resetSimulator:       (clearTickets) => req('POST', '/simulator/reset', { clear_tickets: clearTickets }),

  // Health
  getHealth:            () => req('GET', '/health'),
};
