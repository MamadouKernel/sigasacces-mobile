import * as Device from 'expo-device';
import { Platform } from 'react-native';

import { api } from '@/lib/api';

/**
 * Remonte un libellé lisible du terminal physique (§ « un poste peut avoir
 * N terminaux ») — sert UNIQUEMENT à ce que l'Admin distingue visuellement
 * quel boîtier correspond à quel terminal dans la console (AdminTerminaux).
 * Ce n'est PAS un identifiant de sécurité : voir DeviceInstanceId (lié
 * cryptographiquement à l'enrôlement) pour ça. Best-effort intégral, comme
 * l'enregistrement du jeton push.
 */
export async function reportDeviceInfoAsync(): Promise<void> {
  try {
    const parts = [
      Device.manufacturer ?? Device.brand,
      Device.modelName,
    ].filter((p): p is string => !!p && p.trim().length > 0);

    const os = `${Device.osName ?? Platform.OS}${Device.osVersion ? ` ${Device.osVersion}` : ''}`;
    const label = [parts.join(' '), os].filter((p) => p.trim().length > 0).join(' · ');

    if (label.trim().length > 0) await api.setDeviceInfo(label.trim());
  } catch {
    // best-effort — voir commentaire ci-dessus
  }
}
