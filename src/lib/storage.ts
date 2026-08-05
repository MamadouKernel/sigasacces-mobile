import { Platform } from 'react-native';

/**
 * Stockage clé/valeur chiffré (Keystore Android / Keychain iOS) via
 * expo-secure-store. Sur le web (démo uniquement), repli sur localStorage.
 *
 * Le module natif est chargé paresseusement : s'il est absent du binaire
 * installé (dev client construit avant l'ajout d'expo-secure-store), l'app
 * NE PLANTE PAS — elle bascule sur un stockage mémoire, et l'enrôlement ne
 * survit simplement pas au redémarrage tant que le client n'est pas
 * reconstruit (`npx expo run:android` / build EAS, ou Expo Go qui l'embarque).
 */

type SecureStoreModule = typeof import('expo-secure-store');

let secureStore: SecureStoreModule | null | undefined;

/** Le runtime Expo expose les modules natifs sur `globalThis.expo.modules`. */
function nativeModuleAvailable(): boolean {
  const expoGlobal = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  return Boolean(expoGlobal?.modules?.ExpoSecureStore);
}

function getSecureStore(): SecureStoreModule | null {
  if (secureStore === undefined) {
    // Vérifier la présence du module natif AVANT le require : requérir
    // expo-secure-store sans lui lève « Cannot find native module ».
    if (!nativeModuleAvailable()) {
      secureStore = null;
      return secureStore;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      secureStore = require('expo-secure-store') as SecureStoreModule;
    } catch {
      secureStore = null;
    }
  }
  return secureStore;
}

/** Repli non persistant quand aucun stockage n'est disponible. */
const memory = new Map<string, string>();

export async function getItem(key: string): Promise<string | null> {
  if (Platform.OS === 'web') {
    try {
      return globalThis.localStorage?.getItem(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  }
  const store = getSecureStore();
  if (store) {
    try {
      return await store.getItemAsync(key);
    } catch {
      /* valeur illisible (clé matérielle changée…) : considérer absente */
    }
  }
  return memory.get(key) ?? null;
}

export async function setItem(key: string, value: string): Promise<void> {
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.setItem(key, value);
      return;
    } catch {
      memory.set(key, value);
      return;
    }
  }
  const store = getSecureStore();
  if (store) {
    try {
      await store.setItemAsync(key, value);
      return;
    } catch {
      /* stockage sécurisé indisponible : repli mémoire ci-dessous */
    }
  }
  memory.set(key, value);
}

export async function deleteItem(key: string): Promise<void> {
  memory.delete(key);
  if (Platform.OS === 'web') {
    try {
      globalThis.localStorage?.removeItem(key);
    } catch {
      /* rien à supprimer */
    }
    return;
  }
  const store = getSecureStore();
  if (store) {
    try {
      await store.deleteItemAsync(key);
    } catch {
      /* rien à supprimer */
    }
  }
}
