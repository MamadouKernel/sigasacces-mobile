import { create } from 'zustand';

import { useEnrollmentStore } from '@/features/auth/enrollment.store';
import { api, errorMessage, setAgentToken, setSiteId, type SiteConfig, type SiteRef } from '@/lib/api';
import type { Agent, PostConfig } from '@/types/domain';

// Session de l'agent, distincte de l'enrôlement du terminal. Le PIN est
// transmis à shift/start puis oublié, jamais conservé ni comparé localement.
interface AuthState {
  agent: Agent | null;
  post: PostConfig | null;
  sites: SiteRef[];
  siteConfig: SiteConfig | null;
  busy: boolean;

  login: (matricule: string, pin: string) => Promise<{ ok: boolean; error?: string }>;
  loadPostOptions: () => Promise<{ ok: boolean; error?: string }>;
  selectSite: (site: SiteRef) => Promise<{ ok: boolean; error?: string }>;
  configurePost: (checkpoint: SiteRef) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  agent: null,
  post: null,
  sites: [],
  siteConfig: null,
  busy: false,

  login: async (matricule, pin) => {
    if (get().busy) return { ok: false, error: 'Connexion déjà en cours.' };
    set({ busy: true });
    try {
      const result = await api.shiftStart(matricule, pin);
      // sans jeton distinct, le jeton d'appareil continue de porter les requêtes
      if (result.token) setAgentToken(result.token);
      set({
        agent: { matricule: result.matricule, nom: result.nom, shiftId: result.shiftId },
        busy: false,
      });
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorMessage(err) };
    }
  },

  loadPostOptions: async () => {
    set({ busy: true });
    const enrollment = useEnrollmentStore.getState().enrollment;
    try {
      let sites: SiteRef[] = [];
      try {
        sites = await api.agentSites();
      } catch {
        // terminal mono-site : le site vient de l'enrôlement
        if (enrollment?.siteId) {
          sites = [{ id: enrollment.siteId, label: enrollment.siteLabel ?? enrollment.siteId }];
        }
      }

      const preselected =
        sites.find((s) => s.id === enrollment?.siteId) ?? (sites.length === 1 ? sites[0] : null);
      if (preselected) setSiteId(preselected.id);

      let siteConfig: SiteConfig | null = null;
      if (preselected || enrollment?.siteId) {
        siteConfig = await api.siteConfig();
      }

      set({ sites, siteConfig, busy: false });
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorMessage(err) };
    }
  },

  selectSite: async (site) => {
    setSiteId(site.id);
    set({ busy: true });
    try {
      const siteConfig = await api.siteConfig();
      set({ siteConfig, busy: false });
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorMessage(err) };
    }
  },

  configurePost: (checkpoint) => {
    const enrollment = useEnrollmentStore.getState().enrollment;
    const { sites, siteConfig } = get();
    const site = sites.find((s) => s.id === enrollment?.siteId) ?? sites[0];
    const siteId = site?.id ?? enrollment?.siteId ?? '';
    set({
      post: {
        siteId,
        siteLabel: siteConfig?.siteLabel ?? site?.label ?? enrollment?.siteLabel ?? siteId,
        checkpointId: checkpoint.id,
        checkpointLabel: checkpoint.label,
      },
    });
  },

  logout: () => {
    setAgentToken(null);
    set({ agent: null, post: null, siteConfig: null, sites: [] });
  },
}));
