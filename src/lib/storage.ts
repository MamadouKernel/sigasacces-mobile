import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

// SecureStore (Keystore/Keychain), repli localStorage sur le web et mémoire
// si le module natif est absent du binaire — l'enrôlement ne survit alors pas
// au redémarrage, mais l'app démarre.

type SecureStoreModule = typeof import('expo-secure-store');

let secureStore: SecureStoreModule | null | undefined;

// Sonder avec requireOptionalNativeModule, qui installe les modules natifs
// avant de répondre. Lire `globalThis.expo.modules` directement se fait avant
// cette installation et rend toujours undefined : le terminal retombait
// silencieusement en mémoire volatile, et perdait son enrôlement à chaque
// redémarrage sans qu'aucune erreur ne le signale.
function getSecureStore(): SecureStoreModule | null {
  if (secureStore === undefined) {
    secureStore = requireOptionalNativeModule('ExpoSecureStore')
      ? // eslint-disable-next-line @typescript-eslint/no-require-imports
        (require('expo-secure-store') as SecureStoreModule)
      : null;
  }
  return secureStore;
}

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
      // valeur illisible : considérer absente
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
      // repli mémoire
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
      // clé déjà absente
    }
    return;
  }
  const store = getSecureStore();
  if (store) {
    try {
      await store.deleteItemAsync(key);
    } catch {
      // clé déjà absente
    }
  }
}
