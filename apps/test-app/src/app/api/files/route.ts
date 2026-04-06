import { NextRequest, NextResponse } from 'next/server';

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8787';

function actorHeader(req: NextRequest) {
  return req.headers.get('x-actor') ?? 'User:alice';
}

/**
 * GET  /api/files?path=/projects/demo    → proxy to GET /ls/<path>  (directory listing)
 * GET  /api/files?path=/projects/demo/f  → proxy to GET /files/<path> (file read)
 * PUT  /api/files?path=/projects/demo/f  → proxy to PUT /files/<path> (file write)
 * DELETE /api/files?path=...             → proxy to DELETE /files/<path>
 */

export async function GET(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path') ?? '/';
  const mode = request.nextUrl.searchParams.get('mode') ?? 'ls'; // 'ls' | 'read'
  const actor = actorHeader(request);

  const url = mode === 'read'
    ? `${WORKER_URL}/files${path}`
    : `${WORKER_URL}/ls${path}`;

  const res = await fetch(url, { headers: { 'x-actor': actor } });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    return NextResponse.json(err, { status: res.status });
  }

  if (mode === 'read') {
    const text = await res.text();
    return new NextResponse(text, { headers: { 'Content-Type': 'text/plain' } });
  }

  const data = await res.json();
  return NextResponse.json(data);
}

export async function PUT(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path') ?? '/';
  const actor = actorHeader(request);
  const body = await request.text();

  const res = await fetch(`${WORKER_URL}/files${path}`, {
    method: 'PUT',
    headers: { 'x-actor': actor, 'Content-Type': 'text/plain' },
    body,
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}

export async function DELETE(request: NextRequest) {
  const path = request.nextUrl.searchParams.get('path') ?? '/';
  const actor = actorHeader(request);

  const res = await fetch(`${WORKER_URL}/files${path}`, {
    method: 'DELETE',
    headers: { 'x-actor': actor },
  });

  const data = await res.json().catch(() => ({}));
  return NextResponse.json(data, { status: res.status });
}
