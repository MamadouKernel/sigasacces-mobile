/**
 * Design tokens NOVACCÈS — repris de la maquette (écran téléphone agent).
 */
export const colors = {
  bg: '#101820',
  bgDeep: '#0B0F14',
  surface: '#18222C',
  line: '#1E2933',
  text: '#E8ECEF',
  muted: '#9AA7B2',
  amber: '#F5A300',
  amberDim: 'rgba(245,163,0,.12)',
  navy: '#0E2A3A',
  ok: '#0D9142',
  okBright: '#26C266',
  no: '#CE2F2F',
  out: '#1B5E9E',
  outBright: '#5FA8E0',
  purple: '#B18AD6',
  grayChip: '#7A8792',
  redChip: '#E06A6A',
  greenChip: '#4FC57E',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 5,
  md: 8,
  lg: 12,
} as const;

export const font = {
  mono: 'monospace',
} as const;
