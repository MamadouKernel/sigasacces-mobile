import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { api } from '@/lib/api';

// Affiche la notification même app AU PREMIER PLAN (comportement par défaut
// d'expo-notifications : rien ne s'affiche sans ce handler) — utile si le
// push arrive avant que le rafraîchissement local (scan.store.ts) n'ait
// détecté le même dépassement.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * Enregistre ce terminal pour les notifications push (§7 : alerte de
 * dépassement même app FERMÉE — le rafraîchissement local de scan.store.ts
 * ne couvre que l'app ouverte/arrière-plan vivant). Best-effort intégral :
 * permission refusée, pas de projectId, ou service Expo injoignable ne
 * doivent jamais bloquer la prise de poste.
 */
export async function registerForPushNotificationsAsync(): Promise<void> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('overstay', {
        name: 'Dépassements de durée',
        importance: Notifications.AndroidImportance.HIGH,
        sound: 'default',
      });
    }

    const current = await Notifications.getPermissionsAsync();
    let status = current.status;
    if (status !== 'granted') {
      const requested = await Notifications.requestPermissionsAsync();
      status = requested.status;
    }
    if (status !== 'granted') return;

    const projectId = Constants.expoConfig?.extra?.eas?.projectId as string | undefined;
    if (!projectId) return;

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    if (token) await api.setPushToken(token);
  } catch {
    // best-effort — voir commentaire ci-dessus
  }
}
