import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';

import { apiConfig, currentShiftToken } from '@/lib/api';

/**
 * Temps réel (SignalR) pour l'app agent — canal /hubs/scan-events (policy
 * AgentEvents côté API, distinct de /hubs/scan réservé au portail web).
 * Authentifié par le MÊME jeton de poste (shiftToken) que les appels REST :
 * un JWT signé par le service central, portant déjà le rôle Agent et le
 * claim SiteId — aucune infrastructure d'auth supplémentaire nécessaire
 * (voir AgentTests.Agent_CanConnectToScanEventsHub..., côté API .NET).
 *
 * Best-effort de bout en bout, comme le reste de la couche réseau de cette
 * app (§9) : une panne de connexion temps réel ne doit JAMAIS bloquer le
 * poste — elle retombe simplement sur le sondage déjà en place (15 min +
 * sondage rapide pendant une confirmation en attente, voir ScannerScreen.tsx)
 * et sur les notifications push. Aucun payload structuré n'est distingué ici
 * (même principe que pushToken.ts) : tout signal pertinent déclenche un
 * simple rafraîchissement, idempotent, sans effet de bord si rien n'a changé.
 */
const RELEVANT_EVENTS = ['ScanRecorded', 'VisitCreated', 'VisitRevoked', 'ConfirmationResolved'] as const;

let connection: HubConnection | null = null;
let connectedSiteId: string | null = null;

export function connectRealtime(siteId: string, onSignal: () => void): void {
  if (connection && connectedSiteId === siteId && connection.state !== HubConnectionState.Disconnected) {
    return; // déjà connecté (ou en cours de connexion) au bon site
  }
  disconnectRealtime();
  connectedSiteId = siteId;

  const hub = new HubConnectionBuilder()
    .withUrl(`${apiConfig.baseUrl}/hubs/scan-events?site=${encodeURIComponent(siteId)}`, {
      accessTokenFactory: () => currentShiftToken() ?? '',
    })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();

  for (const event of RELEVANT_EVENTS) {
    hub.on(event, onSignal);
  }

  hub.start().catch(() => {
    // best-effort : le sondage existant prend le relais silencieusement
  });

  connection = hub;
}

export function disconnectRealtime(): void {
  const toStop = connection;
  connection = null;
  connectedSiteId = null;
  if (toStop) {
    void toStop.stop().catch(() => {
      // best-effort
    });
  }
}

export function isRealtimeConnected(): boolean {
  return connection?.state === HubConnectionState.Connected;
}
