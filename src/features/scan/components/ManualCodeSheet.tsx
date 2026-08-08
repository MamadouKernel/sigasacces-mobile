import React, { useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/Button';
import { useScanStore } from '@/features/scan/scan.store';
import { colors, font, radius, spacing } from '@/theme/tokens';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export function ManualCodeSheet({ visible, onClose }: Props) {
  const insets = useSafeAreaInsets();
  const scanPayload = useScanStore((s) => s.scanPayload);
  const busy = useScanStore((s) => s.busy);
  const direction = useScanStore((s) => s.direction);
  const [code, setCode] = useState('');

  const submit = () => {
    const trimmed = code.trim();
    if (!trimmed) return;
    setCode('');
    onClose();
    void scanPayload(trimmed);
  };

  const handleClose = () => {
    setCode('');
    onClose();
  };

  const isEntry = direction === 'entree';

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <Pressable style={StyleSheet.absoluteFill} onPress={handleClose} />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.xl) }]}>
          <View style={styles.header}>
            <View>
              <Text style={styles.title}>VÉRIFICATION MANUELLE</Text>
              <Text style={styles.subtitle}>
                Saisie manuelle pour visiteur sans QR code ({isEntry ? 'ENTRÉE' : 'SORTIE'})
              </Text>
            </View>
            <Pressable onPress={handleClose} style={styles.close} hitSlop={8}>
              <Text style={styles.closeText}>✕</Text>
            </Pressable>
          </View>

          <View style={styles.body}>
            <Text style={styles.label}>CODE BILLET OU IDENTIFIANT</Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder="Ex: TKT-12345, VIS-7890 ou nom..."
              placeholderTextColor={colors.muted}
              style={styles.input}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="go"
              onSubmitEditing={submit}
              accessibilityLabel="Code billet ou identifiant visiteur"
            />
            <Text style={styles.hint}>
              Utilisez cette option si le smartphone du visiteur est déchargé ou si le QR code
              est illisible par la caméra.
            </Text>

            <Button
              label={busy ? 'Vérification...' : 'Valider le contrôle'}
              variant="accent"
              onPress={submit}
              disabled={!code.trim() || busy}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.bg,
    borderTopLeftRadius: radius.md,
    borderTopRightRadius: radius.md,
    padding: spacing.xl,
    gap: spacing.lg,
    borderWidth: 1,
    borderColor: colors.line,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  title: {
    color: colors.text,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  subtitle: {
    color: colors.muted,
    fontFamily: font.mono,
    fontSize: 11,
    marginTop: 2,
  },
  close: {
    padding: spacing.xs,
  },
  closeText: {
    color: colors.muted,
    fontSize: 18,
  },
  body: {
    gap: spacing.md,
  },
  label: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    color: colors.text,
    fontFamily: font.mono,
    fontSize: 16,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 48,
  },
  hint: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
  },
});
