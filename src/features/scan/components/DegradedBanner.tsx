import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ttlLabel, useScanStore } from '@/features/scan/scan.store';
import { colors, font, spacing } from '@/theme/tokens';

/**
 * Bandeau du mode dégradé. Il affiche l'échéance du TTL car passé ce délai
 * plus aucune validation hors ligne n'est possible (REQ-SEC-06) : l'agent doit
 * pouvoir anticiper, pas le découvrir au moment d'un refus.
 */
export function DegradedBanner() {
  const degraded = useScanStore((s) => s.degraded);
  const expiresAt = useScanStore((s) => s.offlineListExpiresAt);
  const ttlExpired = useScanStore((s) => s.ttlExpired);
  const pending = useScanStore((s) => s.pending.length);
  const [, tick] = useState(0);

  // Le compte à rebours doit rester lisible sans action de l'agent.
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
