'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { ZanzoProvider, useZanzo } from '@zanzojs/react';
import { schema } from '@/lib/zanzo';

// ─── CRUD Actions ────────────────────────────────────────────────────────
const CRUD_ACTIONS = ['create', 'read', 'update', 'delete'] as const;

const ACTION_META: Record<string, { label: string; icon: string; color: string }> = {
    create: { label: 'Create', icon: '+', color: 'var(--success)' },
    read: { label: 'Read', icon: 'R', color: 'var(--accent)' },
    update: { label: 'Update', icon: 'U', color: 'var(--warning)' },
    delete: { label: 'Delete', icon: 'D', color: 'var(--error)' },
};

// ─── Module definitions ──────────────────────────────────────────────────
const MODULE_DEFS: Record<string, { name: string; icon: string }> = {
    facturacion: { name: 'Facturacion', icon: '$' },
    rrhh: { name: 'RRHH', icon: '@' },
    reportes: { name: 'Reportes', icon: '#' },
};

// ─── User metadata ───────────────────────────────────────────────────────
const USERS = [
    { id: 'alice', label: 'Alice', role: 'Workspace Admin', desc: 'Full Workspace CRUD' },
    { id: 'bob', label: 'Bob', role: 'Contributor', desc: 'Can CRU in Facturacion' },
    { id: 'carol', label: 'Carol', role: 'No Access', desc: 'Zero Permissions' },
];

const WORKSPACES = [
    { id: 'ws1', name: 'Workspace 1' },
    { id: 'ws2', name: 'Workspace 2' },
    { id: 'ws3', name: 'Workspace 3' },
];

// ─── Module Card ────────────────────────────────────────────────────────
function ModuleCard({ moduleId, moduleName, icon, workspaceId, grantedActions }: {
    moduleId: string; moduleName: string; icon: string; workspaceId: string; grantedActions: string[];
}) {
    return (
        <div className="card-base" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                <div style={{ fontSize: '1.2rem', background: 'rgba(255,255,255,0.05)', padding: '8px', borderRadius: '8px', fontFamily: 'monospace' }}>
                    {icon}
                </div>
                <div>
                    <h3 style={{ fontSize: '1.1rem', marginBottom: '2px' }}>{moduleName}</h3>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>Workspace: {workspaceId}</div>
                </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px', marginTop: 'auto' }}>
                {CRUD_ACTIONS.map((action) => {
                    const meta = ACTION_META[action];
                    const granted = grantedActions.includes(action);
                    return (
                        <div key={action} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '6px 10px', background: 'rgba(0,0,0,0.2)', borderRadius: '4px'
                        }}>
                            <code style={{ background: 'transparent', padding: 0 }}>{action}</code>
                            <span style={{
                                fontSize: '0.65rem', fontWeight: 700, textTransform: 'uppercase',
                                padding: '2px 6px', borderRadius: '4px', border: '1px solid transparent',
                                ...(granted
                                    ? { background: 'rgba(0,255,150,0.1)', color: 'var(--success)', borderColor: 'rgba(0,255,150,0.1)' }
                                    : { background: 'rgba(255,50,50,0.1)', color: 'var(--error)', borderColor: 'rgba(255,50,50,0.1)' })
                            }}>
                                {granted ? 'YES' : 'NO'}
                            </span>
                        </div>
                    );
                })}
            </div>
        </div>
    );
}

// ─── Workspace Modules ──────────────────────────────────────────────────
function WorkspaceModules({ workspaceId }: { workspaceId: string }) {
    const { can } = useZanzo<typeof schema>();
    const moduleIds = ['facturacion', 'rrhh', 'reportes'];
    const accessibleModules = moduleIds
        .map((modId) => {
            const moduleRef = `Module:${workspaceId}_${modId}` as const;
            const grantedActions = CRUD_ACTIONS.filter((action) => can(action, moduleRef as `Module:${string}`));
            return { modId, grantedActions };
        })
        .filter(({ grantedActions }) => grantedActions.includes('read'));

    if (accessibleModules.length === 0) {
        return (
            <div className="card-base" style={{ padding: '3rem', textAlign: 'center', borderColor: 'var(--error)' }}>
                <div style={{ fontSize: '1.5rem', marginBottom: '1rem' }}>locked</div>
                <h3>Access Restricted</h3>
                <p style={{ color: 'var(--text-dim)', marginTop: '0.5rem' }}>No permissions for modules in this workspace.</p>
            </div>
        );
    }
    return (
        <div className="grid-cols">
            {accessibleModules.map(({ modId, grantedActions }) => {
                const def = MODULE_DEFS[modId] ?? { name: modId, icon: '?' };
                return (
                    <ModuleCard key={`${workspaceId}_${modId}`} moduleId={modId}
                        moduleName={def.name} icon={def.icon}
                        workspaceId={workspaceId} grantedActions={grantedActions} />
                );
            })}
        </div>
    );
}

// ─── Grant Access ───────────────────────────────────────────────────────
function GrantAccess({ onGrant }: { onGrant: () => void }) {
    const [targetUser, setTargetUser] = useState('bob');
    const [targetResource, setTargetResource] = useState('Module:ws1_facturacion');
    const [targetRole, setTargetRole] = useState('manager');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

    const handleGrant = async () => {
        setLoading(true);
        setResult(null);
        try {
            const res = await fetch('/api/grant', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ subject: `User:${targetUser}`, relation: targetRole, object: targetResource }),
            });
            const data = await res.json();
            if (res.ok) {
                setResult({ type: 'success', message: `Granted! (${data.inserted ?? 1} tuple)` });
                onGrant();
            } else {
                setResult({ type: 'error', message: data.error || 'Error' });
            }
        } catch {
            setResult({ type: 'error', message: 'Network error' });
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="card-base" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
            <h3 style={{ marginBottom: '1rem', borderBottom: '1px solid var(--border-subtle)', paddingBottom: '0.5rem' }}>Grant Permission</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: '1rem', alignItems: 'end' }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-ghost)', textTransform: 'uppercase' }}>User</label>
                    <select style={{ background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-main)', padding: '8px', borderRadius: '4px' }} value={targetUser} onChange={(e) => setTargetUser(e.target.value)}>
                        {USERS.map(u => <option key={u.id} value={u.id}>{u.label}</option>)}
                    </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-ghost)', textTransform: 'uppercase' }}>Resource</label>
                    <select style={{ background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-main)', padding: '8px', borderRadius: '4px' }} value={targetResource} onChange={(e) => setTargetResource(e.target.value)}>
                        <optgroup label="Workspaces">
                            {WORKSPACES.map(ws => <option key={ws.id} value={`Workspace:${ws.id}`}>{ws.name}</option>)}
                        </optgroup>
                        <optgroup label="Modules">
                            {WORKSPACES.map(ws => ['facturacion', 'rrhh', 'reportes'].map(m => (
                                <option key={`${ws.id}_${m}`} value={`Module:${ws.id}_${m}`}>{ws.id} - {m}</option>
                            )))}
                        </optgroup>
                    </select>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                    <label style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-ghost)', textTransform: 'uppercase' }}>Relation</label>
                    <select style={{ background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-main)', padding: '8px', borderRadius: '4px' }} value={targetRole} onChange={(e) => setTargetRole(e.target.value)}>
                        <option value="manager">Manager (Full CRUD)</option>
                        <option value="contributor">Contributor (CRU)</option>
                        <option value="editor">Editor (RU)</option>
                        <option value="viewer">Viewer (R)</option>
                        <option value="admin">Admin (Workspace level)</option>
                    </select>
                </div>
                <button className="btn-primary" onClick={handleGrant} disabled={loading} style={{ height: '36px' }}>
                    {loading ? '...' : 'Grant'}
                </button>
            </div>
            {result && (
                <div style={{ marginTop: '1rem', padding: '12px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 500, background: result.type === 'success' ? 'rgba(0,255,150,0.1)' : 'rgba(255,50,50,0.1)', color: result.type === 'success' ? 'var(--success)' : 'var(--error)' }}>
                    {result.message}
                </div>
            )}
        </div>
    );
}

// ─── File Browser ────────────────────────────────────────────────────────
type LsEntry = { name: string; type: 'file' | 'directory'; path: string };

function FileBrowser({ actor }: { actor: string }) {
    const [cwd, setCwd] = useState('/projects/demo');
    const [entries, setEntries] = useState<LsEntry[]>([]);
    const [fileContent, setFileContent] = useState<string | null>(null);
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [writeContent, setWriteContent] = useState('');
    const [writePath, setWritePath] = useState('');
    const [status, setStatus] = useState<string | null>(null);
    const [lsError, setLsError] = useState<string | null>(null);

    const ls = useCallback(async (path: string) => {
        setLsError(null);
        setFileContent(null);
        setSelectedFile(null);
        const res = await fetch(`/api/files?path=${encodeURIComponent(path)}&mode=ls`, {
            headers: { 'x-actor': actor },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            setLsError((err as any).error ?? `HTTP ${res.status}`);
            setEntries([]);
            return;
        }
        const data = await res.json() as { entries?: LsEntry[]; children?: LsEntry[] } | LsEntry[];
        // worker may return { entries: [...] } or just an array
        const list = Array.isArray(data) ? data : ((data as any).entries ?? (data as any).children ?? []);
        setEntries(list);
        setCwd(path);
    }, [actor]);

    const readFile = useCallback(async (path: string) => {
        setSelectedFile(path);
        const res = await fetch(`/api/files?path=${encodeURIComponent(path)}&mode=read`, {
            headers: { 'x-actor': actor },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            setFileContent(`Error: ${(err as any).error ?? res.status}`);
            return;
        }
        setFileContent(await res.text());
    }, [actor]);

    const writeFile = async () => {
        if (!writePath) return;
        const path = writePath.startsWith('/') ? writePath : `${cwd}/${writePath}`;
        const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
            method: 'PUT',
            headers: { 'x-actor': actor, 'Content-Type': 'text/plain' },
            body: writeContent,
        });
        if (res.ok) {
            setStatus(`Written: ${path}`);
            setWritePath('');
            setWriteContent('');
            ls(cwd);
        } else {
            const err = await res.json().catch(() => ({}));
            setStatus(`Error: ${(err as any).error ?? res.status}`);
        }
    };

    const deleteFile = async (path: string) => {
        const res = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
            method: 'DELETE',
            headers: { 'x-actor': actor },
        });
        if (res.ok) {
            setStatus(`Deleted: ${path}`);
            if (selectedFile === path) { setSelectedFile(null); setFileContent(null); }
            ls(cwd);
        } else {
            const err = await res.json().catch(() => ({}));
            setStatus(`Error: ${(err as any).error ?? res.status}`);
        }
    };

    useEffect(() => { ls(cwd); }, [actor]);

    const parent = cwd.split('/').slice(0, -1).join('/') || '/';

    return (
        <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1rem', height: '100%' }}>
            {/* Left: directory tree */}
            <div className="card-base" style={{ padding: '1rem', overflowY: 'auto' }}>
                <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-ghost)', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>
                    Files
                </div>
                <code style={{ fontSize: '0.75rem', color: 'var(--text-dim)', display: 'block', marginBottom: '0.5rem' }}>{cwd}</code>
                {cwd !== '/' && (
                    <div onClick={() => ls(parent)} style={{ cursor: 'pointer', padding: '4px 6px', borderRadius: '4px', fontSize: '0.85rem', color: 'var(--accent)', marginBottom: '4px' }}>
                        .. (up)
                    </div>
                )}
                {lsError && <div style={{ color: 'var(--error)', fontSize: '0.8rem' }}>{lsError}</div>}
                {entries.map((e) => (
                    <div key={e.path ?? e.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 6px', borderRadius: '4px', cursor: 'pointer', background: selectedFile === (e.path ?? `${cwd}/${e.name}`) ? 'rgba(255,255,255,0.06)' : 'transparent' }}
                        onClick={() => e.type === 'directory' ? ls(e.path ?? `${cwd}/${e.name}`) : readFile(e.path ?? `${cwd}/${e.name}`)}>
                        <span style={{ fontSize: '0.85rem' }}>
                            {e.type === 'directory' ? '[dir] ' : '[f] '}
                            {e.name}
                        </span>
                        {e.type === 'file' && (
                            <span onClick={(ev) => { ev.stopPropagation(); deleteFile(e.path ?? `${cwd}/${e.name}`); }}
                                style={{ fontSize: '0.7rem', color: 'var(--error)', padding: '1px 4px', borderRadius: '2px', cursor: 'pointer' }}>
                                del
                            </span>
                        )}
                    </div>
                ))}
                {entries.length === 0 && !lsError && (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-ghost)' }}>empty</div>
                )}
            </div>

            {/* Right: file content + write panel */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {fileContent !== null && (
                    <div className="card-base" style={{ padding: '1rem', flex: 1, overflowY: 'auto' }}>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-ghost)', marginBottom: '0.5rem' }}>{selectedFile}</div>
                        <pre style={{ margin: 0, fontSize: '0.85rem', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{fileContent}</pre>
                    </div>
                )}

                <div className="card-base" style={{ padding: '1rem' }}>
                    <div style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-ghost)', marginBottom: '0.75rem' }}>Write File</div>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                        <input placeholder="filename (relative to cwd or absolute)" value={writePath} onChange={(e) => setWritePath(e.target.value)}
                            style={{ flex: 1, background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-main)', padding: '6px 10px', borderRadius: '4px', fontSize: '0.85rem' }} />
                        <button className="btn-primary" onClick={writeFile} style={{ padding: '6px 16px', fontSize: '0.85rem' }}>Write</button>
                    </div>
                    <textarea placeholder="file content..." value={writeContent} onChange={(e) => setWriteContent(e.target.value)}
                        style={{ width: '100%', minHeight: '80px', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-main)', padding: '8px', borderRadius: '4px', fontSize: '0.85rem', resize: 'vertical', boxSizing: 'border-box' }} />
                    {status && <div style={{ marginTop: '6px', fontSize: '0.8rem', color: status.startsWith('Error') ? 'var(--error)' : 'var(--success)' }}>{status}</div>}
                </div>
            </div>
        </div>
    );
}

// ─── Main Page ───────────────────────────────────────────────────────────
export default function HomePage() {
    const [selectedUser, setSelectedUser] = useState('alice');
    const [activeWorkspace, setActiveWorkspace] = useState('ws1');
    const [activeTab, setActiveTab] = useState<'permissions' | 'files'>('permissions');
    const [snapshot, setSnapshot] = useState<Record<string, string[]> | null>(null);
    const [loading, setLoading] = useState(true);

    const fetchPermissions = useCallback(async (userId: string) => {
        setLoading(true);
        try {
            const res = await fetch(`/api/permissions?userId=${userId}`);
            const data = await res.json();
            setSnapshot(data);
        } catch {
            setSnapshot({});
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchPermissions(selectedUser); }, [selectedUser, fetchPermissions]);

    const currentUser = USERS.find((u) => u.id === selectedUser)!;
    const actor = `User:${selectedUser}`;

    return (
        <div style={{ display: 'flex', height: '100vh', width: '100vw' }}>
            {/* Sidebar */}
            <aside style={{ width: '240px', background: 'oklch(14% 0.01 285)', borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', padding: '1.5rem 1rem', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '2.5rem' }}>
                    <div style={{ width: '28px', height: '28px', background: 'var(--accent)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', fontWeight: 700, fontSize: '1rem' }}>Z</div>
                    <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--text-main)' }}>Zanzo<span style={{ color: 'var(--text-ghost)', opacity: 0.5 }}>React</span></div>
                </div>

                <div style={{ fontSize: '0.7rem', fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-ghost)', marginBottom: '0.75rem', letterSpacing: '0.05em' }}>Identity</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginBottom: '2rem' }}>
                    {USERS.map((user) => (
                        <div key={user.id} onClick={() => setSelectedUser(user.id)} style={{
                            padding: '10px 12px', borderRadius: '6px', cursor: 'pointer',
                            border: '1px solid transparent',
                            ...(selectedUser === user.id ? { background: 'rgba(255,255,255,0.08)', borderColor: 'var(--border-bright)' } : {})
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                                <span style={{ fontWeight: selectedUser === user.id ? 600 : 500, color: 'var(--text-main)' }}>{user.label}</span>
                                {selectedUser === user.id && <span style={{ width: '6px', height: '6px', background: 'var(--success)', borderRadius: '50%' }}></span>}
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>{user.role}</div>
                        </div>
                    ))}
                </div>

                <div style={{ marginTop: 'auto', paddingTop: '1rem', borderTop: '1px solid var(--border-subtle)', fontSize: '0.75rem', color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ width: '6px', height: '6px', background: 'var(--success)', borderRadius: '50%' }}></span>
                    Connected — port 8787
                </div>
            </aside>

            {/* Main */}
            <main style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <header style={{ height: '52px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 1.5rem', background: 'rgba(12,12,12,0.5)', backdropFilter: 'blur(8px)', flexShrink: 0 }}>
                    <div style={{ display: 'flex', gap: '4px' }}>
                        {(['permissions', 'files'] as const).map((tab) => (
                            <button key={tab} onClick={() => setActiveTab(tab)} style={{
                                padding: '5px 14px', borderRadius: '4px', fontSize: '0.85rem', fontWeight: 500, border: 'none', cursor: 'pointer',
                                ...(activeTab === tab ? { background: 'var(--accent)', color: 'white' } : { background: 'transparent', color: 'var(--text-dim)' })
                            }}>
                                {tab === 'permissions' ? 'Permissions' : 'File Browser'}
                            </button>
                        ))}
                    </div>
                    {activeTab === 'permissions' && (
                        <div style={{ display: 'flex', gap: '6px' }}>
                            {WORKSPACES.map((ws) => (
                                <button key={ws.id} onClick={() => setActiveWorkspace(ws.id)} style={{
                                    padding: '4px 10px', borderRadius: '4px', fontSize: '0.8rem', border: 'none', cursor: 'pointer',
                                    ...(activeWorkspace === ws.id ? { background: 'rgba(255,255,255,0.12)', color: 'var(--text-main)' } : { background: 'transparent', color: 'var(--text-dim)' })
                                }}>
                                    {ws.name}
                                </button>
                            ))}
                        </div>
                    )}
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-dim)' }}>
                        {currentUser.label} ({actor})
                    </div>
                </header>

                <div style={{ flexGrow: 1, overflowY: 'auto', padding: '1.5rem' }}>
                    {activeTab === 'permissions' ? (
                        <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
                            {loading ? (
                                <div className="card-base" style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-ghost)' }}>Loading...</div>
                            ) : snapshot ? (
                                <ZanzoProvider snapshot={snapshot} key={`${selectedUser}-${activeWorkspace}`}>
                                    <Suspense fallback={<div className="card-base" style={{ padding: '3rem', textAlign: 'center' }}>Hydrating...</div>}>
                                        <WorkspaceModules workspaceId={activeWorkspace} />
                                    </Suspense>
                                </ZanzoProvider>
                            ) : null}
                            <GrantAccess onGrant={() => fetchPermissions(selectedUser)} />
                        </div>
                    ) : (
                        <div style={{ height: '100%' }}>
                            <FileBrowser actor={actor} key={actor} />
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
