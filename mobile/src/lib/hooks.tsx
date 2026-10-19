import type { Session } from '@supabase/supabase-js';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import { supabase } from './supabase';
import type { AdOrder, CameraGroup, Catalog, Character, LedgerRow, Project, Scene, Shot } from './types';

// ---------------------------------------------------------------- session

const SessionCtx = createContext<{ session: Session | null; loading: boolean }>({ session: null, loading: true });

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);
  return <SessionCtx.Provider value={{ session, loading }}>{children}</SessionCtx.Provider>;
}

export const useSession = () => useContext(SessionCtx);

// ---------------------------------------------------------------- realtime helper

function useRealtime(channel: string, tables: { table: string; filter?: string }[], onChange: () => void, enabled = true) {
  const cb = useRef(onChange);
  useEffect(() => {
    cb.current = onChange;
  }, [onChange]);
  const key = JSON.stringify(tables);
  useEffect(() => {
    if (!enabled) return;
    let ch = supabase.channel(`${channel}-${Math.random().toString(36).slice(2)}`);
    for (const t of tables) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: t.table, filter: t.filter }, () => cb.current());
    }
    ch.subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, enabled]);
}

// ---------------------------------------------------------------- wallet

export function useWallet() {
  const { session } = useSession();
  const userId = session?.user.id;
  const [balance, setBalance] = useState<number | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const load = useCallback(() => {
    if (!userId) return Promise.resolve();
    return Promise.all([
      supabase.from('wallets').select('balance').eq('user_id', userId).maybeSingle(),
      supabase.from('credit_ledger').select('id,delta,kind,note,balance_after,created_at').order('created_at', { ascending: false }).limit(50),
    ]).then(([w, l]) => {
      setBalance(w.data?.balance ?? 0);
      setLedger((l.data as LedgerRow[]) ?? []);
    });
  }, [userId]);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);
  useRealtime('wallet', [{ table: 'wallets', filter: `user_id=eq.${userId}` }], load, Boolean(userId));
  return { balance, ledger, reload: load };
}

// ---------------------------------------------------------------- catalog (prices)

let catalogCache: Catalog | null = null;
export function useCatalog() {
  const [cat, setCat] = useState<Catalog | null>(catalogCache);
  useEffect(() => {
    if (catalogCache) return;
    api
      .catalog()
      .then((c) => {
        catalogCache = c;
        setCat(c);
      })
      .catch(() => undefined);
  }, []);
  return cat;
}

// ---------------------------------------------------------------- projects

export function useProjects() {
  const { session } = useSession();
  const [projects, setProjects] = useState<Project[] | null>(null);
  const load = useCallback(
    () =>
      supabase
        .from('projects')
        .select('*')
        .order('updated_at', { ascending: false })
        .then((res) => setProjects((res.data as Project[]) ?? [])),
    [],
  );
  useEffect(() => {
    if (session) load();
  }, [session, load]);
  useRealtime('projects', [{ table: 'projects', filter: `user_id=eq.${session?.user.id}` }], load, Boolean(session));
  return { projects, reload: load };
}

export interface ProjectData {
  project: Project | null;
  characters: Character[];
  scenes: Scene[];
  shots: Shot[];
}

export function useProject(id: string | undefined) {
  const [data, setData] = useState<ProjectData>({ project: null, characters: [], scenes: [], shots: [] });
  const [loading, setLoading] = useState(true);
  const load = useCallback(() => {
    if (!id) return Promise.resolve();
    return Promise.all([
      supabase.from('projects').select('*').eq('id', id).maybeSingle(),
      supabase.from('characters').select('*').eq('project_id', id).order('idx'),
      supabase.from('scenes').select('*').eq('project_id', id).order('idx'),
      supabase.from('shots').select('*').eq('project_id', id).order('idx'),
    ]).then(([p, c, sc, sh]) => {
      setData({
        project: (p.data as Project) ?? null,
        characters: (c.data as Character[]) ?? [],
        scenes: (sc.data as Scene[]) ?? [],
        shots: (sh.data as Shot[]) ?? [],
      });
      setLoading(false);
    });
  }, [id]);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);

  // Coalesce bursts of realtime events (a plan inserts dozens of rows at once).
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 300);
  }, [load]);
  useRealtime(
    'project',
    [
      { table: 'projects', filter: `id=eq.${id}` },
      { table: 'shots', filter: `project_id=eq.${id}` },
      { table: 'characters', filter: `project_id=eq.${id}` },
    ],
    soon,
    Boolean(id),
  );
  return { ...data, loading, reload: load };
}

// ---------------------------------------------------------------- Director (paying users)

/** True once the user has bought any credit pack. Re-checked whenever the wallet changes. */
export function useDirectorAccess() {
  const { session } = useSession();
  const userId = session?.user.id;
  const [access, setAccess] = useState<boolean | null>(null);
  const load = useCallback(() => {
    if (!userId) return Promise.resolve();
    return Promise.resolve(
      supabase
        .from('profiles')
        .select('director_access')
        .eq('id', userId)
        .maybeSingle()
        .then((r) => setAccess(Boolean(r.data?.director_access))),
    );
  }, [userId]);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);
  useRealtime('director-wallet', [{ table: 'wallets', filter: `user_id=eq.${userId}` }], load, Boolean(userId));
  return access;
}

let libraryCache: CameraGroup[] | null = null;
export function useCameraLibrary() {
  const [groups, setGroups] = useState<CameraGroup[] | null>(libraryCache);
  useEffect(() => {
    if (libraryCache) return;
    api
      .cameraLibrary()
      .then((r) => {
        libraryCache = r.groups;
        setGroups(r.groups);
      })
      .catch(() => undefined);
  }, []);
  return groups;
}

// ---------------------------------------------------------------- studio operator (shop-ad orders)

export function useRole() {
  const { session } = useSession();
  const userId = session?.user.id;
  const [role, setRole] = useState<'user' | 'operator' | null>(null);
  useEffect(() => {
    if (!userId) return;
    Promise.resolve(
      supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .maybeSingle()
        .then((r) => setRole((r.data?.role as 'user' | 'operator') ?? 'user')),
    ).catch(() => undefined);
  }, [userId]);
  return role;
}

export function useOrders() {
  const { session } = useSession();
  const [orders, setOrders] = useState<AdOrder[] | null>(null);
  const load = useCallback(
    () =>
      Promise.resolve(
        supabase
          .from('ad_orders')
          .select('*')
          .order('created_at', { ascending: false })
          .then((r) => setOrders((r.data as AdOrder[]) ?? [])),
      ),
    [],
  );
  useEffect(() => {
    if (session) load().catch(() => undefined);
  }, [session, load]);
  useRealtime('orders', [{ table: 'ad_orders', filter: `user_id=eq.${session?.user.id}` }], load, Boolean(session));
  return { orders, reload: load };
}

export function useOrder(id: string | undefined) {
  const [order, setOrder] = useState<AdOrder | null>(null);
  const load = useCallback(() => {
    if (!id) return Promise.resolve();
    return Promise.resolve(
      supabase
        .from('ad_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle()
        .then((r) => setOrder((r.data as AdOrder) ?? null)),
    );
  }, [id]);
  useEffect(() => {
    load().catch(() => undefined);
  }, [load]);
  useRealtime('order', [{ table: 'ad_orders', filter: `id=eq.${id}` }], load, Boolean(id));
  return { order, reload: load };
}
