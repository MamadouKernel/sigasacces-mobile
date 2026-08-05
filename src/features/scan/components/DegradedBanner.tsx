import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ttlLabel, useScanStore } from '@/features/scan/scan.store';
import { colors, font, spacing } from '@/theme/tokens';

export function DegradedBanner() {
  const degraded = useScanStore((s) => s.degraded);
  const expiresAt = useScanStore((s) => s.offlineListExpiresAt);
  const ttlExpired = useScanStore((s) => s.ttlExpired);
  const pending = useScanStore((s) => s.pending.length);
  const [, tick] = useState(0);

  useEffect(() => {
    if (!degraded) return;
    const timer = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(timer);
  }, [degraded]);

  if (!degraded) return null;

  return (
    <View style={styles.banner}>
      <Text style={styles.text}>
        MODE DÉGRADÉ — liste locale signée du jour{'\n'}
        Expiration : {ttlLabel(expiresAt, ttlExpired)}
        {pending > 0 ? ` · ${pending} validation(s) à resynchroniser` : ''}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  banner: {
    backgroundColor: colors.amberDim,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(245,163,0,.4)',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  text: { color: colors.amber, fontSize: 11, fontFamily: font.mono, lineHeight: 16 },
});
