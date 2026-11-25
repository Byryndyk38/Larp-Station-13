// Общий код для панели настроек (popover) и фонового движка (background).
import OBR from "@owlbear-rodeo/sdk";

export const EXTENSION_ID = "com.ss13-space-parallax";
export const META_KEY = EXTENSION_ID + ".settings";
const STORAGE_KEY = EXTENSION_ID + ".settings.v2";

export const DEFAULTS = Object.freeze({
  enabled: false,
  cameraGain: 100, // % — сила реакции на движение камеры
  tokenGain: 100, // % — сила реакции на движение выбранного токена
  smoothness: 70, // % — инерция (больше = плавнее, но с запаздыванием)
});

export const LIMITS = Object.freeze({
  cameraGain: [0, 200],
  tokenGain: [0, 200],
  smoothness: [10, 95],
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function cleanSettings(value) {
  const v = value && typeof value === "object" ? value : {};
  return {
    enabled: v.enabled === undefined ? DEFAULTS.enabled : Boolean(v.enabled),
    cameraGain: clamp(finite(v.cameraGain, DEFAULTS.cameraGain), ...LIMITS.cameraGain),
    tokenGain: clamp(finite(v.tokenGain, DEFAULTS.tokenGain), ...LIMITS.tokenGain),
    smoothness: clamp(finite(v.smoothness, DEFAULTS.smoothness), ...LIMITS.smoothness),
  };
}

function readLocal() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // localStorage может быть недоступен в песочнице iframe
  }
}

function writeLocal(settings) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    /* не страшно: настройки всё равно живут в metadata игрока до перезагрузки */
  }
}

/**
 * Настройки хранятся в двух местах:
 *  - metadata игрока Owlbear — мгновенная передача из панели в фоновый iframe;
 *  - localStorage — чтобы вкл/выкл и ползунки пережили перезагрузку страницы
 *    (metadata игрока сбрасывается вместе с сессией).
 */
export async function loadSettings() {
  try {
    const metadata = await OBR.player.getMetadata();
    if (metadata && metadata[META_KEY]) return cleanSettings(metadata[META_KEY]);
  } catch (error) {
    console.warn("[SS13 Space Parallax] Не удалось прочитать metadata игрока", error);
  }
  return cleanSettings(readLocal());
}

export async function saveSettings(settings) {
  const clean = cleanSettings(settings);
  writeLocal(clean);
  await OBR.player.setMetadata({ [META_KEY]: clean });
  return clean;
}

export function settingsFromPlayer(player) {
  return player && player.metadata && player.metadata[META_KEY]
    ? cleanSettings(player.metadata[META_KEY])
    : null;
}
