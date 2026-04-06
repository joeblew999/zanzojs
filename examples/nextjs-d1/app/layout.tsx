import { getRequestContext } from '@cloudflare/next-on-pages';
import { drizzle } from 'drizzle-orm/d1';
import { eq, like } from 'drizzle-orm';
import { ZanzoEngine, createZanzoSnapshot } from '@zanzojs/core';
import { ZanzoProvider } from '@zanzojs/react';
import { schema } from '../zanzo.config';
import { zanzoTuples } from '../drizzle/schema';

export const runtime = 'edge';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  let snapshot: Record<string, string[]> = {};

  try {
    const { env } = getRequestContext();
    const db = drizzle(env.DB);

    // Simulation: we use a hardcoded User:1 for the example
    const userId = 'User:1';

    // Load user tuples from D1
    const userTuples = await db.select()
      .from(zanzoTuples)
      .where(like(zanzoTuples.subject, `${userId}%`));

    const engine = new ZanzoEngine(schema);
    engine.load(userTuples);
    snapshot = createZanzoSnapshot(engine, userId);
  } catch {
    // No Cloudflare runtime during SSG — render with empty snapshot
  }

  return (
    <html lang="en">
      <body>
        <ZanzoProvider snapshot={snapshot}>
          {children}
        </ZanzoProvider>
      </body>
    </html>
  );
}
