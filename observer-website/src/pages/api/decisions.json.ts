import type { APIRoute } from 'astro';

export const GET: APIRoute = async () => {
  return new Response(JSON.stringify({
    status: 'ready',
    message: 'Set DATABASE_URL environment variable to enable live queries',
    decisions: [],
  }), {
    headers: {
      'Content-Type': 'application/json',
    },
  });
};
