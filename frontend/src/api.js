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
  getTopology:          () => req('GET',  '/topology'),
  getDtTopology:        (id) => req('GET', `/topology/dt/${id}`),

  getTickets:           (status) => req('GET', `/tickets${status ? `?status=${status}` : ''}`),
  getTicket:            (id) => req('GET',  `/tickets/${id}`),
  updateTicket:         (id, status) => req('PATCH', `/tickets/${id}`, { status }),

  getScenarios:         () => req('GET',  '/simulator/scenarios'),
  getSimulatorStatus:   () => req('GET',  '/simulator/status'),
  injectFault:          (body) => req('POST', '/simulator/fault',  body),
  repairFault:          (body) => req('POST', '/simulator/repair', body),
  resetSimulator:       (clearTickets) => req('POST', '/simulator/reset', { clear_tickets: clearTickets }),

  getHealth:            () => req('GET', '/health'),
};
