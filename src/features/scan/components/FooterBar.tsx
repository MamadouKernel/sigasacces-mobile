import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useScanStore } from '@/features/scan/scan.store';
import { colors, font, spacing } from '@/theme/tokens';

export function FooterBar() {
  const degraded = useScanStore((s) => s.degraded);
  const scansToday = useScanStore((s) => s.scansToday);
  const lastSync = useScanStore((s) => s.lastSync);

  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.text}>
          Serveur central : {degraded ? 'injoignable — liste locale' : 'connecté'}
        </Text>
        <Text style={styles.text}>{scansToday} scan(s) ce poste</Text>
      </View>
      {lastSync ? <Text style={styles.sync}>{lastSync}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: 4,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  text: { fontSize: 10, fontFamily: font.mono, color: colors.muted },
  sync: { fontSize: 10, fontFamily: font.mono, color: colors.amber },
});
