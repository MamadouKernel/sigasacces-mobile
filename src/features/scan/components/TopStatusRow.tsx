import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { StatusDot } from '@/components/ui/StatusDot';
import { useScanStore } from '@/features/scan/scan.store';
import { fmt } from '@/lib/time';
import { colors, font, spacing } from '@/theme/tokens';

export function TopStatusRow() {
  const degraded = useScanStore((s) => s.degraded);
  const [clock, setClock] = useState(() => fmt(Date.now()));

  useEffect(() => {
    const timer = setInterval(() => setClock(fmt(Date.now())), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <View style={styles.row}>
      <Text style={styles.text}>{clock}</Text>
      <View style={styles.net}>
        <StatusDot online={!degraded} />
        <Text style={styles.text}>{degraded ? 'HORS LIGNE' : 'EN LIGNE'}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  net: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  text: { fontSize: 11, fontFamily: font.mono, color: colors.muted },
});
