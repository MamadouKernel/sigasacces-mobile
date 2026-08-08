import { createAudioPlayer } from 'expo-audio';

// Bip de dépassement (§7) — même intention que window.novaccesBeep côté Web
// (Sûreté/Admin/Hôte) : l'agent au poste de contrôle doit être alerté quand
// un visiteur dépasse sa durée prévue, pas seulement le voir dans une liste
// qu'il consulte de temps en temps.
//
// Fichier WAV court (880 Hz, 350 ms) généré une fois et embarqué en asset —
// pas de synthèse audio à la volée possible sans dépendance native
// supplémentaire, et un data URI serait moins fiable selon les plateformes.
const OVERSTAY_BEEP = require('../../assets/sounds/overstay-beep.wav');

// createAudioPlayer() (API impérative, hors composant React) NE libère PAS
// son instance automatiquement contrairement au hook useAudioPlayer() — sans
// ce nettoyage différé, chaque bip laisserait un player natif orphelin.
const CLEANUP_DELAY_MS = 700;

function playOnce() {
  try {
    const player = createAudioPlayer(OVERSTAY_BEEP);
    player.play();
    setTimeout(() => {
      try { player.remove(); } catch { /* déjà libéré, sans conséquence */ }
    }, CLEANUP_DELAY_MS);
  } catch {
    // best-effort : un bip manqué ne doit jamais faire échouer le reste du flux.
  }
}

/** Niveau 3 (événement de sécurité) : deux bips au lieu d'un, plus pressant. */
export function playOverstayBeep(level: number) {
  playOnce();
  if (level >= 3) setTimeout(playOnce, 450);
}
