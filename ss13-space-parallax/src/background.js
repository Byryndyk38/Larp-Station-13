import OBR, { buildImage } from "@owlbear-rodeo/sdk";
import {
  EXTENSION_ID,
  DEFAULTS,
  cleanSettings,
  clamp,
  finite,
  loadSettings,
  settingsFromPlayer,
} from "./shared.js";

/*
 * Как это работает
 * ----------------
 * Owlbear не умеет рисовать «фон, прибитый к экрану», поэтому мы имитируем его
 * локальными (видимыми только этому игроку) картинками в слое MAP под картой.
 * Каждый тик мы:
 *   1. читаем положение/масштаб камеры;
 *   2. считаем, на сколько пикселей ЭКРАНА должен сдвинуться каждый слой
 *      (камера и выбранный токен двигают слои с разной «глубиной»);
 *   3. переводим экранные координаты тайлов в мировые и обновляем их.
 *
 * Тайлы имеют постоянный размер на экране (не зависят от зума), поэтому
 * достаточно 2×2…7×5 картинок на слой — даже при сильном отдалении карты.
 *
 * ВАЖНО: OBR.viewport.getPosition() — это НЕ центр камеры в мире, а сдвиг
 * мира на экране: экран = мир × scale + position. Центр камеры в мире:
 *   ((width/2 − position.x) / scale, (height/2 − position.y) / scale).
 */

const MAX_COLS = 7;
const MAX_ROWS = 5;
const ACTIVE_TICK_MS = 16;
const IDLE_TICK_MS = 90;
const IDLE_AFTER_TICKS = 45;
const SIZE_REFRESH_MS = 1000;
const EPSILON = 0.02; // не шлём обновление, если тайл сдвинулся меньше, чем на это

// camera/token — доля движения, которую повторяет слой (0 = прибит к экрану, 1 = как карта).
// size — размер тайла на экране в px; px — размер исходной картинки.
const LAYERS = [
  { key: "far", file: "deep-space.png", px: 1024, size: 1024, camera: 0.035, token: 0.01, z: -100000, overlap: 1 },
  { key: "nebula", file: "nebula.png", px: 512, size: 2048, camera: 0.105, token: 0.035, z: -99999, overlap: 0 },
  { key: "near", file: "near-stars.png", px: 1024, size: 1024, camera: 0.235, token: 0.08, z: -99998, overlap: 0 },
];

let settings = { ...DEFAULTS };
let sceneReady = false;
let running = false;
let runId = 0;
let rebuilding = false;

let sceneItems = [];
let selection = [];
let trackedId = null;

let view = { w: 1280, h: 720, x: 0, y: 0, scale: 1 };
let sceneDpi = 150;
let lastSizeCheck = 0;

let tileSets = []; // [{ layer, cols, rows, tiles: [{ item, col, row, wx, wy, ws }] }]
let motion = {};
let lastCenter = null;
let lastToken = null;
let lastFrame = 0;
let idleTicks = 0;

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
const mod = (value, size) => ((value % size) + size) % size;

function resetMotion() {
  motion = Object.fromEntries(LAYERS.map((layer) => [layer.key, { tx: 0, ty: 0, rx: 0, ry: 0 }]));
  lastCenter = null;
  lastToken = null;
  lastFrame = performance.now();
  idleTicks = 0;
}

/* ---------- выбранный токен ---------- */

function isCharacterImage(item) {
  return Boolean(item && item.type === "IMAGE" && item.layer === "CHARACTER");
}

function refreshTrackedToken() {
  // «Липкий» режим: помним последний выбранный токен CHARACTER, пока не выберут другой.
  for (const id of selection) {
    const item = sceneItems.find((candidate) => candidate.id === id);
    if (isCharacterImage(item)) {
      trackedId = item.id;
      return;
    }
  }
  if (trackedId && !sceneItems.some((item) => item.id === trackedId)) trackedId = null;
}

function trackedTokenPosition() {
  if (!trackedId) return null;
  const item = sceneItems.find((candidate) => candidate.id === trackedId);
  if (!item || !item.position) return null;
  return { id: item.id, x: finite(item.position.x, 0), y: finite(item.position.y, 0) };
}

/* ---------- тайлы ---------- */

function tileUrl(file) {
  return new URL("./tiles/" + file, window.location.href).href;
}

function gridFor(layer) {
  return {
    cols: clamp(Math.ceil(view.w / layer.size) + 1, 2, MAX_COLS),
    rows: clamp(Math.ceil(view.h / layer.size) + 1, 2, MAX_ROWS),
  };
}

function makeTile(layer, col, row) {
  return buildImage(
    { width: layer.px, height: layer.px, url: tileUrl(layer.file), mime: "image/png" },
    { dpi: sceneDpi, offset: { x: layer.px / 2, y: layer.px / 2 } },
  )
    .name("SS13 Space Parallax — " + layer.key)
    .description("Локальный тайл параллакс-фона")
    .position({ x: 0, y: 0 })
    .layer("MAP")
    .zIndex(layer.z)
    .locked(true)
    .visible(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .metadata({ [EXTENSION_ID]: { role: "tile", layer: layer.key, col, row } })
    .build();
}

async function deleteTiles() {
  const ids = tileSets.flatMap((set) => set.tiles.map((tile) => tile.item.id));
  tileSets = [];
  try {
    // Заодно чистим «осиротевшие» тайлы от прошлого запуска расширения.
    const stale = await OBR.scene.local.getItems(
      (item) => Boolean(item.metadata && item.metadata[EXTENSION_ID] && item.metadata[EXTENSION_ID].role === "tile"),
    );
    for (const item of stale) if (!ids.includes(item.id)) ids.push(item.id);
    if (ids.length) await OBR.scene.local.deleteItems(ids);
  } catch (error) {
    console.warn("[SS13 Space Parallax] Не удалось удалить тайлы", error);
  }
}

async function buildTiles() {
  await deleteTiles();
  sceneDpi = finite(await OBR.scene.grid.getDpi(), 150);

  const sets = [];
  const toAdd = [];
  for (const layer of LAYERS) {
    const { cols, rows } = gridFor(layer);
    const tiles = [];
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const item = makeTile(layer, col, row);
        toAdd.push(item);
        // Infinity гарантирует, что первое сравнение «значение изменилось» сработает (с NaN оно всегда ложно).
        tiles.push({ item, col, row, wx: Infinity, wy: Infinity, ws: Infinity });
      }
    }
    sets.push({ layer, cols, rows, tiles });
  }
  await OBR.scene.local.addItems(toAdd);
  tileSets = sets;
}

async function rebuildTiles() {
  if (rebuilding || !running) return;
  rebuilding = true;
  try {
    await buildTiles();
    idleTicks = 0;
  } catch (error) {
    console.warn("[SS13 Space Parallax] Не удалось пересоздать тайлы", error);
  } finally {
    rebuilding = false;
  }
}

async function renderTiles() {
  const changed = [];
  const values = [];
  const { x: vx, y: vy, scale } = view;

  for (const set of tileSets) {
    const { layer } = set;
    const m = motion[layer.key];
    const ox = mod(m.rx, layer.size);
    const oy = mod(m.ry, layer.size);
    const side = layer.size + layer.overlap; // небольшой нахлёст у непрозрачного слоя убирает швы
    const worldScale = side / scale / layer.px;

    for (const tile of set.tiles) {
      const screenX = ox + (tile.col - 1) * layer.size + side / 2;
      const screenY = oy + (tile.row - 1) * layer.size + side / 2;
      const wx = (screenX - vx) / scale;
      const wy = (screenY - vy) / scale;

      if (
        Math.abs(wx - tile.wx) > EPSILON ||
        Math.abs(wy - tile.wy) > EPSILON ||
        Math.abs(worldScale - tile.ws) > 1e-6
      ) {
        changed.push(tile);
        values.push({ wx, wy, ws: worldScale });
      }
    }
  }
  if (!changed.length) return false;

  await OBR.scene.local.updateItems(
    changed.map((tile) => tile.item), // передаём объекты, чтобы SDK не делал лишний запрос за ними
    (drafts) => {
      for (let i = 0; i < drafts.length; i += 1) {
        drafts[i].position.x = values[i].wx;
        drafts[i].position.y = values[i].wy;
        drafts[i].scale.x = values[i].ws;
        drafts[i].scale.y = values[i].ws;
      }
    },
    true,
  );

  // База для следующего сравнения (immer не мутирует исходные объекты).
  changed.forEach((tile, i) => {
    const v = values[i];
    tile.wx = v.wx;
    tile.wy = v.wy;
    tile.ws = v.ws;
    tile.item = {
      ...tile.item,
      position: { x: v.wx, y: v.wy },
      scale: { x: v.ws, y: v.ws },
    };
  });
  return true;
}

/* ---------- движение ---------- */

function accumulateMovement(center, token) {
  if (!lastCenter) {
    lastCenter = center;
    lastToken = token;
    return false;
  }

  const dcx = center.x - lastCenter.x;
  const dcy = center.y - lastCenter.y;
  let dtx = 0;
  let dty = 0;
  if (token && lastToken && token.id === lastToken.id) {
    dtx = token.x - lastToken.x;
    dty = token.y - lastToken.y;
  }
  lastCenter = center;
  lastToken = token;

  if (dcx === 0 && dcy === 0 && dtx === 0 && dty === 0) return false;

  const cameraGain = settings.cameraGain / 100;
  const tokenGain = settings.tokenGain / 100;
  const scale = view.scale;
  for (const layer of LAYERS) {
    const m = motion[layer.key];
    // Слой смещается на экране в ту же сторону, что и карта, но медленнее (камера),
    // и в сторону, противоположную движению токена (как в SS13).
    m.tx += -(dcx * layer.camera * cameraGain + dtx * layer.token * tokenGain) * scale;
    m.ty += -(dcy * layer.camera * cameraGain + dty * layer.token * tokenGain) * scale;
  }
  return true;
}

function smoothMotion() {
  const now = performance.now();
  const elapsed = clamp(now - lastFrame, 1, 250);
  lastFrame = now;
  const tau = 30 + settings.smoothness * 1.7;
  const alpha = 1 - Math.exp(-elapsed / tau);
  let moving = false;

  for (const layer of LAYERS) {
    const m = motion[layer.key];
    const dx = m.tx - m.rx;
    const dy = m.ty - m.ry;
    m.rx += dx * alpha;
    m.ry += dy * alpha;
    if (Math.abs(dx) > 0.05 || Math.abs(dy) > 0.05) moving = true;

    // Держим числа маленькими: сдвиг на целое число тайлов ничего не меняет визуально.
    const kx = Math.floor(m.rx / layer.size);
    const ky = Math.floor(m.ry / layer.size);
    if (kx || ky) {
      m.rx -= kx * layer.size;
      m.tx -= kx * layer.size;
      m.ry -= ky * layer.size;
      m.ty -= ky * layer.size;
    }
  }
  return moving;
}

async function refreshViewportSize() {
  const now = performance.now();
  if (now - lastSizeCheck < SIZE_REFRESH_MS) return;
  lastSizeCheck = now;
  const [w, h] = await Promise.all([OBR.viewport.getWidth(), OBR.viewport.getHeight()]);
  const nextW = finite(w, view.w);
  const nextH = finite(h, view.h);
  const sizeChanged = nextW !== view.w || nextH !== view.h;
  view.w = nextW;
  view.h = nextH;

  if (
    sizeChanged &&
    tileSets.some((set) => {
      const { cols, rows } = gridFor(set.layer);
      return cols !== set.cols || rows !== set.rows;
    })
  ) {
    await rebuildTiles();
  }
}

async function tick() {
  if (rebuilding) return;
  await refreshViewportSize();
  if (!tileSets.length) return;

  const [position, scale] = await Promise.all([OBR.viewport.getPosition(), OBR.viewport.getScale()]);
  view.x = finite(position.x, 0);
  view.y = finite(position.y, 0);
  view.scale = Math.max(1e-4, finite(scale, 1));

  const center = {
    x: (view.w / 2 - view.x) / view.scale,
    y: (view.h / 2 - view.y) / view.scale,
  };

  const movedNow = accumulateMovement(center, trackedTokenPosition());
  const stillSliding = smoothMotion();
  const rendered = await renderTiles();

  idleTicks = movedNow || stillSliding || rendered ? 0 : idleTicks + 1;
}

async function loop(myRunId) {
  while (running && runId === myRunId) {
    const started = performance.now();
    try {
      await tick();
    } catch (error) {
      console.debug("[SS13 Space Parallax] tick failed", error);
    }
    const delay = idleTicks > IDLE_AFTER_TICKS ? IDLE_TICK_MS : ACTIVE_TICK_MS;
    await sleep(Math.max(0, delay - (performance.now() - started)));
  }
}

/* ---------- запуск / остановка ---------- */

async function startEngine() {
  if (running) return;
  running = true;
  const myRunId = (runId += 1);
  try {
    sceneItems = await OBR.scene.items.getItems();
    refreshTrackedToken();
    resetMotion();
    view.w = finite(await OBR.viewport.getWidth(), view.w);
    view.h = finite(await OBR.viewport.getHeight(), view.h);
    lastSizeCheck = performance.now();
    await buildTiles();
    void loop(myRunId);
  } catch (error) {
    running = false;
    console.error("[SS13 Space Parallax] Не удалось запустить", error);
    await deleteTiles();
  }
}

async function stopEngine() {
  if (!running) return;
  running = false;
  runId += 1;
  await deleteTiles();
  resetMotion();
}

async function syncEngine() {
  const shouldRun = settings.enabled && sceneReady;
  if (shouldRun && !running) await startEngine();
  else if (!shouldRun && running) await stopEngine();
}

function applySettings(next) {
  if (!next) return;
  const before = JSON.stringify(settings);
  settings = cleanSettings(next);
  if (JSON.stringify(settings) !== before) void syncEngine();
}

async function boot() {
  settings = await loadSettings();
  sceneReady = await OBR.scene.isReady();
  if (sceneReady) {
    sceneItems = await OBR.scene.items.getItems();
    selection = (await OBR.player.getSelection()) || [];
    refreshTrackedToken();
  }

  OBR.scene.items.onChange((items) => {
    sceneItems = items;
    refreshTrackedToken();
  });

  OBR.player.onChange((player) => {
    selection = player.selection || [];
    refreshTrackedToken();
    applySettings(settingsFromPlayer(player));
  });

  OBR.scene.onReadyChange(async (ready) => {
    sceneReady = ready;
    if (ready) {
      sceneItems = await OBR.scene.items.getItems();
      refreshTrackedToken();
    } else {
      trackedId = null;
      sceneItems = [];
    }
    // Новая сцена — локальные предметы пропали сами, поэтому перезапускаем движок целиком.
    if (running) await stopEngine();
    await syncEngine();
  });

  // Если в сцене поменяли DPI сетки, размер тайлов нужно пересчитать.
  OBR.scene.grid.onChange((grid) => {
    if (running && finite(grid && grid.dpi, sceneDpi) !== sceneDpi) void rebuildTiles();
  });

  await syncEngine();
}

OBR.onReady(() => {
  void boot();
});
