import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { TextField } from '@/components/ui/TextField';
import { parseEnrollmentTicket, useEnrollmentStore } from '@/features/auth/enrollment.store';
import { colors, radius, spacing } from '@/theme/tokens';

type Mode = 'qr' | 'manuel';

export function EnrolementScreen() {
  const router = useRouter();
  const activate = useEnrollmentStore((s) => s.activate);
  const busy = useEnrollmentStore((s) => s.busy);

  const [mode, setMode] = useState<Mode>('qr');
  const [error, setError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const lastScanAt = useRef(0);

  const [ticket, setTicket] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  const submit = async (rawTicket: string, serverUrl?: string) => {
    const parsed = parseEnrollmentTicket(rawTicket);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    const res = await activate(parsed.ticket, parsed.baseUrl ?? serverUrl);
    if (!res.ok) {
      setError(res.error ?? "Activation refusée par le serveur.");
      return;
    }
    router.replace('/login');
  };

  const onQrScanned = ({ data }: { data: string }) => {
    // la caméra ré-émet tant que le QR reste dans le cadre
    const now = Date.now();
    if (busy || now - lastScanAt.current < 2500) return;
    lastScanAt.current = now;
    void submit(data);
  };

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={styles.card}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <Logo size={28} />
        <Text style={styles.title}>Enrôlement du terminal</Text>
        <Text style={styles.intro}>
          Présentez le ticket QR d&apos;enrôlement remis par l&apos;Admin
          Sigasécurité. Le ticket est temporaire et à usage unique ; cette étape
          n&apos;est faite qu&apos;une seule fois par terminal.
        </Text>

        <View style={styles.tabs} accessibilityRole="tablist">
          {(
            [
              ['qr', "Ticket QR"],
              ['manuel', 'Saisie manuelle'],
            ] as const
          ).map(([m, label]) => (
            <Pressable
              key={m}
              accessibilityRole="tab"
              accessibilityState={{ selected: mode === m }}
              style={[styles.tab, mode === m && styles.tabActive]}
              onPress={() => {
                setMode(m);
                setError(null);
              }}>
              <Text style={[styles.tabText, mode === m && styles.tabTextActive]}>{label}</Text>
            </Pressable>
          ))}
        </View>

        {mode === 'qr' ? (
          <View style={styles.scanZone}>
            {permission?.granted ? (
              <CameraView
                style={StyleSheet.absoluteFill}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                onBarcodeScanned={onQrScanned}
              />
            ) : (
              <View style={styles.noCam}>
                <Text style={styles.noCamText}>
                  La caméra est nécessaire pour lire le ticket d&apos;enrôlement.
                </Text>
                <Button label="Autoriser la caméra" variant="accent" onPress={requestPermission} />
              </View>
            )}
            {permission?.granted ? (
              <Text style={styles.scanHint}>Présentez le ticket QR dans le cadre</Text>
            ) : null}
          </View>
        ) : (
          <View style={styles.form}>
            <TextField
              label="Ticket d'enrôlement"
              value={ticket}
              onChangeText={(t) => {
                setTicket(t);
                if (error) setError(null);
              }}
              placeholder="Coller le ticket fourni par l'Admin"
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TextField
              label="URL du serveur (optionnel)"
              value={baseUrl}
              onChangeText={setBaseUrl}
              placeholder="https://api.sigasacces.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              hint="À renseigner uniquement si le site dispose de son propre serveur."
            />
            <Button
              label="Activer ce terminal"
              variant="accent"
              onPress={() => void submit(ticket, baseUrl.trim() || undefined)}
              disabled={busy || ticket.trim().length === 0}
            />
          </View>
        )}

        {busy ? (
          <View style={styles.busy}>
            <ActivityIndicator color={colors.amber} />
            <Text style={styles.busyText}>Activation en cours…</Text>
          </View>
        ) : null}

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  card: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: spacing.xl,
    gap: spacing.lg,
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '700' },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  tabs: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    overflow: 'hidden',
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  tabActive: { backgroundColor: colors.amberDim },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.amber },
  scanZone: {
    height: 260,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: '#0E141B',
    borderWidth: 1,
    borderColor: colors.line,
    justifyContent: 'flex-end',
  },
  scanHint: {
    color: colors.muted,
    fontSize: 12,
    textAlign: 'center',
    paddingVertical: spacing.sm,
    backgroundColor: 'rgba(0,0,0,.45)',
  },
  noCam: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  noCamText: { color: colors.text, fontSize: 14, textAlign: 'center' },
  form: { gap: spacing.lg },
  busy: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm },
  busyText: { color: colors.muted, fontSize: 13 },
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
});
