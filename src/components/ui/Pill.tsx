import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { font } from '@/theme/tokens';

interface Props {
  label: string;
  color: string;
}

/** Badge de statut façon maquette (liste des attendus, verdicts…). */
export function Pill({ label, color }: Props) {
  return (
    <View style={[styles.pill, { borderColor: color }]}>
      <Text style={[styles.label, { color }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: 1,
    borderRadius: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    alignSelf: 'flex-start',
  },
  label: { fontSize: 10, fontFamily: font.mono, letterSpacing: 0.5 },
});
