import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_API_URL || '';

export function useSocket(onEvent) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnectionDelay: 1000,
      reconnectionAttempts: Infinity,
    });

    socketRef.current = socket;

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    const events = [
      'telemetry:event',
      'telemetry:batch',
      'watchdog:poles_flagged',
      'ticket:new',
      'ticket:updated',
      'simulator:fault_injected',
      'simulator:repair_injected',
      'simulator:reset',
    ];

    for (const ev of events) {
      socket.on(ev, (data) => onEvent?.(ev, data));
    }

    return () => { socket.disconnect(); };
  }, []);

  return { socket: socketRef.current, connected };
}
