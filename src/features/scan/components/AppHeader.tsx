import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import { IconButton } from '@/components/ui/IconButton';
import { Logo } from '@/components/ui/Logo';
import { useAuthStore } from '@/features/auth/auth.store';
import { useScanStore } from '@/features/scan/scan.store';
import { colors, font, radius, spacing } from '@/theme/tokens';

interface Props {
  onOpenList: () => void;
}

export function AppHeader({ onOpenList }: Props) {
  const { agent, post, logout } = useAuthStore();
  const direction = useScanStore((s) => s.direction);
  const haptics = useScanStore((s) => s.haptics);
  const toggleDirection = useScanStore((s) => s.toggleDirection);
  const toggleHaptics = useScanStore((s) => s.toggleHaptics);
  const [moreOpen, setMoreOpen] = useState(false);

  const isEntry = direction === 'entree';
  const dirColor = isEntry ? colors.okBright : colors.amber;

  const confirmLogout = () => {
    Alert.alert(
      'Quitter le poste ?',
      'La session sera fermée. Les scans déjà effectués restent journalisés.',
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Quitter', style: 'destructive', onPress: logout },
      ],
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={styles.topRow}>
        <Logo />
        <View style={styles.site}>
          <Text style={styles.siteText}>{post?.siteLabel}</Text>
          <Text style={styles.siteText}>
            {post?.checkpointLabel} · {agent?.matricule}
          </Text>
        </View>
        <IconButton
          label="⋯"
          onPress={() => setMoreOpen((v) => !v)}
          active={moreOpen}
          color={colors.muted}
        />
      </View>

      <View style={styles.actionsRow}>
        <Pressable
          onPress={toggleDirection}
          accessibilityRole="button"
          accessibilityLabel={`Sens du poste : ${isEntry ? 'entrée' : 'sortie'}. Appuyer pour basculer.`}
          style={({ pressed }) => [
            styles.dirBtn,
            { borderColor: dirColor, backgroundColor: `${dirColor}1F` },
            pressed && { opacity: 0.75 },
          ]}>
          <Text style={[styles.dirLabel, { color: dirColor }]}>
            {isEntry ? '⇢ ENTRÉE' : '⇠ SORTIE'}
          </Text>
        </Pressable>
        <IconButton label="Attendus" onPress={onOpenList} />
      </View>

      {moreOpen ? (
        <View style={styles.moreRow}>
          <IconButton
            label={haptics ? 'Vib. on' : 'Vib. off'}
            onPress={toggleHaptics}
            active={haptics}
          />
          <IconButton label="Quitter" onPress={confirmLogout} color={colors.muted} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  site: { marginLeft: 'auto', alignItems: 'flex-end' },
  siteText: { fontSize: 10, fontFamily: font.mono, color: colors.muted },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: spacing.sm,
  },
  dirBtn: {
    flex: 1,
    borderWidth: 1,
    borderRadius: radius.sm,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dirLabel: { fontSize: 15, fontWeight: '700', letterSpacing: 1 },
  moreRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
});
