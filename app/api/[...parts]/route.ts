import { handle } from '../../../src/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function route(request: Request, context: { params: Promise<{ parts: string[] }> }) {
  return handle(request, (await context.params).parts);
}

export { route as DELETE, route as GET, route as POST, route as PUT };
