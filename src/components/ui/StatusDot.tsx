import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors } from '@/theme/tokens';

export function StatusDot({ online }: { online: boolean }) {
  return (
    <View
      style={[styles.dot, { backgroundColor: online ? colors.okBright : colors.amber }]}
    />
  );
}

const styles = StyleSheet.create({
  dot: { width: 9, height: 9, borderRadius: 5 },
});
