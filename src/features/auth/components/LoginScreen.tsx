import { useRouter } from 'expo-router';
import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';

import { Button } from '@/components/ui/Button';
import { Logo } from '@/components/ui/Logo';
import { TextField } from '@/components/ui/TextField';
import { useAuthStore } from '@/features/auth/auth.store';
import { useEnrollmentStore } from '@/features/auth/enrollment.store';
import { colors, font, radius, spacing } from '@/theme/tokens';

export function LoginScreen() {
  const router = useRouter();
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);
  const busy = useAuthStore((s) => s.busy);
  const enrollment = useEnrollmentStore((s) => s.enrollment);
  const resetEnrollment = useEnrollmentStore((s) => s.reset);

  const [matricule, setMatricule] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const pinRef = useRef<TextInput>(null);

  const canSubmit = matricule.trim().length > 0 && pin.length >= 4 && !busy;

  const reenroll = () => {
    const doReset = () => {
      logout();
      void resetEnrollment().then(() => router.replace('/enrolement'));
    };
    if (Platform.OS === 'web') {
      doReset();
      return;
    }
    Alert.alert(
      'Réenrôler ce terminal ?',
      "L'identité de l'appareil et le site associé seront effacés. Un nouveau ticket d'enrôlement de l'Admin Sigasécurité sera nécessaire.",
      [
        { text: 'Annuler', style: 'cancel' },
        { text: 'Réenrôler', style: 'destructive', onPress: doReset },
      ],
    );
  };

  const submit = async () => {
    if (!canSubmit) return;
    const res = await login(matricule.trim(), pin);
    setPin('');
    if (!res.ok) {
      setError(res.error ?? 'Prise de poste impossible');
      return;
    }
    setError(null);
    router.replace('/config-poste');
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
        <Text style={styles.subtitle}>Application agent · contrôle des visiteurs</Text>
        {enrollment ? (
          <Text style={styles.siteChip}>
            Terminal enrôlé{enrollment.siteLabel ? ` · ${enrollment.siteLabel}` : ''}
          </Text>
        ) : null}

        <TextField
          label="Matricule"
          value={matricule}
          onChangeText={(t) => {
            setMatricule(t);
            if (error) setError(null);
          }}
          placeholder="SG-0417"
          autoCapitalize="characters"
          autoCorrect={false}
          autoComplete="username"
          returnKeyType="next"
          onSubmitEditing={() => pinRef.current?.focus()}
        />
        <TextField
          ref={pinRef}
          label="Code PIN"
          value={pin}
          onChangeText={(t) => {
            setPin(t.replace(/[^0-9]/g, ''));
            if (error) setError(null);
          }}
          placeholder="••••"
          secureTextEntry
          keyboardType="number-pad"
          maxLength={6}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
        />

        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}

        <Button
          label={busy ? 'Ouverture du poste…' : 'Prendre le poste'}
          variant="accent"
          onPress={() => void submit()}
          disabled={!canSubmit}
        />
        {busy ? <ActivityIndicator color={colors.amber} /> : null}

        <Text style={styles.note}>
          La prise de poste requiert le réseau : le serveur central vérifie le
          matricule et le code PIN.
        </Text>

        <Pressable onPress={reenroll} hitSlop={8} accessibilityRole="button">
          <Text style={styles.reenroll}>Réenrôler ce terminal</Text>
        </Pressable>
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
  subtitle: {
    color: colors.muted,
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: spacing.md,
  },
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
  siteChip: {
    color: colors.amber,
    fontSize: 12,
    fontFamily: font.mono,
    marginTop: -spacing.sm,
  },
  reenroll: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
    textDecorationLine: 'underline',
  },
});
