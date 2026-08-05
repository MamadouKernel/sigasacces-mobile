import { Redirect } from 'expo-router';
import React from 'react';

import { useAuthStore } from '@/features/auth/auth.store';
import { ConfigPosteScreen } from '@/features/auth/components/ConfigPosteScreen';

export default function ConfigPosteRoute() {
  const agent = useAuthStore((s) => s.agent);
  if (!agent) return <Redirect href="/login" />;
  return <ConfigPosteScreen />;
}
