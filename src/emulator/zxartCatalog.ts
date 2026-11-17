import type { MachineId } from './machines';

export type ZxArtSortOrder = 'votes,desc' | 'year,desc' | 'title,asc';

export interface ZxArtCategory {
  id: number;
  title: string;
}

export interface ZxArtGameSummary {
  id: number;
  title: string;
  year: number | null;
  votes: number | null;
  votesAmount: number | null;
  coverUrl: string | null;
  fallbackImageUrl: string | null;
  genre: string | null;
  hardware: string[];
}

export interface ZxArtPlayableRelease {
  id: number;
  title: string;
  fileName: string;
  fileUrl: string;
  releaseType: string;
  formats: string[];
  languages: string[];
  year: number | null;
  version: string | null;
  hardwareRequired: string[];
  hasUnsupportedHardware: boolean;
  score: number;
  recommendedMachine: MachineId | null;
}

export interface RawZxProd {
  id?: number;
  title?: string;
  year?: number | string;
  votes?: number | string;
  votesAmount?: number | string;
  inlaysUrls?: string[];
  listImagesUrls?: string[];
  imagesUrls?: string[];
  categoriesInfo?: Array<{ id?: number; title?: string }>;
  categoriesString?: string;
  hardwareInfo?: Array<{ id?: string; name?: string }>;
  releasesIds?: number[];
}

export interface RawZxRelease {
  id?: number;
  title?: string;
  file?: string;
  fileName?: string;
  year?: number | string;
  language?: string[];
  version?: string;
  releaseType?: string;
  releaseFormat?: string[];
  hardwareRequired?: string[];
  releaseStructure?: unknown[];
  prodId?: number;
}

export const ZXART_ALL_CATEGORY_ID = 0;
export const ZXART_GAMES_CATEGORY_ID = 92177;
export const ZXART_SERIES_CATEGORY_ID = 551860;

const ENTITY_MAP: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#039;': "'",
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&(amp|lt|gt|quot|#039|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 ? String.fromCharCode(code) : _;
    });
}

function isSafeHttpsZxArtUrl(url: unknown): url is string {
  return typeof url === 'string' && url.startsWith('https://zxart.ee/');
}

export function isAllowedZxArtDownloadUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'zxart.ee') {
      return false;
    }
    return (
      parsed.pathname.startsWith('/releasefile/') ||
      parsed.pathname.startsWith('/release/')
    );
  } catch {
    return false;
  }
}

function parseOptionalYear(rawYear: number | string | undefined): number | null {
  const parsed =
    typeof rawYear === 'number'
      ? rawYear
      : typeof rawYear === 'string' && /^\d{4}$/.test(rawYear)
        ? Number(rawYear)
        : null;
  return parsed !== null && parsed > 1979 ? parsed : null;
}

export function isPlayableZxProd(raw: RawZxProd): boolean {
  if (typeof raw.id !== 'number' || !raw.title) return false;

  if (Array.isArray(raw.categoriesInfo)) {
    for (let i = 0; i < raw.categoriesInfo.length; i++) {
      const cat = raw.categoriesInfo[i];
      if (cat?.id === ZXART_SERIES_CATEGORY_ID) return false;
      const catTitle = cat?.title ? decodeHtmlEntities(cat.title).trim().toLowerCase() : '';
      if (catTitle === 'серии' || catTitle === 'series') return false;
    }
  }
  if (typeof raw.categoriesString === 'string') {
    const catStr = raw.categoriesString.trim().toLowerCase();
    if (catStr === 'серии' || catStr === 'series') return false;
  }

  // When full zxProd records are fetched (not preset:list), empty releasesIds means no files exist.
  if (raw.releasesIds !== undefined) {
    return Array.isArray(raw.releasesIds) && raw.releasesIds.length > 0;
  }
  return true;
}

export function extractFallbackReleaseFileName(fileUrl: string): string | null {
  try {
    const parsed = new URL(fileUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'zxart.ee') {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = decodeURIComponent(segments[i]).trim();
      if (!seg) continue;
      if (seg.startsWith('filename:')) {
        const candidate = seg.slice('filename:'.length).trim();
        return candidate.includes('.') ? candidate : null;
      }
      if (!seg.includes(':') && seg.includes('.')) {
        return seg;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizeZxProd(raw: RawZxProd): ZxArtGameSummary | null {
  if (typeof raw.id !== 'number' || !raw.title) return null;

  const inlays = Array.isArray(raw.inlaysUrls) ? raw.inlaysUrls.filter(isSafeHttpsZxArtUrl) : [];
  const images = Array.isArray(raw.listImagesUrls)
    ? raw.listImagesUrls.filter(isSafeHttpsZxArtUrl)
    : Array.isArray(raw.imagesUrls)
      ? raw.imagesUrls.filter(isSafeHttpsZxArtUrl)
      : [];

  const coverUrl = inlays[0] ?? images[0] ?? null;
  const fallbackImageUrl =
    inlays.length > 0 ? images[0] ?? inlays[1] ?? null : images[1] ?? null;

  const parsedYear = parseOptionalYear(raw.year);

  const parsedVotes =
    typeof raw.votes === 'number'
      ? raw.votes
      : typeof raw.votes === 'string' && raw.votes !== ''
        ? Number(raw.votes)
        : null;

  const parsedVotesAmount =
    typeof raw.votesAmount === 'number'
      ? raw.votesAmount
      : typeof raw.votesAmount === 'string' && raw.votesAmount !== ''
        ? Number(raw.votesAmount)
        : null;

  let genreRaw = Array.isArray(raw.categoriesInfo) ? raw.categoriesInfo[0]?.title : undefined;
  if (!genreRaw && typeof raw.categoriesString === 'string' && raw.categoriesString.trim()) {
    const parts = raw.categoriesString.split('/');
    genreRaw = parts[parts.length - 1]?.trim();
  }
  const hardware = Array.isArray(raw.hardwareInfo)
    ? raw.hardwareInfo.map((h) => h.id).filter((id): id is string => typeof id === 'string')
    : [];

  return {
    id: raw.id,
    title: decodeHtmlEntities(raw.title).trim(),
    year: parsedYear,
    votes: parsedVotes !== null && Number.isFinite(parsedVotes) ? parsedVotes : null,
    votesAmount:
      parsedVotesAmount !== null && Number.isFinite(parsedVotesAmount) ? parsedVotesAmount : null,
    coverUrl,
    fallbackImageUrl,
    genre: genreRaw ? decodeHtmlEntities(genreRaw).trim() : null,
    hardware,
  };
}

const UNSUPPORTED_HARDWARE = new Set([
  'dandanator',
  'zxnext',
  'tsconf',
  'atm',
  'profi',
  'zx81',
  'samcoupe',
]);

const NON_GAME_MEDIA_EXTENSIONS = new Set([
  'txt',
  'pdf',
  'doc',
  'html',
  'htm',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'pok',
  'mp3',
  'ogg',
  'ay',
  'pt3',
]);

const FORMAT_SCORES: Record<string, number> = {
  sna: 100,
  z80: 100,
  szx: 98,
  tap: 96,
  trd: 92,
  scl: 90,
  tzx: 84,
  pzx: 82,
  fdi: 76,
  udi: 74,
  td0: 72,
  rom: 68,
  if2: 68,
  dck: 66,
  hob: 60,
  mdr: 50,
  dsk: 25, // +3DOS disks are less reliable on Pentagon TR-DOS than TAP/TRD/SNA
  scr: 10,
  mld: -80,
  rzx: -90,
};

const RELEASE_TYPE_SCORES: Record<string, number> = {
  original: 30,
  rerelease: 24,
  adaptation: 20,
  localization: 18,
  mod: 12,
  crack: 10,
  demoversion: 2,
};

const RELEASE_TYPE_LABELS: Record<string, string> = {
  original: 'Оригинал',
  rerelease: 'Переиздание',
  adaptation: 'Адаптация',
  localization: 'Локализация',
  mod: 'Мод',
  crack: 'Кряк',
  demoversion: 'Демоверсия',
};

export function formatReleaseTypeLabel(releaseType: string): string {
  return RELEASE_TYPE_LABELS[releaseType] ?? 'Релиз';
}

function inferFormatsFromName(fileName: string): string[] {
  const lower = fileName.toLowerCase();
  // Strip outer archive suffix (.zip, .rar, .7z, .gz, .bz2) to detect inner format like Foo.tap.zip
  const stripped = lower.replace(/\.(zip|rar|7z|gz|gzip|bz2|bzip2|arj|lha|lzh|tar|tgz|tbz2|xz)+$/g, '');
  const dot = stripped.lastIndexOf('.');
  if (dot >= 0 && dot < stripped.length - 1) {
    return [stripped.slice(dot + 1)];
  }
  const outerDot = lower.lastIndexOf('.');
  if (outerDot >= 0 && outerDot < lower.length - 1) {
    return [lower.slice(outerDot + 1)];
  }
  return [];
}

export function inferRecommendedMachine(
  formats: string[],
  hardwareRequired: string[]
): MachineId | null {
  const hw = new Set(hardwareRequired.map((h) => h.toLowerCase()));
  const fmtSet = new Set(formats.map((f) => f.toLowerCase()));

  if (
    fmtSet.has('trd') ||
    fmtSet.has('scl') ||
    fmtSet.has('fdi') ||
    fmtSet.has('td0') ||
    fmtSet.has('udi') ||
    hw.has('trdos') ||
    hw.has('pentagon128')
  ) {
    return 'pentagon128';
  }
  if (hw.has('scorpion')) return 'scorpion256';
  if (hw.has('zx+2') && !hw.has('zx128')) return 'plus2';
  if (hw.has('zx128') || hw.has('zx+2') || hw.has('zx+3') || hw.has('ay')) return '128k';
  if (hw.has('zx48')) return '48k';
  return null;
}

export function resolveTargetMachine(
  choice: MachineId | 'auto',
  recommendedMachine: MachineId | null,
  currentMachineId: MachineId
): MachineId {
  if (choice !== 'auto') return choice;
  return recommendedMachine ?? currentMachineId;
}

export function selectPlayableReleases(rawReleases: RawZxRelease[]): ZxArtPlayableRelease[] {
  const candidates: ZxArtPlayableRelease[] = [];

  for (const rel of rawReleases) {
    if (typeof rel.id !== 'number') continue;
    if (!rel.file || !isAllowedZxArtDownloadUrl(rel.file)) continue;
    const rawFileName =
      typeof rel.fileName === 'string' && rel.fileName.trim().length > 0
        ? rel.fileName.trim()
        : extractFallbackReleaseFileName(rel.file);
    if (!rawFileName) continue;

    const hw = Array.isArray(rel.hardwareRequired)
      ? rel.hardwareRequired.filter((h): h is string => typeof h === 'string')
      : [];
    const hasUnsupportedHardware = hw.some((h) => UNSUPPORTED_HARDWARE.has(h.toLowerCase()));

    const apiFormats = Array.isArray(rel.releaseFormat)
      ? rel.releaseFormat.map((f) => f.toLowerCase()).filter(Boolean)
      : [];
    const nameFormats = inferFormatsFromName(rawFileName);
    const formats = apiFormats.length > 0 ? apiFormats : nameFormats;

    // Skip non-software attachments (text docs, images, standalone music)
    if (formats.length > 0 && formats.every((f) => NON_GAME_MEDIA_EXTENSIONS.has(f))) {
      continue;
    }

    const languages = Array.isArray(rel.language)
      ? rel.language
          .filter((lang): lang is string => typeof lang === 'string' && lang.trim().length > 0)
          .map((lang) => lang.trim().toUpperCase())
      : [];

    let bestFormatScore = 45; // generic archive (.zip/.rar) where inner format isn't declared in releaseFormat
    for (const fmt of formats) {
      if (fmt in FORMAT_SCORES) {
        bestFormatScore = Math.max(bestFormatScore, FORMAT_SCORES[fmt]);
      }
    }

    const releaseType = typeof rel.releaseType === 'string' ? rel.releaseType : 'unknown';
    const typeScore = RELEASE_TYPE_SCORES[releaseType] ?? 8;
    const isPlus3Only = hw.includes('zx+3') || hw.includes('3dos');
    const hwPenalty = (isPlus3Only ? -35 : 0) + (hasUnsupportedHardware ? -120 : 0);

    // Prefer Russian/English releases slightly when multiple language builds exist
    const lowerName = rawFileName.toLowerCase();
    const hasRuEn =
      languages.includes('RU') ||
      languages.includes('EN') ||
      lowerName.includes('(ru)') ||
      lowerName.includes('(en)');
    const langBonus = hasRuEn ? 4 : 0;

    const score = bestFormatScore + typeScore + hwPenalty + langBonus;
    const version =
      typeof rel.version === 'string' && rel.version.trim().length > 0
        ? decodeHtmlEntities(rel.version).trim()
        : null;

    candidates.push({
      id: rel.id,
      title: decodeHtmlEntities(rel.title || rawFileName).trim(),
      fileName: rawFileName,
      fileUrl: rel.file,
      releaseType,
      formats,
      languages,
      year: parseOptionalYear(rel.year),
      version,
      hardwareRequired: hw,
      hasUnsupportedHardware,
      score,
      recommendedMachine: inferRecommendedMachine(formats, hw),
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.id - b.id);
  return candidates;
}

export function sanitizeZxArtSearch(search: string): string {
  return search.replace(/[/;\\]+/g, ' ').trim();
}

export const ZXART_SEARCH_HISTORY_STORAGE_KEY = 'zx_art_search_history_v1';
export const ZXART_SEARCH_HISTORY_LIMIT = 8;

function getSafeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
  } catch {
    // Ignore restricted storage access
  }
  return null;
}

export function sanitizeSearchHistoryList(
  raw: unknown,
  limit = ZXART_SEARCH_HISTORY_LIMIT
): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

export function saveZxArtSearchHistory(history: readonly string[]): void {
  const storage = getSafeLocalStorage();
  if (!storage) return;
  try {
    storage.setItem(ZXART_SEARCH_HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    // Ignore quota errors
  }
}

export function loadZxArtSearchHistory(limit = ZXART_SEARCH_HISTORY_LIMIT): string[] {
  const storage = getSafeLocalStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(ZXART_SEARCH_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    return sanitizeSearchHistoryList(JSON.parse(raw), limit);
  } catch {
    return [];
  }
}

export function addZxArtSearchHistory(
  history: readonly string[],
  query: string,
  limit = ZXART_SEARCH_HISTORY_LIMIT
): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [...history];
  const lower = trimmed.toLowerCase();
  if (history.length > 0 && history[0].trim() === trimmed) {
    return history as string[];
  }
  const next = [trimmed];
  for (const item of history) {
    const clean = item.trim();
    if (!clean || clean.toLowerCase() === lower) continue;
    next.push(clean);
    if (next.length >= limit) break;
  }
  saveZxArtSearchHistory(next);
  return next;
}

export const TOUCH_KEYBOARD_OPEN_DELTA_PX = 100;
export const TOUCH_KEYBOARD_CLOSE_TOLERANCE_PX = 60;
export const TOUCH_KEYBOARD_ORIENTATION_WIDTH_DELTA_PX = 80;

export interface TouchKeyboardViewportState {
  baselineWidth: number;
  baselineHeight: number;
  minKeyboardHeight: number;
  keyboardOpen: boolean;
}

export function createTouchKeyboardViewportState(
  width: number,
  height: number
): TouchKeyboardViewportState {
  return {
    baselineWidth: width,
    baselineHeight: height,
    minKeyboardHeight: height,
    keyboardOpen: false,
  };
}

/**
 * Tracks visualViewport/window height changes while a touch-focused search input is active.
 * Returns true only on the transition where an opened on-screen keyboard closes.
 */
export function evaluateTouchKeyboardResize(
  state: TouchKeyboardViewportState,
  width: number,
  height: number
): boolean {
  if (width <= 0 || height <= 0) return false;

  // Ignore orientation / horizontal layout resizes and re-anchor baseline
  if (Math.abs(width - state.baselineWidth) > TOUCH_KEYBOARD_ORIENTATION_WIDTH_DELTA_PX) {
    state.baselineWidth = width;
    state.baselineHeight = height;
    state.minKeyboardHeight = height;
    state.keyboardOpen = false;
    return false;
  }

  if (!state.keyboardOpen) {
    if (height > state.baselineHeight) {
      state.baselineHeight = height;
      state.minKeyboardHeight = height;
    } else if (state.baselineHeight - height >= TOUCH_KEYBOARD_OPEN_DELTA_PX) {
      state.keyboardOpen = true;
      state.minKeyboardHeight = height;
    }
    return false;
  }

  if (height < state.minKeyboardHeight) {
    state.minKeyboardHeight = height;
    return false;
  }

  const restoredNearBaseline = height >= state.baselineHeight - TOUCH_KEYBOARD_CLOSE_TOLERANCE_PX;
  const roseEnough = height - state.minKeyboardHeight >= TOUCH_KEYBOARD_OPEN_DELTA_PX;
  if (restoredNearBaseline || roseEnough) {
    state.keyboardOpen = false;
    if (height > state.baselineHeight) {
      state.baselineHeight = height;
    }
    state.minKeyboardHeight = state.baselineHeight;
    return true;
  }

  return false;
}

export interface SearchBlurCommitCheck {
  query: string;
  focusedViaTouch: boolean;
  keyboardOpen: boolean;
  suppressed: boolean;
  alreadyCommitted: boolean;
  windowLostFocus: boolean;
}

/**
 * Returns true only when search input blur represents dismissing a touch keyboard.
 * Desktop mouse/keyboard blurs never auto-commit unfinished queries.
 */
export function shouldCommitHistoryOnSearchBlur(check: SearchBlurCommitCheck): boolean {
  if (check.alreadyCommitted || check.suppressed || check.windowLostFocus) return false;
  if (check.query.trim().length === 0) return false;
  return check.keyboardOpen || check.focusedViaTouch;
}

export function removeZxArtSearchHistoryItem(
  history: readonly string[],
  query: string
): string[] {
  const lower = query.trim().toLowerCase();
  const next = history.filter((item) => item.trim().toLowerCase() !== lower);
  saveZxArtSearchHistory(next);
  return next;
}

export function clearZxArtSearchHistory(): string[] {
  const storage = getSafeLocalStorage();
  if (storage) {
    try {
      storage.removeItem(ZXART_SEARCH_HISTORY_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
  }
  return [];
}

export function buildZxArtReleaseGameKey(prodId: number, releaseId: number): string {
  return `zxart:${prodId}:rel:${releaseId}`;
}

export function formatZxArtReleaseDisplayTitle(
  gameTitle: string,
  release: Pick<ZxArtPlayableRelease, 'title' | 'fileName'>
): string {
  const cleanGame = gameTitle.trim();
  const cleanRel = release.title.trim();
  const cleanFile = release.fileName.trim();
  if (
    cleanRel.length > 0 &&
    cleanRel.toLowerCase() !== cleanGame.toLowerCase() &&
    cleanRel.toLowerCase() !== cleanFile.toLowerCase()
  ) {
    return `${cleanGame} — ${cleanRel} (${cleanFile})`;
  }
  return `${cleanGame} — ${cleanFile || cleanRel}`;
}

const DIRECT_DISK_FORMATS = new Set([
  'trd',
  'scl',
  'fdi',
  'td0',
  'udi',
  'dsk',
  'mgt',
  'img',
  'opd',
  'opu',
  'd40',
  'd80',
  'hob',
  'hobeta',
  '$b',
  '$c',
  '$d',
  '$#',
  '!b',
  '!c',
]);

const CONTAINER_ARCHIVE_FORMATS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'gzip',
  'tgz',
  'bz2',
  'bzip2',
  'tbz',
  'tbz2',
  'xz',
  'txz',
  'lzma',
  'tlz',
  'zst',
  'tzst',
  'lzh',
  'lha',
  'arj',
  'cab',
]);

/**
 * Classifies a release for TR-DOS floppy insertion:
 * 0 = known floppy disk image (.trd/.scl/.fdi/etc.)
 * 1 = generic archive (.zip/.rar/etc.) without explicit inner format metadata
 * 2 = non-disk release (.tap/.tzx/.sna) or unsupported hardware
 */
export function getDiskReleaseTier(
  release: Pick<ZxArtPlayableRelease, 'formats' | 'hasUnsupportedHardware'>
): 0 | 1 | 2 {
  if (release.hasUnsupportedHardware) return 2;
  if (release.formats.length === 0) return 1;
  let allArchives = true;
  for (let i = 0; i < release.formats.length; i++) {
    const fmt = release.formats[i].toLowerCase();
    if (DIRECT_DISK_FORMATS.has(fmt)) return 0;
    if (!CONTAINER_ARCHIVE_FORMATS.has(fmt)) {
      allArchives = false;
    }
  }
  return allArchives ? 1 : 2;
}

export function sortReleasesForCatalogMode(
  releases: readonly ZxArtPlayableRelease[],
  mode: 'game' | 'disk'
): readonly ZxArtPlayableRelease[] {
  if (mode === 'game' || releases.length <= 1) return releases;
  return [...releases].sort((a, b) => getDiskReleaseTier(a) - getDiskReleaseTier(b));
}

export function resolveCatalogOpenSelection(
  mode: 'game' | 'disk',
  currentSelection: ZxArtGameSummary | null,
  lastLaunchedGame: ZxArtGameSummary | null
): ZxArtGameSummary | null {
  if (mode === 'disk') {
    return lastLaunchedGame;
  }
  return currentSelection;
}

export function sortZxArtGames(
  games: readonly ZxArtGameSummary[],
  order: ZxArtSortOrder
): ZxArtGameSummary[] {
  const sorted = [...games];
  sorted.sort((a, b) => {
    if (order === 'title,asc') {
      return a.title.localeCompare(b.title, 'ru') || a.id - b.id;
    }
    if (order === 'year,desc') {
      const yearDiff = (b.year ?? 0) - (a.year ?? 0);
      if (yearDiff !== 0) return yearDiff;
      return (b.votes ?? 0) - (a.votes ?? 0) || a.id - b.id;
    }
    const voteDiff = (b.votes ?? 0) - (a.votes ?? 0);
    if (voteDiff !== 0) return voteDiff;
    return (b.votesAmount ?? 0) - (a.votesAmount ?? 0) || a.id - b.id;
  });
  return sorted;
}

export interface ZxArtReleaseFormatOption {
  format: string;
  count: number;
}

export function extractAvailableReleaseFormats(
  releases: readonly ZxArtPlayableRelease[]
): ZxArtReleaseFormatOption[] {
  const counts = new Map<string, number>();
  for (let i = 0; i < releases.length; i++) {
    const formats = releases[i].formats;
    if (formats.length === 0) continue;
    let seenSingle: string | null = null;
    let seenSet: Set<string> | null = null;
    for (let j = 0; j < formats.length; j++) {
      const fmt = formats[j].trim().toLowerCase();
      if (!fmt) continue;
      if (seenSingle === null) {
        seenSingle = fmt;
      } else if (seenSet === null) {
        if (seenSingle === fmt) continue;
        seenSet = new Set([seenSingle, fmt]);
      } else if (seenSet.has(fmt)) {
        continue;
      } else {
        seenSet.add(fmt);
      }
      counts.set(fmt, (counts.get(fmt) ?? 0) + 1);
    }
  }

  const out: ZxArtReleaseFormatOption[] = [];
  for (const [format, count] of counts) {
    out.push({ format, count });
  }
  return out;
}

export function filterReleasesByFormat(
  releases: readonly ZxArtPlayableRelease[],
  activeFormat: string | null
): readonly ZxArtPlayableRelease[] {
  if (!activeFormat) return releases;
  const target = activeFormat.trim().toLowerCase();
  if (!target) return releases;
  return releases.filter((rel) => {
    for (let i = 0; i < rel.formats.length; i++) {
      if (rel.formats[i].trim().toLowerCase() === target) {
        return true;
      }
    }
    return false;
  });
}
