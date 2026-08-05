import { Platform } from 'react-native';

// SecureStore (Keystore/Keychain), repli localStorage sur le web et mémoire
// si le module natif est absent du binaire — l'enrôlement ne survit alors pas
// au redémarrage, mais l'app démarre.

type SecureStoreModule = typeof import('expo-secure-store');

let secureStore: SecureStoreModule | null | undefined;

function nativeModuleAvailable(): boolean {
  const expoGlobal = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  return Boolean(expoGlobal?.modules?.ExpoSecureStore);
}

function getSecureStore(): SecureStoreModule | null {
  if (secureStore === undefined) {
    // tester avant le require : sinon « Cannot find native module »
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
      // repli mémoire ci-dessous
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
      // rien à supprimer
    }
    return;
  }
  const store = getSecureStore();
  if (store) {
    try {
      await store.deleteItemAsync(key);
    } catch {
      // rien à supprimer
    }
  }
}
