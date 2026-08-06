import { useRouter } from 'expo-router';
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { useAuthStore } from '@/features/auth/auth.store';
import { soleSiteId, useEnrollmentStore } from '@/features/auth/enrollment.store';
import { useScanStore } from '@/features/scan/scan.store';
import type { SiteRef } from '@/lib/api';
import { colors, font, radius, spacing } from '@/theme/tokens';

export function ConfigPosteScreen() {
  const router = useRouter();
  const agent = useAuthStore((s) => s.agent);
  const sites = useAuthStore((s) => s.sites);
  const siteConfig = useAuthStore((s) => s.siteConfig);
  const busy = useAuthStore((s) => s.busy);
  const loadPostOptions = useAuthStore((s) => s.loadPostOptions);
  const selectSite = useAuthStore((s) => s.selectSite);
  const configurePost = useAuthStore((s) => s.configurePost);
  const logout = useAuthStore((s) => s.logout);
  const selectedSiteId = useAuthStore((s) => s.selectedSiteId);
  const enrollment = useEnrollmentStore((s) => s.enrollment);
  const refreshDayList = useScanStore((s) => s.refreshDayList);

  const [error, setError] = useState<string | null>(null);
  const [checkpoint, setCheckpoint] = useState<SiteRef | null>(null);

  const load = useCallback(async () => {
    const res = await loadPostOptions();
    setError(res.ok ? null : (res.error ?? 'Configuration du site indisponible.'));
  }, [loadPostOptions]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  const checkpoints = siteConfig?.checkpoints ?? [];
  const multiSite = sites.length > 1;
  const siteLabel = siteConfig?.siteLabel ?? soleSiteId(enrollment) ?? sites[0]?.label ?? '—';

  const chooseSite = async (site: SiteRef) => {
    const res = await selectSite(site);
    setError(res.ok ? null : (res.error ?? 'Configuration du site indisponible.'));
    setCheckpoint(null);
  };

  const submit = () => {
    if (!checkpoint) return;
    configurePost(checkpoint);
    // liste signée chargée dès l'ouverture : c'est elle qui validera hors ligne
    void refreshDayList();
    router.replace('/scanner');
  };

  const switchAccount = () => {
    void logout();
    router.replace('/login');
  };

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <View style={styles.card}>
        <Logo size={24} />
        <Text style={styles.title}>Ouverture du poste</Text>
        <Text style={styles.who}>
          Agent : {agent?.nom ?? '—'} · <Text style={styles.mono}>{agent?.matricule}</Text>
        </Text>

        <View style={styles.field}>
          <Text style={styles.label}>Site</Text>
          {multiSite ? (
            sites.map((site) => {
              const selected = selectedSiteId === site.id;
              return (
                <Pressable
                  key={site.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={[styles.option, selected && styles.optionSelected]}
                  onPress={() => void chooseSite(site)}>
                  <Text style={styles.optionText}>{site.label}</Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })
          ) : (
            <View style={[styles.option, styles.optionSelected]}>
              <Text style={styles.optionText}>{siteLabel}</Text>
              <Text style={styles.check}>✓</Text>
            </View>
          )}
        </View>

        <View style={styles.field}>
          <Text style={styles.label}>Poste de contrôle</Text>
          {busy ? (
            <ActivityIndicator color={colors.amber} />
          ) : checkpoints.length === 0 ? (
            <Text style={styles.empty}>
              Aucun poste de contrôle n&apos;est configuré pour ce site. Le scan
              ne peut pas être tracé sans poste : contactez l&apos;Admin
              Sigasécurité avant d&apos;ouvrir le poste.
            </Text>
          ) : (
            checkpoints.map((point) => {
              const selected = checkpoint?.id === point.id;
              return (
                <Pressable
                  key={point.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  style={[styles.option, selected && styles.optionSelected]}
                  onPress={() => setCheckpoint(point)}>
                  <Text style={styles.optionText}>{point.label}</Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })
          )}
        </View>

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Button
          label="Ouvrir le poste"
          variant="accent"
          onPress={submit}
          disabled={!checkpoint || busy}
        />
        {error || checkpoints.length === 0 ? (
          <Button label="Réessayer" onPress={() => void load()} disabled={busy} />
        ) : null}

        <Text style={styles.note}>
          Le sens du poste (entrée / sortie) se bascule ensuite directement depuis
          l’écran de scan.
        </Text>

        <Pressable onPress={switchAccount} hitSlop={8} accessibilityRole="button">
          <Text style={styles.switchAccount}>Changer de compte</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    padding: spacing.xl,
  },
  card: { gap: spacing.lg },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  who: { color: colors.muted, fontSize: 13 },
  mono: { fontFamily: font.mono, color: colors.text },
  field: { gap: spacing.sm },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.muted,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    padding: spacing.md,
    minHeight: 48,
    backgroundColor: colors.surface,
  },
  optionSelected: { borderColor: colors.amber, backgroundColor: colors.amberDim },
  optionText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  check: { color: colors.amber, fontSize: 15, fontWeight: '700' },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: {
    color: colors.redChip,
    fontSize: 13,
    backgroundColor: 'rgba(224,106,106,.1)',
    borderWidth: 1,
    borderColor: 'rgba(224,106,106,.35)',
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  note: { color: colors.muted, fontSize: 11, textAlign: 'center', lineHeight: 16 },
  switchAccount: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
});
