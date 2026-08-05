import { p256 } from '@noble/curves/nist.js';

/**
 * Primitives ES256 (P-256 / SHA-256) du terminal, en JavaScript pur.
 *
 * Deux usages, tous deux exigés par le contrat de sécurité :
 *
 *  1. **Identité de l'appareil** — l'enrôlement lie le terminal à une paire de
 *     clés générée ICI. La clé privée ne quitte jamais l'appareil (stockage
 *     Keystore/Keychain) ; seule la clé publique part au serveur. Un terminal
 *     volé se révoque côté serveur sans toucher aux comptes agents.
 *
 *  2. **Vérification hors ligne** — les QR visiteurs et la liste du jour sont
 *     des JWS signés ES256 par le serveur. Le terminal doit pouvoir en
 *     vérifier la signature sans réseau (REQ-SEC-06) : un QR forgé est donc
 *     détecté même pendant une coupure.
 *
 * Aucune dépendance native n'est requise (@noble/curves est du JS pur), ce qui
 * évite d'ajouter une surface d'attaque et garde le binaire portable.
 */

// ─── Source d'aléa ──────────────────────────────────────────────────────────

/**
 * Aucune source d'entropie cryptographique n'est disponible. Levée plutôt que
 * contournée : une clé d'appareil tirée d'un générateur faible (`Math.random`)
 * serait prédictible, donc l'identité du terminal serait forgeable. Mieux vaut
 * un enrôlement qui échoue franchement qu'un terminal usurpable.
 */
export class SecureRandomUnavailableError extends Error {
  constructor() {
    super(
      "Le module natif de cryptographie est absent de ce binaire. Installez une version de l'application incluant expo-crypto avant d'enrôler ce terminal.",
    );
    this.name = 'SecureRandomUnavailableError';
  }
}

type ExpoCryptoModule = typeof import('expo-crypto');

let expoCrypto: ExpoCryptoModule | null | undefined;

/** Le runtime Expo expose les modules natifs sur `globalThis.expo.modules`. */
function nativeCryptoAvailable(): boolean {
  const expoGlobal = (globalThis as { expo?: { modules?: Record<string, unknown> } }).expo;
  return Boolean(expoGlobal?.modules?.ExpoCrypto);
}

/**
 * Chargement paresseux d'expo-crypto : requérir le module alors que le binaire
 * installé ne l'embarque pas lève « Cannot find native module » au chargement
 * du fichier, ce qui empêcherait l'app de démarrer — y compris les écrans qui
 * n'ont aucun besoin d'aléa.
 */
function getExpoCrypto(): ExpoCryptoModule | null {
  if (expoCrypto === undefined) {
    if (!nativeCryptoAvailable()) {
      expoCrypto = null;
      return expoCrypto;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expoCrypto = require('expo-crypto') as ExpoCryptoModule;
    } catch {
      expoCrypto = null;
    }
  }
  return expoCrypto;
}

/**
 * Remplit un tableau d'octets aléatoires. Utilise `crypto.getRandomValues` du
 * moteur JS s'il existe, sinon la source de l'OS via expo-crypto.
 *
 * N'est requis que pour créer l'identité de l'appareil : la vérification des
 * signatures (QR, liste du jour) n'a besoin d'aucun aléa et reste donc
 * opérationnelle même sans module natif.
 */
export function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);

  const engineCrypto = (globalThis as { crypto?: Partial<Crypto> }).crypto;
  if (typeof engineCrypto?.getRandomValues === 'function') {
    engineCrypto.getRandomValues(bytes);
    return bytes;
  }

  const native = getExpoCrypto();
  if (native) {
    native.getRandomValues(bytes);
    return bytes;
  }

  throw new SecureRandomUnavailableError();
}

export function isSecureRandomAvailable(): boolean {
  try {
    secureRandomBytes(1);
    return true;
  } catch {
    return false;
  }
}

/** UUID v4 tiré de la source d'entropie sécurisée (identifiant d'appareil). */
export function randomUuid(): string {
  const bytes = secureRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variante RFC 4122
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── Encodages ──────────────────────────────────────────────────────────────

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Base64 standard — implémenté ici car `btoa` n'existe pas sous Hermes. */
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

// ─── Clés publiques PEM (SPKI) ──────────────────────────────────────────────

/**
 * Préfixe DER d'une clé publique SPKI `id-ecPublicKey` sur `prime256v1`,
 * suivi du point non compressé de 65 octets (0x04 ‖ X ‖ Y).
 */
const SPKI_P256_PREFIX = hexToBytes('3059301306072a8648ce3d020106082a8648ce3d030107034200');

function pemBody(pem: string): string {
  return pem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '');
}

/** Encode un point public P-256 (65 octets) en PEM SPKI, format attendu par .NET. */
export function publicKeyToPem(publicKey: Uint8Array): string {
  const der = new Uint8Array(SPKI_P256_PREFIX.length + publicKey.length);
  der.set(SPKI_P256_PREFIX, 0);
  der.set(publicKey, SPKI_P256_PREFIX.length);
  const b64 = bytesToBase64(der).replace(/(.{64})/g, '$1\n').trim();
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----`;
}

/**
 * Extrait le point non compressé d'une clé publique PEM SPKI. Le point est en
 * fin de structure DER : on le repère par son marqueur 0x04 sur 65 octets,
 * ce qui évite d'écrire un parseur ASN.1 complet pour une courbe unique.
 */
export function pemToPublicKey(pem: string): Uint8Array {
  const der = base64ToBytes(pemBody(pem));
  const point = der.subarray(der.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error('Clé publique ES256 illisible (point P-256 non compressé attendu).');
  }
  return point;
}

// ─── Identité de l'appareil ─────────────────────────────────────────────────

export interface DeviceKeyPair {
  /** Clé privée en hexadécimal — à ne stocker QUE dans le stockage sécurisé. */
  privateKeyHex: string;
  /** Clé publique au format PEM SPKI, transmise au serveur à l'enrôlement. */
  publicKeyPem: string;
}

/**
 * Génère l'identité cryptographique du terminal.
 *
 * L'entropie est fournie explicitement (48 octets, réduits modulo l'ordre de
 * la courbe par @noble/curves) plutôt que laissée au `crypto` global : sous
 * Hermes celui-ci est absent, et une génération silencieusement dégradée
 * produirait une clé devinable. Lève `SecureRandomUnavailableError` si aucune
 * source sûre n'est disponible.
 */
export function generateDeviceKeyPair(): DeviceKeyPair {
  const secretKey = p256.utils.randomSecretKey(secureRandomBytes(48));
  return {
    privateKeyHex: bytesToHex(secretKey),
    publicKeyPem: publicKeyToPem(p256.getPublicKey(secretKey, false)),
  };
}

/**
 * Signe un message avec la clé privée du terminal (ECDSA P-256 / SHA-256).
 * Retourne la signature brute r‖s de 64 octets — format `IeeeP1363` attendu
 * par `ECDsa.VerifyData` côté .NET.
 */
export function signWithDeviceKey(privateKeyHex: string, message: string): Uint8Array {
  return p256.sign(utf8ToBytes(message), hexToBytes(privateKeyHex), { prehash: true });
}

// ─── Vérification des JWS émis par le serveur ───────────────────────────────

export interface JwsHeader {
  alg?: string;
  kid?: string;
}

/** Lit l'en-tête d'un JWS sans vérifier sa signature (pour choisir le `kid`). */
export function readJwsHeader(token: string): JwsHeader | null {
  const [rawHeader] = token.split('.');
  if (!rawHeader) return null;
  try {
    return JSON.parse(bytesToUtf8(base64UrlToBytes(rawHeader))) as JwsHeader;
  } catch {
    return null;
  }
}

/**
 * Vérifie un JWS compact signé ES256 et retourne sa charge utile décodée.
 * Retourne `null` dès que la signature ne correspond pas — c'est ce contrôle
 * qui permet de rejeter un QR forgé sans joindre le serveur.
 */
export function verifyJws<T>(token: string, publicKeyPem: string): T | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, signature] = parts;

  try {
    if (readJwsHeader(token)?.alg !== 'ES256') return null;
    const ok = p256.verify(
      base64UrlToBytes(signature),
      utf8ToBytes(`${header}.${payload}`),
      pemToPublicKey(publicKeyPem),
      { prehash: true },
    );
    if (!ok) return null;
    return JSON.parse(bytesToUtf8(base64UrlToBytes(payload))) as T;
  } catch {
    return null;
  }
}
