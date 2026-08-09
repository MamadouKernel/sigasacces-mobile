import React, { useEffect, useState } from 'react';
import { AppState, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuthStore } from '@/features/auth/auth.store';
import { AppHeader } from '@/features/scan/components/AppHeader';
import { DayListSheet } from '@/features/scan/components/DayListSheet';
import { DegradedBanner } from '@/features/scan/components/DegradedBanner';
import { FooterBar } from '@/features/scan/components/FooterBar';
import { ManualCodeSheet } from '@/features/scan/components/ManualCodeSheet';
import { TopStatusRow } from '@/features/scan/components/TopStatusRow';
import { VerdictOverlay } from '@/features/scan/components/VerdictOverlay';
import { Viewfinder } from '@/features/scan/components/Viewfinder';
import { useScanStore } from '@/features/scan/scan.store';
import { connectRealtime, disconnectRealtime } from '@/lib/realtime';
import { colors } from '@/theme/tokens';

const HEALTH_INTERVAL_MS = 30_000;
const DAY_LIST_INTERVAL_MS = 15 * 60_000;
const PENDING_CONFIRMATION_POLL_MS = 5_000;

export function ScannerScreen() {
  const verdict = useScanStore((s) => s.verdict);
  const scanPayload = useScanStore((s) => s.scanPayload);
  const checkConnectivity = useScanStore((s) => s.checkConnectivity);
  const refreshDayList = useScanStore((s) => s.refreshDayList);
  const pendingConfirmationCount = useScanStore((s) => s.pendingConfirmations.size);
  const siteId = useAuthStore((s) => s.post?.siteId);
  const [listOpen, setListOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  // seul un appel effectif à l'API fait foi pour basculer en dégradé ou en sortir
  useEffect(() => {
    void checkConnectivity();
    const timer = setInterval(() => void checkConnectivity(), HEALTH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [checkConnectivity]);

  // Chargement immédiat au montage : sans lui, l'agent ne voyait la liste des
  // attendus qu'après le premier déclenchement de l'intervalle (15 min) — un
  // setInterval seul ne s'exécute jamais immédiatement.
  useEffect(() => {
    void refreshDayList();
    const timer = setInterval(() => void refreshDayList(), DAY_LIST_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refreshDayList]);

  // Sondage RAPIDE pendant qu'au moins une demande de confirmation est en
  // attente : l'agent et le visiteur attendent physiquement à la porte, un
  // délai de 15 min (ci-dessus) serait perçu comme un système en panne. Le
  // push de résolution (voir pushToken.ts, ConfirmationNotifier côté API)
  // couvre déjà la plupart des cas, mais dépend de la permission
  // notifications ET d'un jeton Expo valide enregistré — silencieusement
  // absent sinon (best-effort). Ce filet garantit une mise à jour en
  // quelques secondes même sans push, et s'arrête de lui-même dès qu'il n'y
  // a plus de demande en attente (pas de sondage inutile en continu).
  useEffect(() => {
    if (pendingConfirmationCount === 0) return;
    const timer = setInterval(() => void refreshDayList(), PENDING_CONFIRMATION_POLL_MS);
    return () => clearInterval(timer);
  }, [pendingConfirmationCount, refreshDayList]);

  // Temps réel (SignalR, /hubs/scan-events) : complète les sondages ci-dessus
  // sans les remplacer — voir lib/realtime.ts. Sur mobile, une connexion
  // persistante ne survit pas fiablement à une mise en arrière-plan (le
  // runtime JS est suspendu par l'OS, la socket peut mourir en silence sans
  // déclencher onclose) : plutôt que de faire confiance à la reconnexion
  // automatique de SignalR dans ce cas précis, on ferme explicitement en
  // arrière-plan et on reconnecte à froid au retour au premier plan — moins
  // fragile qu'une reconnexion sur un état incertain.
  useEffect(() => {
    if (!siteId) {
      disconnectRealtime();
      return;
    }

    const onSignal = () => void refreshDayList();
    connectRealtime(siteId, onSignal);

    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        connectRealtime(siteId, onSignal);
        void refreshDayList(); // rattrape ce qui a pu être manqué pendant la coupure
      } else {
        disconnectRealtime();
      }
    });

    return () => {
      subscription.remove();
      disconnectRealtime();
    };
  }, [siteId, refreshDayList]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <TopStatusRow />
      <AppHeader
        onOpenList={() => setListOpen(true)}
        onOpenManual={() => setManualOpen(true)}
      />
      <DegradedBanner />

      <View style={styles.stage}>
        <Viewfinder
          paused={verdict !== null || listOpen || manualOpen}
          onScanned={(payload) => void scanPayload(payload)}
        />
        <VerdictOverlay />
      </View>

      <FooterBar />

      <DayListSheet visible={listOpen} onClose={() => setListOpen(false)} />
      <ManualCodeSheet visible={manualOpen} onClose={() => setManualOpen(false)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  stage: { flex: 1, position: 'relative' },
});
