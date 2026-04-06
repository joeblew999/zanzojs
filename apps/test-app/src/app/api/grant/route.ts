import { NextRequest, NextResponse } from 'next/server';

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8787';

/**
 * POST /api/grant
 * Body: { subject, relation, object }  — object is "Type:id"
 * Proxies to workspace-d1 PUT /zanzo/grant with { subject, relation, type, id }
 */
export async function POST(request: NextRequest) {
  const body = await request.json() as { subject: string; relation: string; object: string };
  const { subject, relation, object } = body;

  if (!subject || !relation || !object) {
    return NextResponse.json({ error: 'Missing required fields: subject, relation, object' }, { status: 400 });
  }

  const colon = object.indexOf(':');
  if (colon === -1) {
    return NextResponse.json({ error: 'object must be "Type:id"' }, { status: 400 });
  }
  const type = object.slice(0, colon);
  const id   = object.slice(colon + 1);

  const actor = request.headers.get('x-actor') ?? `User:${request.headers.get('x-admin-id') ?? 'alice'}`;

  const res = await fetch(`${WORKER_URL}/zanzo/grant`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-actor': actor },
    body: JSON.stringify({ subject, relation, type, id }),
  });

  const data = await res.json();
  if (!res.ok) return NextResponse.json(data, { status: res.status });

  return NextResponse.json({ inserted: 1, ...data });
}
