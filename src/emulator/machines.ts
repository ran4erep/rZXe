// Hardware machine definitions for ZX Spectrum 48K, 128K, +2, Pentagon 128, and Scorpion ZS 256

import { RomKey } from './roms';

export type MachineId =
  | '48k'
  | '128k'
  | 'plus2'
  | 'pentagon128'
  | 'pentagon604'
  | 'scorpion256';

export interface MachineProfile {
  id: MachineId;
  shortName: string;
  name: string;
  description: string;
  ramPages: number;       // 3 (48K), 8 (128K), 16 (256K)
  is128kPaging: boolean;
  isScorpionPaging: boolean;
  hasAY: boolean;
  hasTrdos: boolean;
  tstatesPerFrame: number;
  tstatesPerLine: number;
  firstActiveT: number;   // T-state of pixel (0, 0) from frame interrupt
  ayClockHz: number;
  romKeys: RomKey[];      // 16KB ROM banks (1, 2, or 3+ banks)
  trdosRomKey?: RomKey;   // 16KB TR-DOS ROM
}

export const MACHINE_PROFILES: MachineProfile[] = [
  {
    id: '48k',
    shortName: '48K',
    name: 'ZX Spectrum 48K',
    description: 'Оригинал 1982 г. · ПЗУ Sinclair 48K · Бипер',
    ramPages: 3,
    is128kPaging: false,
    isScorpionPaging: false,
    hasAY: false,
    hasTrdos: false,
    tstatesPerFrame: 69888,
    tstatesPerLine: 224,
    firstActiveT: 14336,
    ayClockHz: 1_750_000,
    romKeys: ['rom48'],
  },
  {
    id: '128k',
    shortName: '128K',
    name: 'ZX Spectrum 128K',
    description: 'Sinclair 1986 г. · 128 КБ ОЗУ · Чип AY-3-8912',
    ramPages: 8,
    is128kPaging: true,
    isScorpionPaging: false,
    hasAY: true,
    hasTrdos: false,
    tstatesPerFrame: 70908,
    tstatesPerLine: 228,
    firstActiveT: 14364,
    ayClockHz: 1_773_400,
    romKeys: ['rom128_0', 'rom128_1'],
  },
  {
    id: 'plus2',
    shortName: 'Spectrum +2',
    name: 'ZX Spectrum +2',
    description: 'Amstrad 1986 г. · 128 КБ ОЗУ · AY-3-8912',
    ramPages: 8,
    is128kPaging: true,
    isScorpionPaging: false,
    hasAY: true,
    hasTrdos: false,
    tstatesPerFrame: 70908,
    tstatesPerLine: 228,
    firstActiveT: 14364,
    ayClockHz: 1_773_400,
    romKeys: ['romPlus2_0', 'romPlus2_1'],
  },
  {
    id: 'pentagon128',
    shortName: 'Pentagon',
    name: 'Pentagon 128K (TR-DOS 5.03)',
    description: 'Пентагон 128 · Меню TR-DOS · Beta Disk 5.03 · AY',
    ramPages: 8,
    is128kPaging: true,
    isScorpionPaging: false,
    hasAY: true,
    hasTrdos: true,
    tstatesPerFrame: 71680,
    tstatesPerLine: 224,
    firstActiveT: 17920,
    ayClockHz: 1_750_000,
    romKeys: ['romPentagon'], // 32KB split into 2x16KB automatically
    trdosRomKey: 'romTrdos503',
  },
  {
    id: 'pentagon604',
    shortName: 'Pentagon 6.04',
    name: 'Pentagon 128K (TR-DOS 6.04)',
    description: 'Пентагон 128 · TR-DOS 6.04 (P.O.S. Russia) · AY',
    ramPages: 8,
    is128kPaging: true,
    isScorpionPaging: false,
    hasAY: true,
    hasTrdos: true,
    tstatesPerFrame: 71680,
    tstatesPerLine: 224,
    firstActiveT: 17920,
    ayClockHz: 1_750_000,
    romKeys: ['romPentagon'],
    trdosRomKey: 'romTrdos604',
  },
  {
    id: 'scorpion256',
    shortName: 'Scorpion 256',
    name: 'Scorpion ZS 256 Turbo+',
    description: '256 КБ ОЗУ · Теневой монитор · TR-DOS 5.03 · AY',
    ramPages: 16,
    is128kPaging: true,
    isScorpionPaging: true,
    hasAY: true,
    hasTrdos: true,
    tstatesPerFrame: 71680,
    tstatesPerLine: 224,
    firstActiveT: 17920,
    ayClockHz: 1_750_000,
    romKeys: ['romScorp0', 'romScorp1', 'romScorp2'],
    trdosRomKey: 'romScorp3',
  },
];

export function getMachineProfile(id: MachineId): MachineProfile {
  return MACHINE_PROFILES.find((m) => m.id === id) ?? MACHINE_PROFILES[0];
}

export function getMachineFrameHz(profile: MachineProfile): number {
  if (profile.id === '48k') return 3_500_000 / profile.tstatesPerFrame; // 50.0801 Hz
  if (profile.id === '128k' || profile.id === 'plus2') {
    return 3_546_900 / profile.tstatesPerFrame; // 50.0212 Hz
  }
  return 3_584_000 / profile.tstatesPerFrame; // 50.0000 Hz (Pentagon / Scorpion)
}
