import type { FastifyInstance } from 'fastify';

// Purely in-memory, old-school hit counter -- not analytics, so resetting
// on redeploy/restart is a non-issue and this adds zero storage. A GET that
// mutates is a deliberate simplicity tradeoff, same as a classic counter.
let day = '';
let count = 0;

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export default async function visitorsRoutes(app: FastifyInstance) {
  app.get('/api/visitors-today', async () => {
    const today = todayKey();
    if (today !== day) {
      day = today;
      count = 0;
    }
    count += 1;
    return { count };
  });
}
