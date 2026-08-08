import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { AppHeader } from '@/features/scan/components/AppHeader';
import { DayListSheet } from '@/features/scan/components/DayListSheet';
import { DegradedBanner } from '@/features/scan/components/DegradedBanner';
import { FooterBar } from '@/features/scan/components/FooterBar';
import { ManualCodeSheet } from '@/features/scan/components/ManualCodeSheet';
import { TopStatusRow } from '@/features/scan/components/TopStatusRow';
import { VerdictOverlay } from '@/features/scan/components/VerdictOverlay';
import { Viewfinder } from '@/features/scan/components/Viewfinder';
import { useScanStore } from '@/features/scan/scan.store';
import { colors } from '@/theme/tokens';

const HEALTH_INTERVAL_MS = 30_000;
const DAY_LIST_INTERVAL_MS = 15 * 60_000;

export function ScannerScreen() {
  const verdict = useScanStore((s) => s.verdict);
  const scanPayload = useScanStore((s) => s.scanPayload);
  const checkConnectivity = useScanStore((s) => s.checkConnectivity);
  const refreshDayList = useScanStore((s) => s.refreshDayList);
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
