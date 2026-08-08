import React, { useMemo, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Pill } from '@/components/ui/Pill';
import { windowState } from '@/features/scan/engine';
import { useScanStore } from '@/features/scan/scan.store';
import { fmt } from '@/lib/time';
import { colors, font, radius, spacing } from '@/theme/tokens';
import type { OfflineVisit } from '@/types/domain';

interface Props {
  visible: boolean;
  onClose: () => void;
}

function statusOf(visit: OfflineVisit): { label: string; color: string } {
  if (visit.present) {
    return {
      label: visit.entreeAt ? `SUR SITE · ${fmt(visit.entreeAt)}` : 'SUR SITE',
      color: colors.outBright,
    };
  }
  if (visit.exited || visit.statut === 'consomme') return { label: 'SORTI', color: colors.grayChip };
  if (visit.statut === 'revoque') return { label: 'RÉVOQUÉ', color: colors.redChip };
  if (windowState(visit, Date.now()) === 'late') return { label: 'NON VENU', color: colors.purple };
  return {
    label:
      visit.mode === 'unique' && visit.fenetreDebut
        ? `ATTENDU ${fmt(visit.fenetreDebut)}`
        : 'ATTENDU (30 j)',
    color: colors.greenChip,
  };
}

export function DayListSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const visits = useScanStore((s) => s.visits);
  const degraded = useScanStore((s) => s.degraded);
  const scanPayload = useScanStore((s) => s.scanPayload);
  const direction = useScanStore((s) => s.direction);
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    return [...visits]
      .filter((v) => !q || v.nom.toLowerCase().includes(q))
      .sort((a, b) => (a.fenetreDebut ?? 0) - (b.fenetreDebut ?? 0));
  }, [visits, query]);

  const close = () => {
    setQuery('');
    onClose();
  };

  const handleValidateManual = (visit: OfflineVisit) => {
    const sens = direction === 'entree' ? 'l’ENTRÉE' : 'la SORTIE';
    Alert.alert(
      'Validation manuelle',
      `Confirmer ${sens} manuelle pour ${visit.nom} ?`,
      [
        { text: 'Annuler', style: 'cancel' },
        {
          text: 'Valider',
          onPress: () => {
            close();
            void scanPayload(visit.visitId);
          },
        },
      ],
    );
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <View style={[styles.container, { paddingTop: Math.max(insets.top, spacing.lg) }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>ATTENDUS AUJOURD’HUI</Text>
            <Text style={styles.subtitle}>
              {sorted.length} visiteur(s) · liste signée par le serveur
              {degraded ? ' · hors ligne' : ''}
            </Text>
          </View>
          <Pressable
            onPress={close}
            style={styles.close}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Fermer">
            <Text style={styles.closeText}>✕</Text>
          </Pressable>
        </View>

        <View style={styles.searchWrap}>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Rechercher un nom (visiteur sans QR)…"
            placeholderTextColor={colors.muted}
            style={styles.search}
            autoCorrect={false}
            accessibilityLabel="Rechercher un visiteur par nom"
          />
        </View>

        <FlatList
          data={sorted}
          keyExtractor={(v) => v.visitId}
          ListEmptyComponent={
            <Text style={styles.empty}>
              {visits.length === 0
                ? "Aucune liste chargée pour aujourd'hui."
                : `Aucun visiteur ne correspond à « ${query.trim()} ».`}
            </Text>
          }
          renderItem={({ item }) => {
            const st = statusOf(item);
            return (
              <Pressable
                style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}
                onPress={() => handleValidateManual(item)}>
                <View style={styles.rowLeft}>
                  <Text style={styles.nom}>{item.nom}</Text>
                  <Text style={styles.meta}>
                    {item.fenetreDebut && item.fenetreFin
                      ? `Fenêtre ${fmt(item.fenetreDebut)} – ${fmt(item.fenetreFin)}`
                      : item.mode === 'unique'
                        ? 'Accès unique'
                        : 'Accès 30 jours ouvrés'}
                  </Text>
                </View>
                <View style={{ alignItems: 'flex-end', gap: 4 }}>
                  <Pill label={st.label} color={st.color} />
                  <Text style={{ fontSize: 10, color: colors.amber, fontWeight: '600' }}>
                    Taper pour valider
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />

        <Text style={[styles.footer, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
          DONNÉES MINIMALES (moindre privilège) : ni motif, ni coordonnées. Visiteur sans
          QR (téléphone déchargé) : rechercher son nom ici et demander la validation
          manuelle à la sûreté.
        </Text>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  title: { color: colors.text, fontSize: 18, fontWeight: '700', letterSpacing: 0.5 },
  subtitle: { color: colors.muted, fontFamily: font.mono, fontSize: 10, marginTop: 2 },
  close: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: 5,
    minWidth: 36,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: { color: colors.text, fontSize: 14 },
  searchWrap: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.line,
  },
  search: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 14,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  empty: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    padding: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: colors.surface,
  },
  rowLeft: { flexShrink: 1, paddingRight: spacing.md },
  nom: { color: colors.text, fontSize: 14, fontWeight: '600' },
  meta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  footer: {
    color: colors.muted,
    fontFamily: font.mono,
    fontSize: 10,
    lineHeight: 15,
    padding: spacing.lg,
    borderTopWidth: 1,
    borderTopColor: colors.line,
  },
});
