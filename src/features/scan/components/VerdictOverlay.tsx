import React, { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { useScanStore } from '@/features/scan/scan.store';
import { colors, font, spacing } from '@/theme/tokens';

const AUTO_CLOSE_MS = 6500;

const BG: Record<string, string> = {
  ok: colors.ok,
  out: colors.out,
  no: colors.no,
};

const ICON: Record<string, string> = { ok: '✓', out: '⇥', no: '✕' };

export function VerdictOverlay() {
  const verdict = useScanStore((s) => s.verdict);
  const closeVerdict = useScanStore((s) => s.closeVerdict);

  const [appear] = useState(() => new Animated.Value(0));
  const [countdown] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!verdict) return;
    appear.setValue(0);
    countdown.setValue(1);
    Animated.timing(appear, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    Animated.timing(countdown, {
      toValue: 0,
      duration: AUTO_CLOSE_MS,
      useNativeDriver: false,
    }).start();
    const timer = setTimeout(closeVerdict, AUTO_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [verdict, closeVerdict, appear, countdown]);

  if (!verdict) return null;

  return (
    <Animated.View
      accessibilityLiveRegion="assertive"
      style={[
        styles.overlay,
        { backgroundColor: BG[verdict.kind], opacity: appear },
      ]}>
      <Animated.View
        style={{
          alignItems: 'center',
          transform: [
            { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) },
          ],
        }}>
        <View style={styles.icon}>
          <Text style={styles.iconText}>{ICON[verdict.kind]}</Text>
        </View>
        <Text style={styles.title}>{verdict.title}</Text>
        <Text style={styles.who}>{verdict.who}</Text>
        <Text style={styles.detail}>{verdict.detail}</Text>
        {verdict.reason ? (
          <View style={styles.reason}>
            <Text style={styles.reasonText}>{verdict.reason}</Text>
          </View>
        ) : null}
        {verdict.kind === 'ok' ? (
          <View style={styles.idCheck}>
            <Text style={styles.idCheckText}>
              👤 Vérifier l’identité du porteur (le QR est transférable)
            </Text>
          </View>
        ) : null}
        {verdict.degraded && verdict.kind !== 'no' ? (
          <View style={styles.degBadge}>
            <Text style={styles.degText}>VALIDÉ EN MODE DÉGRADÉ — À RESYNCHRONISER</Text>
          </View>
        ) : null}
        <Pressable style={styles.back} onPress={closeVerdict} accessibilityRole="button">
          <Text style={styles.backText}>Scanner le suivant</Text>
        </Pressable>
      </Animated.View>

      <View style={styles.countdownTrack}>
        <Animated.View
          style={[
            styles.countdownBar,
            {
              width: countdown.interpolate({
                inputRange: [0, 1],
                outputRange: ['0%', '100%'],
              }),
            },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.xl,
    zIndex: 5,
  },
  icon: {
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: 'rgba(255,255,255,.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: { fontSize: 44, color: '#fff' },
  title: {
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: 1.5,
    color: '#fff',
    marginTop: spacing.md,
    textAlign: 'center',
  },
  who: { color: 'rgba(255,255,255,.95)', marginTop: spacing.lg, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  detail: { color: 'rgba(255,255,255,.85)', fontSize: 13, marginTop: spacing.xs, textAlign: 'center' },
  reason: {
    marginTop: spacing.md,
    backgroundColor: 'rgba(0,0,0,.22)',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 4,
  },
  reasonText: { color: '#fff', fontFamily: font.mono, fontSize: 11, textAlign: 'center' },
  idCheck: {
    marginTop: spacing.md,
    backgroundColor: 'rgba(255,255,255,.14)',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 4,
  },
  idCheckText: { color: '#fff', fontSize: 12, fontWeight: '600', textAlign: 'center' },
  degBadge: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: 'rgba(255,255,255,.6)',
    paddingHorizontal: 9,
    paddingVertical: 3,
    borderRadius: 3,
  },
  degText: { color: '#FFE2A8', fontFamily: font.mono, fontSize: 10 },
  back: {
    marginTop: spacing.xl,
    backgroundColor: 'rgba(255,255,255,.92)',
    paddingHorizontal: 26,
    paddingVertical: 12,
    minHeight: 48,
    justifyContent: 'center',
    borderRadius: 6,
  },
  backText: { fontWeight: '700', color: '#10161D', fontSize: 15 },
  countdownTrack: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 3,
    backgroundColor: 'rgba(0,0,0,.25)',
  },
  countdownBar: { height: 3, backgroundColor: 'rgba(255,255,255,.85)' },
});
