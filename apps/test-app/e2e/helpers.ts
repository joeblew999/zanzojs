/**
 * Seed helpers — call the worker API directly to set up test state.
 * These run from Node (not the browser), so we use fetch() directly.
 */

const WORKER = 'http://localhost:8787';

export async function grant(subject: string, relation: string, type: string, id: string) {
  const res = await fetch(`${WORKER}/zanzo/grant`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-actor': subject },
    body: JSON.stringify({ subject, relation, type, id }),
  });
  if (!res.ok) throw new Error(`grant failed: ${await res.text()}`);
}

export async function revoke(subject: string, relation: string, type: string, id: string) {
  const res = await fetch(`${WORKER}/zanzo/revoke`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', 'x-actor': subject },
    body: JSON.stringify({ subject, relation, type, id }),
  });
  if (!res.ok) throw new Error(`revoke failed: ${await res.text()}`);
}

export async function writeFile(actor: string, path: string, content: string) {
  const res = await fetch(`${WORKER}/files${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/plain', 'x-actor': actor },
    body: content,
  });
  if (!res.ok) throw new Error(`writeFile failed: ${await res.text()}`);
}

export async function deleteFile(actor: string, path: string) {
  await fetch(`${WORKER}/files${path}`, {
    method: 'DELETE',
    headers: { 'x-actor': actor },
  });
}

/** Seed the Module/Workspace tuples so the permissions tab has data. */
export async function seedModulePermissions() {
  // Alice: admin of all three workspaces
  for (const ws of ['ws1', 'ws2', 'ws3']) {
    await grant('User:alice', 'admin', 'Workspace', ws);
    // Structural: each module belongs to its workspace
    for (const mod of ['facturacion', 'rrhh', 'reportes']) {
      await grant(`Workspace:${ws}`, 'workspace', 'Module', `${ws}_${mod}`);
    }
  }
  // Bob: contributor on ws1 facturacion only
  await grant('User:bob', 'contributor', 'Module', 'ws1_facturacion');
}
