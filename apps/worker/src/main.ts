let shuttingDown = false;

const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(JSON.stringify({ event: 'worker_shutdown_started', signal }));
  // Fase 7 agregará el cierre ordenado de BullMQ, locks y jobs activos.
  process.exit(0);
};

console.info(JSON.stringify({ event: 'worker_started', status: 'idle' }));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.once('SIGINT', () => void shutdown('SIGINT'));
