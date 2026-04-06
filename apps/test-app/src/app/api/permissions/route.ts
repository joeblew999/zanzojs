import { NextRequest, NextResponse } from 'next/server';

const WORKER_URL = process.env.WORKER_URL ?? 'http://localhost:8787';

/**
 * GET /api/permissions?userId=alice
 * Proxies to workspace-d1 GET /zanzo/snapshot?actor=User:alice
 */
export async function GET(request: NextRequest) {
  const userId = request.nextUrl.searchParams.get('userId');
  if (!userId) {
    return NextResponse.json({ error: 'Missing userId query parameter' }, { status: 400 });
  }

  const actor = `User:${userId}`;
  const res = await fetch(`${WORKER_URL}/zanzo/snapshot?actor=${encodeURIComponent(actor)}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Worker error' }));
    return NextResponse.json(err, { status: res.status });
  }

  const data = await res.json() as { snapshot: Record<string, string[]> };
  return NextResponse.json(data.snapshot);
}
