import OBR from "@owlbear-rodeo/sdk";
import "./style.css";

const META_KEY = "com.ss13-space-parallax.settings";
const DEFAULTS = { enabled: false, cameraGain: 100, tokenGain: 100, smoothness: 70 };
const el = (selector) => document.querySelector(selector);

const ui = {
  dot: el("#status-dot"),
  title: el("#status-title"),
  detail: el("#status-detail"),
  enabled: el("#enabled"),
  camera: el("#camera-gain"),
  cameraValue: el("#camera-value"),
  token: el("#token-gain"),
  tokenValue: el("#token-value"),
  smoothness: el("#smoothness"),
  smoothnessValue: el("#smoothness-value"),
  save: el("#save"),
};

function number(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function clean(value = {}) {
  return {
    enabled: Boolean(value.enabled ?? DEFAULTS.enabled),
    cameraGain: number(value.cameraGain, 0, 200, DEFAULTS.cameraGain),
    tokenGain: number(value.tokenGain, 0, 200, DEFAULTS.tokenGain),
    smoothness: number(value.smoothness, 10, 95, DEFAULTS.smoothness),
  };
}

function status(title, detail, state = "ready") {
  ui.title.textContent = title;
  ui.detail.textContent = detail;
  ui.dot.className = "status-dot " + state;
}

function writeControls(s) {
  ui.enabled.checked = s.enabled;
  ui.camera.value = String(s.cameraGain);
  ui.cameraValue.value = s.cameraGain + "%";
  ui.token.value = String(s.tokenGain);
  ui.tokenValue.value = s.tokenGain + "%";
  ui.smoothness.value = String(s.smoothness);
  ui.smoothnessValue.value = s.smoothness + "%";
}

function readControls() {
  return clean({
    enabled: ui.enabled.checked,
    cameraGain: ui.camera.value,
    tokenGain: ui.token.value,
    smoothness: ui.smoothness.value,
  });
}

function updateSliderLabels() {
  ui.cameraValue.value = ui.camera.value + "%";
  ui.tokenValue.value = ui.token.value + "%";
  ui.smoothnessValue.value = ui.smoothness.value + "%";
}

async function refreshTokenStatus() {
  try {
    const ids = await OBR.player.getSelection();
    if (!ids || !ids.length) {
      status("Owlbear подключён", "Выбери один токен на слое CHARACTER, чтобы добавить движение персонажа.");
      return;
    }
    const items = await OBR.scene.items.getItems((item) => ids.includes(item.id));
    const token = items.find((item) => item.type === "IMAGE" && item.layer === "CHARACTER");
    if (token) status("Персонаж отслеживается", "Выбран: " + (token.name || "токен без имени") + ".");
    else status("Owlbear подключён", "Среди выбранных объектов нет изображения на слое CHARACTER.");
  } catch (error) {
    console.warn("[SS13 Space Parallax] Selection check failed", error);
    status("Нет доступа к сцене", "Открой сцену и выбери токен персонажа.", "error");
  }
}

async function init() {
  if (!OBR.isAvailable) {
    status("Открой панель внутри Owlbear", "Эта страница запускается из расширения в комнате Owlbear Rodeo.", "error");
    ui.save.disabled = true;
    return;
  }

  try {
    await new Promise((resolve) => OBR.onReady(resolve));
    const metadata = await OBR.player.getMetadata();
    const current = clean(metadata && metadata[META_KEY]);
    writeControls(current);
    status("Owlbear подключён", "Настройки загружены.");
    await refreshTokenStatus();

    [ui.camera, ui.token, ui.smoothness].forEach((input) => input.addEventListener("input", updateSliderLabels));
    ui.save.addEventListener("click", async () => {
      ui.save.disabled = true;
      try {
        const next = readControls();
        await OBR.player.setMetadata({ [META_KEY]: next });
        status(next.enabled ? "Параллакс включён" : "Параллакс выключен", "Настройки сохранены для текущего игрока.");
      } catch (error) {
        console.error(error);
        status("Не удалось сохранить настройки", String(error && error.message ? error.message : error), "error");
      } finally {
        ui.save.disabled = false;
      }
    });

    window.setInterval(refreshTokenStatus, 1200);
  } catch (error) {
    console.error(error);
    status("Ошибка SDK", String(error && error.message ? error.message : error), "error");
  }
}

init();