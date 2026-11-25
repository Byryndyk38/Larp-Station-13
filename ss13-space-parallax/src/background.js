import OBR, { buildImage } from "@owlbear-rodeo/sdk";

const EXTENSION_ID = "com.ss13-space-parallax";
const META_KEY = EXTENSION_ID + ".settings";
const TILE_SIZE = 1024;
const TICK_MS = 100;
const MAX_TILES = 5;
const DEFAULTS = { enabled: false, cameraGain: 100, tokenGain: 100, smoothness: 70 };
const LAYERS = [
  { key: "far", file: "deep-space.svg", camera: 0.035, token: 0.010, z: -100000 },
  { key: "nebula", file: "nebula.svg", camera: 0.105, token: 0.035, z: -99999 },
  { key: "near", file: "near-stars.svg", camera: 0.235, token: 0.080, z: -99998 },
];

let settings = { ...DEFAULTS };
let running = false;
let timer = null;
let busy = false;
let itemCache = [];
let tileRecords = [];
let columns = 3;
let rows = 3;
let dpi = 100;
let lastCamera = null;
let lastToken = null;
let selectedTokenId = null;
let targetOffsets = Object.fromEntries(LAYERS.map((layer) => [layer.key, { x: 0, y: 0 }]));
let renderedOffsets = Object.fromEntries(LAYERS.map((layer) => [layer.key, { x: 0, y: 0 }]));
let lastFrame = performance.now();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function cleanSettings(value) {
  return {
    enabled: Boolean(value && value.enabled !== undefined ? value.enabled : DEFAULTS.enabled),
    cameraGain: clamp(finite(value && value.cameraGain, DEFAULTS.cameraGain), 0, 200),
    tokenGain: clamp(finite(value && value.tokenGain, DEFAULTS.tokenGain), 0, 200),
    smoothness: clamp(finite(value && value.smoothness, DEFAULTS.smoothness), 10, 95),
  };
}

async function readSettings() {
  try {
    const metadata = await OBR.player.getMetadata();
    return cleanSettings(metadata && metadata[META_KEY]);
  } catch (error) {
    console.warn("[SS13 Space Parallax] Could not read settings", error);
    return { ...DEFAULTS };
  }
}

function resetMotion(camera, token) {
  lastCamera = camera ? { x: camera.x, y: camera.y } : null;
  lastToken = token ? { x: token.x, y: token.y } : null;
  lastFrame = performance.now();
  for (const layer of LAYERS) {
    targetOffsets[layer.key] = { x: 0, y: 0 };
    renderedOffsets[layer.key] = { x: 0, y: 0 };
  }
}

function isCharacterImage(item) {
  return Boolean(item && item.type === "IMAGE" && item.layer === "CHARACTER");
}

async function getTrackedToken() {
  try {
    const selectedIds = (await OBR.player.getSelection()) || [];
    const token = selectedIds
      .map((id) => itemCache.find((item) => item.id === id))
      .find(isCharacterImage);
    if (!token) return null;
    return {
      id: token.id,
      x: finite(token.position && token.position.x, 0),
      y: finite(token.position && token.position.y, 0),
    };
  } catch (error) {
    console.debug("[SS13 Space Parallax] Selection unavailable", error);
    return null;
  }
}

function tileUrl(file) {
  return new URL("./assets/" + file, window.location.href).href;
}

function tileCounts(width, height, scale) {
  const safeScale = Math.max(0.05, finite(scale, 1));
  const worldWidth = Math.max(TILE_SIZE, finite(width, TILE_SIZE) / safeScale);
  const worldHeight = Math.max(TILE_SIZE, finite(height, TILE_SIZE) / safeScale);
  return {
    columns: clamp(Math.ceil(worldWidth / TILE_SIZE) + 2, 3, MAX_TILES),
    rows: clamp(Math.ceil(worldHeight / TILE_SIZE) + 2, 3, MAX_TILES),
  };
}

function makeTile(layer, column, row) {
  return buildImage(
    {
      width: TILE_SIZE,
      height: TILE_SIZE,
      url: tileUrl(layer.file),
      mime: "image/svg+xml",
    },
    {
      dpi,
      offset: { x: TILE_SIZE / 2, y: TILE_SIZE / 2 },
    },
  )
    .name("SS13 Space Parallax — " + layer.key)
    .description("Local parallax background tile")
    .position({ x: 0, y: 0 })
    .layer("MAP")
    .zIndex(layer.z)
    .locked(true)
    .visible(true)
    .disableHit(true)
    .disableAutoZIndex(true)
    .metadata({
      [EXTENSION_ID]: { role: "tile", layer: layer.key, column, row },
    })
    .build();
}

async function removeTiles() {
  if (!tileRecords.length) return;
  const ids = tileRecords.map((record) => record.id);
  tileRecords = [];
  try {
    await OBR.scene.local.deleteItems(ids);
  } catch (error) {
    console.warn("[SS13 Space Parallax] Could not remove local tiles", error);
  }
}

async function placeTiles(camera) {
  if (!tileRecords.length) return;
  const positions = new Map();

  for (const layer of LAYERS) {
    const offset = renderedOffsets[layer.key];
    const anchorX = camera.x + offset.x;
    const anchorY = camera.y + offset.y;
    const firstColumn = Math.floor(anchorX / TILE_SIZE) - Math.floor(columns / 2);
    const firstRow = Math.floor(anchorY / TILE_SIZE) - Math.floor(rows / 2);

    for (const record of tileRecords) {
      if (record.layer !== layer.key) continue;
      const col = record.slot % columns;
      const row = Math.floor(record.slot / columns);
      positions.set(record.id, {
        x: (firstColumn + col + 0.5) * TILE_SIZE + offset.x,
        y: (firstRow + row + 0.5) * TILE_SIZE + offset.y,
      });
    }
  }

  await OBR.scene.local.updateItems(
    tileRecords.map((record) => record.id),
    (items) => {
      for (const item of items) {
        const position = positions.get(item.id);
        if (position) {
          item.position.x = position.x;
          item.position.y = position.y;
        }
      }
    },
    true,
  );
}

async function createTiles(camera) {
  await removeTiles();
  const values = await Promise.all([
    OBR.viewport.getWidth(),
    OBR.viewport.getHeight(),
    OBR.viewport.getScale(),
    OBR.scene.grid.getDpi(),
  ]);
  dpi = finite(values[3], 100);
  const counts = tileCounts(values[0], values[1], values[2]);
  columns = counts.columns;
  rows = counts.rows;

  const items = [];
  const records = [];
  for (const layer of LAYERS) {
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const item = makeTile(layer, col, row);
        items.push(item);
        records.push({ id: item.id, layer: layer.key, slot: row * columns + col });
      }
    }
  }
  await OBR.scene.local.addItems(items);
  tileRecords = records;
  await placeTiles(camera);
}

function addMovement(camera, token) {
  if (!lastCamera) {
    resetMotion(camera, token);
    return;
  }

  const cameraDelta = { x: camera.x - lastCamera.x, y: camera.y - lastCamera.y };
  let tokenRelative = { x: 0, y: 0 };

  if (token && token.id === selectedTokenId && lastToken) {
    const tokenDelta = { x: token.x - lastToken.x, y: token.y - lastToken.y };
    const moved = Math.abs(tokenDelta.x) + Math.abs(tokenDelta.y) > 0.25;
    if (moved) {
      tokenRelative = {
        x: tokenDelta.x - cameraDelta.x,
        y: tokenDelta.y - cameraDelta.y,
      };
    }
  }

  for (const layer of LAYERS) {
    const target = targetOffsets[layer.key];
    target.x += -cameraDelta.x * layer.camera * settings.cameraGain / 100
      - tokenRelative.x * layer.token * settings.tokenGain / 100;
    target.y += -cameraDelta.y * layer.camera * settings.cameraGain / 100
      - tokenRelative.y * layer.token * settings.tokenGain / 100;
  }

  lastCamera = { x: camera.x, y: camera.y };
  lastToken = token ? { x: token.x, y: token.y } : null;
}

async function frame() {
  if (!running || busy) return;
  busy = true;
  try {
    const camera = await OBR.viewport.getPosition();
    const token = await getTrackedToken();

    if ((token && token.id) !== selectedTokenId) {
      selectedTokenId = token ? token.id : null;
      lastToken = token ? { x: token.x, y: token.y } : null;
    }

    addMovement(camera, token);

    const now = performance.now();
    const elapsed = Math.max(1, now - lastFrame);
    lastFrame = now;
    const tau = 30 + settings.smoothness * 1.7;
    const alpha = 1 - Math.exp(-elapsed / tau);
    let changed = false;

    for (const layer of LAYERS) {
      const target = targetOffsets[layer.key];
      const current = renderedOffsets[layer.key];
      const oldX = current.x;
      const oldY = current.y;
      current.x += (target.x - current.x) * alpha;
      current.y += (target.y - current.y) * alpha;
      if (Math.abs(current.x - oldX) > 0.01 || Math.abs(current.y - oldY) > 0.01) changed = true;
    }

    if (changed) await placeTiles(camera);
  } catch (error) {
    console.warn("[SS13 Space Parallax] Frame failed", error);
  } finally {
    busy = false;
  }
}

async function stopEngine() {
  running = false;
  if (timer) window.clearInterval(timer);
  timer = null;
  await removeTiles();
  resetMotion(null, null);
  selectedTokenId = null;
}

async function startEngine() {
  if (running || !(await OBR.scene.isReady())) return;
  running = true;
  try {
    itemCache = await OBR.scene.items.getItems();
    const camera = await OBR.viewport.getPosition();
    const token = await getTrackedToken();
    selectedTokenId = token ? token.id : null;
    resetMotion(camera, token);
    await createTiles(camera);
    timer = window.setInterval(frame, TICK_MS);
  } catch (error) {
    running = false;
    console.error("[SS13 Space Parallax] Could not start", error);
    await removeTiles();
  }
}

async function reconcileSettings() {
  const next = await readSettings();
  const previousEnabled = settings.enabled;
  settings = next;
  if (settings.enabled && !previousEnabled) await startEngine();
  else if (!settings.enabled && previousEnabled) await stopEngine();
}

async function boot() {
  settings = await readSettings();
  OBR.scene.items.onChange((items) => { itemCache = items; });
  OBR.player.onChange(() => { void reconcileSettings(); });
  OBR.scene.onReadyChange((ready) => {
    if (ready && settings.enabled) void startEngine();
    else if (!ready) void stopEngine();
  });
  if (settings.enabled && await OBR.scene.isReady()) await startEngine();
}

OBR.onReady(() => { void boot(); });
