import { CameraView, useCameraPermissions } from 'expo-camera';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { Button } from '@/components/ui/Button';
import { colors, spacing } from '@/theme/tokens';

const RETICLE = 210;

interface Props {
  onScanned: (payload: string) => void;
  paused: boolean;
}

export function Viewfinder({ onScanned, paused }: Props) {
  const [permission, requestPermission] = useCameraPermissions();
  const lastScanAt = useRef(0);
  const [scanline] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(scanline, { toValue: 1, duration: 1100, useNativeDriver: true }),
        Animated.timing(scanline, { toValue: 0, duration: 1100, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [scanline]);

  const handleScan = ({ data }: { data: string }) => {
    // la caméra ré-émet tant que le QR reste dans le cadre
    const now = Date.now();
    if (paused || now - lastScanAt.current < 2000) return;
    lastScanAt.current = now;
    onScanned(data);
  };

  const translateY = scanline.interpolate({
    inputRange: [0, 1],
    outputRange: [8, RETICLE - 10],
  });

  return (
    <View style={styles.container}>
      {permission?.granted ? (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleScan}
        />
      ) : (
        <View style={styles.noCam}>
          <Text style={styles.noCamText}>
            La caméra est nécessaire pour scanner les QR des visiteurs.
          </Text>
          {permission && !permission.granted ? (
            <Button label="Autoriser la caméra" variant="accent" onPress={requestPermission} />
          ) : null}
          <Text style={styles.noCamHint}>
            Sans caméra, aucun contrôle n’est possible : le poste doit être
            rouvert une fois l’autorisation accordée.
          </Text>
        </View>
      )}

      {permission?.granted ? (
        <View pointerEvents="none" style={styles.mask}>
          <View style={styles.maskFill} />
          <View style={styles.maskRow}>
            <View style={styles.maskFill} />
            <View style={styles.maskHole} />
            <View style={styles.maskFill} />
          </View>
          <View style={styles.maskFill} />
        </View>
      ) : null}

      <View pointerEvents="none" style={styles.overlay}>
        <View style={styles.reticle}>
          <View style={[styles.corner, styles.tl]} />
          <View style={[styles.corner, styles.tr]} />
          <View style={[styles.corner, styles.bl]} />
          <View style={[styles.corner, styles.br]} />
          <Animated.View style={[styles.scanline, { transform: [{ translateY }] }]} />
        </View>
        <Text style={styles.hint}>Présentez le QR Code dans le cadre</Text>
      </View>
    </View>
  );
}

const C = 34;
const B = 3;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0E141B' },
  mask: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  maskFill: { flex: 1, backgroundColor: 'rgba(0,0,0,.45)' },
  maskRow: { flexDirection: 'row', height: RETICLE },
  maskHole: { width: RETICLE, height: RETICLE },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: { width: RETICLE, height: RETICLE },
  corner: { position: 'absolute', width: C, height: C, borderColor: colors.amber },
  tl: { top: 0, left: 0, borderTopWidth: B, borderLeftWidth: B, borderTopLeftRadius: 6 },
  tr: { top: 0, right: 0, borderTopWidth: B, borderRightWidth: B, borderTopRightRadius: 6 },
  bl: { bottom: 0, left: 0, borderBottomWidth: B, borderLeftWidth: B, borderBottomLeftRadius: 6 },
  br: { bottom: 0, right: 0, borderBottomWidth: B, borderRightWidth: B, borderBottomRightRadius: 6 },
  scanline: {
    position: 'absolute',
    left: 8,
    right: 8,
    height: 2,
    backgroundColor: colors.amber,
    opacity: 0.9,
  },
  hint: { position: 'absolute', bottom: 18, color: colors.muted, fontSize: 12 },
  noCam: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    padding: spacing.xl,
  },
  noCamText: { color: colors.text, fontSize: 14, textAlign: 'center' },
  noCamHint: { color: colors.muted, fontSize: 12, textAlign: 'center' },
});
