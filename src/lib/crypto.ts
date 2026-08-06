import { p256 } from '@noble/curves/nist.js';
import { requireOptionalNativeModule } from 'expo';

// ES256 (P-256 / SHA-256) en JS pur : identité de l'appareil à l'enrôlement,
// et vérification hors ligne des enveloppes signées par le serveur (QR
// visiteurs, liste du jour).

export class SecureRandomUnavailableError extends Error {
  constructor() {
    super(
      "Aucune source d'aléa sûre sur ce terminal. Le binaire doit embarquer expo-crypto : relancez un build de développement (npx expo run:android) plutôt qu'Expo Go.",
    );
    this.name = 'SecureRandomUnavailableError';
  }
}

interface ExpoCryptoNative {
  getRandomValues?: (array: Uint8Array) => void;
}

let expoCrypto: ExpoCryptoNative | null | undefined;

// Deux raisons de passer par requireOptionalNativeModule plutôt que par un
// import d'`expo-crypto` ou une lecture directe du registre :
//   — `expo-crypto` fait un requireNativeModule au niveau module, qui lève dès
//     l'évaluation quand le binaire ne l'embarque pas (redbox en dév) ;
//   — lire `globalThis.expo.modules` soi-même se fait avant l'installation des
//     modules natifs, donc toujours à vide. C'est ce que faisait la détection
//     précédente : elle échouait même sur un binaire complet.
// requireOptionalNativeModule installe d'abord, puis rend `null` si absent.
function getExpoCrypto(): ExpoCryptoNative | null {
  if (expoCrypto === undefined) {
    expoCrypto = requireOptionalNativeModule<ExpoCryptoNative>('ExpoCrypto');
  }
  return expoCrypto;
}

// Une source d'entropie en panne peut rendre un tableau inchangé plutôt que
// lever : le vérifier évite de fabriquer une clé d'appareil devinable.
function filled(bytes: Uint8Array): boolean {
  return bytes.length < 8 || bytes.some((b) => b !== 0);
}

// Lève plutôt que de retomber sur Math.random : une clé d'appareil prédictible
// rendrait l'identité du terminal forgeable.
export function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  const engineCrypto = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof engineCrypto?.getRandomValues === 'function') {
    engineCrypto.getRandomValues(bytes);
    if (filled(bytes)) return bytes;
  }

  const native = getExpoCrypto();
  if (typeof native?.getRandomValues === 'function') {
    native.getRandomValues(bytes);
    if (filled(bytes)) return bytes;
  }

  // Sans cette trace, l'échec ne dit pas s'il manque un module précis ou si
  // l'app tourne dans un environnement sans modules natifs du tout.
  const registry = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo?.modules;
  console.warn(
    `[novacces] ExpoCrypto introuvable. Modules natifs présents : ${
      registry ? Object.keys(registry).sort().join(', ') || '(aucun)' : '(registre absent)'
    }`,
  );
  throw new SecureRandomUnavailableError();
}

export function randomUuid(): string {
  const bytes = secureRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// btoa/atob n'existent pas sous Hermes.
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : B64_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : B64_ALPHABET[b2 & 63];
  }
  return out;
}

export function base64ToBytes(input: string): Uint8Array {
  const clean = input.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array((clean.length * 3) >> 2);
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n =
      (B64_ALPHABET.indexOf(clean[i]) << 18) |
      (B64_ALPHABET.indexOf(clean[i + 1]) << 12) |
      ((clean[i + 2] ? B64_ALPHABET.indexOf(clean[i + 2]) : 0) << 6) |
      (clean[i + 3] ? B64_ALPHABET.indexOf(clean[i + 3]) : 0);
    out[o++] = (n >> 16) & 0xff;
    if (clean[i + 2]) out[o++] = (n >> 8) & 0xff;
    if (clean[i + 3]) out[o++] = n & 0xff;
  }
  return out.subarray(0, o);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(input: string): Uint8Array {
  return base64ToBytes(input.replace(/-/g, '+').replace(/_/g, '/'));
}

function utf8ToBytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff) {
      c = 0x10000 + ((c & 0x3ff) << 10) + (text.charCodeAt(++i) & 0x3ff);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return new Uint8Array(out);
}

function bytesToUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    if (b < 0x80) {
      out += String.fromCharCode(b);
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 31) << 6) | (bytes[i++] & 63));
    } else if (b < 0xf0) {
      out += String.fromCharCode(((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63));
    } else {
      const cp =
        ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
      const v = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
    }
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

// Préfixe DER d'une clé SPKI id-ecPublicKey/prime256v1, suivi du point
// non compressé de 65 octets (0x04 ‖ X ‖ Y).
const SPKI_P256_PREFIX = hexToBytes('3059301306072a8648ce3d020106082a8648ce3d030107034200');

function pemBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
}

export function publicKeyToPem(publicKey: Uint8Array): string {
  const der = new Uint8Array(SPKI_P256_PREFIX.length + publicKey.length);
  der.set(SPKI_P256_PREFIX, 0);
  der.set(publicKey, SPKI_P256_PREFIX.length);
  const b64 = bytesToBase64(der).replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

// Le point est en fin de structure DER : on le repère par son marqueur 0x04,
// ce qui évite un parseur ASN.1 complet pour une courbe unique.
export function pemToPublicKey(pem: string): Uint8Array {
  const der = base64ToBytes(pemBody(pem));
  const point = der.subarray(der.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('Clé publique ES256 illisible (point P-256 non compressé attendu).');
  }
  return point;
}

export interface DeviceKeyPair {
  privateKeyHex: string;
  publicKeyPem: string;
}

// Entropie fournie explicitement : sous Hermes le crypto global peut manquer,
// et une génération silencieusement dégradée produirait une clé devinable.
export function generateDeviceKeyPair(): DeviceKeyPair {
  const secretKey = p256.utils.randomSecretKey(secureRandomBytes(48));
  return {
    privateKeyHex: bytesToHex(secretKey),
    publicKeyPem: publicKeyToPem(p256.getPublicKey(secretKey, false)),
  };
}

/** Signature brute r‖s de 64 octets — format IeeeP1363 attendu par .NET. */
export function signWithDeviceKey(privateKeyHex: string, message: string): Uint8Array {
  return p256.sign(utf8ToBytes(message), hexToBytes(privateKeyHex), { prehash: true });
}

// Enveloppe signée NovAccès : ni JWS compact, ni RFC 7515 — pas d'en-tête, pas
// de champ `alg`. Le `keyId` voyage en clair, hors signature : un keyId inconnu
// ne fait qu'échouer la recherche de clé, il n'y a rien à valider en amont.
export interface SignedEnvelope {
  payloadB64Url: string;
  signatureB64Url: string;
  keyId?: string;
}

function readString(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

// Le contrat écrit l'enveloppe en PascalCase ; la graphie camelCase est
// acceptée aussi, un sérialiseur .NET reconfiguré ne doit pas transformer
// tous les QR valides en « QR INVALIDE » sur le terrain.
export function parseSignedEnvelope(raw: string): SignedEnvelope | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;

  const fields = data as Record<string, unknown>;
  const payloadB64Url = readString(fields, 'PayloadB64Url', 'payloadB64Url');
  const signatureB64Url = readString(fields, 'SignatureB64Url', 'signatureB64Url');
  if (!payloadB64Url || !signatureB64Url) return null;
  return { payloadB64Url, signatureB64Url, keyId: readString(fields, 'KeyId', 'keyId') };
}

/**
 * Vérifie la signature ES256 (P1363) portant sur les octets du payload JSON —
 * pas sur sa forme Base64URL. `null` si la signature ne correspond pas.
 */
export function verifySignedEnvelope<T>(
  envelope: SignedEnvelope,
  publicKeyPem: string,
): T | null {
  try {
    const payloadBytes = base64UrlToBytes(envelope.payloadB64Url);
    const ok = p256.verify(
      base64UrlToBytes(envelope.signatureB64Url),
      payloadBytes,
      pemToPublicKey(publicKeyPem),
      // lowS:false est obligatoire ici. @noble/curves n'accepte par défaut que
      // les signatures à S bas ; .NET ECDsa.SignData ne normalise pas, et
      // produit un S haut une fois sur deux. Sans cette option, la moitié des
      // QR authentiques serait refusée hors ligne en « QR INVALIDE ».
      { prehash: true, lowS: false },
    );
    if (!ok) return null;
    return JSON.parse(bytesToUtf8(payloadBytes)) as T;
  } catch {
    return null;
  }
}
