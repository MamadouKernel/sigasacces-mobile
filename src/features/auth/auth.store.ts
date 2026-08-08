import { create } from 'zustand';

import { soleSiteId, useEnrollmentStore } from '@/features/auth/enrollment.store';
import {
  api,
  currentShiftToken,
  errorMessage,
  setShiftToken,
  setSiteId,
  type SiteConfig,
  type SiteRef,
} from '@/lib/api';
import { registerForPushNotificationsAsync } from '@/lib/pushToken';
import type { Agent, PostConfig } from '@/types/domain';

// Session de l'agent, distincte de l'enrôlement du terminal. Le PIN est
// transmis à shift/start puis oublié, jamais conservé ni comparé localement.
interface AuthState {
  agent: Agent | null;
  post: PostConfig | null;
  sites: SiteRef[];
  selectedSiteId: string | null;
  siteConfig: SiteConfig | null;
  busy: boolean;

  login: (matricule: string, pin: string) => Promise<{ ok: boolean; error?: string }>;
  loadPostOptions: () => Promise<{ ok: boolean; error?: string }>;
  selectSite: (site: SiteRef) => Promise<{ ok: boolean; error?: string }>;
  configurePost: (checkpoint: SiteRef) => void;
  logout: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  agent: null,
  post: null,
  sites: [],
  selectedSiteId: null,
  siteConfig: null,
  busy: false,

  login: async (matricule, pin) => {
    if (get().busy) return { ok: false, error: 'Connexion déjà en cours.' };
    set({ busy: true });
    try {
      const result = await api.shiftStart(matricule, pin);
      setShiftToken(result.shiftToken);
      set({
        agent: { matricule: result.matricule, nom: result.displayName },
        busy: false,
      });
      // Non bloquant : la prise de poste ne doit jamais attendre après la
      // permission système ni le service push d'Expo (§7).
      void registerForPushNotificationsAsync();
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
      // Le serveur ne renvoie que des identifiants ; le libellé du site n'arrive
      // qu'avec GET /api/site/config, une fois le site retenu.
      let siteIds: string[] = [];
      try {
        siteIds = await api.agentSites();
      } catch {
        siteIds = enrollment?.siteIds ?? [];
      }
      const sites: SiteRef[] = siteIds.map((id) => ({ id, label: id }));

      const preselected = sites.length === 1 ? sites[0] : null;
      if (preselected) setSiteId(preselected.id);

      let siteConfig: SiteConfig | null = null;
      if (preselected) siteConfig = await api.siteConfig();

      set({ sites, selectedSiteId: preselected?.id ?? null, siteConfig, busy: false });
      return { ok: true };
    } catch (err) {
      set({ busy: false });
      return { ok: false, error: errorMessage(err) };
    }
  },

  selectSite: async (site) => {
    setSiteId(site.id);
    set({ busy: true, selectedSiteId: site.id });
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
    const { selectedSiteId, siteConfig } = get();
    const siteId = selectedSiteId ?? soleSiteId(enrollment) ?? '';
    set({
      post: {
        siteId,
        siteLabel: siteConfig?.siteLabel ?? siteId,
        checkpointId: checkpoint.id,
        checkpointLabel: checkpoint.label,
      },
    });
  },

  // Sans cet appel, le poste resté ouvert continue d'attribuer les scans au
  // matricule parti jusqu'à l'expiration naturelle du jeton.
  logout: async () => {
    const token = currentShiftToken();
    setShiftToken(null);
    set({ agent: null, post: null, siteConfig: null, sites: [], selectedSiteId: null });
    if (!token) return;
    try {
      await api.shiftEnd(token);
    } catch {
      // idempotent côté serveur : le poste sera clos au prochain shift/start
    }
  },
}));
