import { Redirect } from 'expo-router';
import React from 'react';

import { useAuthStore } from '@/features/auth/auth.store';
import { ScannerScreen } from '@/features/scan/components/ScannerScreen';

export default function ScannerRoute() {
  const agent = useAuthStore((s) => s.agent);
  const post = useAuthStore((s) => s.post);
  if (!agent) return <Redirect href="/login" />;
  if (!post) return <Redirect href="/config-poste" />;
  return <ScannerScreen />;
}
