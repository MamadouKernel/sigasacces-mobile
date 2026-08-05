import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';

import { useEnrollmentStore } from '@/features/auth/enrollment.store';
import { useScanStore } from '@/features/scan/scan.store';
import { colors } from '@/theme/tokens';

export default function RootLayout() {
  const hydrate = useEnrollmentStore((s) => s.hydrate);
  const hydrateScans = useScanStore((s) => s.hydrate);

  // Une coupure réseau peut survenir terminal éteint : l'enrôlement, la liste
  // signée du jour et les scans en attente de resynchronisation sont donc
  // rechargés depuis le stockage sécurisé avant tout affichage.
  useEffect(() => {
    void hydrate();
    void hydrateScans();
  }, [hydrate, hydrateScans]);

  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.bg },
        }}
      />
    </>
  );
}
