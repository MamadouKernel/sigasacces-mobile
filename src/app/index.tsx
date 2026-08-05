import { Redirect } from 'expo-router';
import React from 'react';

import { useAuthStore } from '@/features/auth/auth.store';
import { useEnrollmentStore } from '@/features/auth/enrollment.store';

export default function Index() {
  const hydrated = useEnrollmentStore((s) => s.hydrated);
  const enrollment = useEnrollmentStore((s) => s.enrollment);
  const agent = useAuthStore((s) => s.agent);
  const post = useAuthStore((s) => s.post);

  // Lecture du stockage sécurisé en cours — ne pas rediriger à l'aveugle.
  if (!hydrated) return null;

  if (!enrollment) return <Redirect href="/enrolement" />;
  if (!agent) return <Redirect href="/login" />;
  if (!post) return <Redirect href="/config-poste" />;
  return <Redirect href="/scanner" />;
}
