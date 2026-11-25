import OBR from "@owlbear-rodeo/sdk";
import "./style.css";
import { DEFAULTS, cleanSettings, loadSettings, saveSettings } from "./shared.js";

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
  reset: el("#reset"),
};

function status(title, detail, state = "ready") {
  ui.title.textContent = title;
  ui.detail.textContent = detail;
  ui.dot.className = "status-dot " + state;
}

function writeControls(s) {
  ui.enabled.checked = s.enabled;
  ui.camera.value = String(s.cameraGain);
  ui.token.value = String(s.tokenGain);
  ui.smoothness.value = String(s.smoothness);
  updateSliderLabels();
}

function readControls() {
  return cleanSettings({
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

let saveTimer = null;
function scheduleSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      const saved = await saveSettings(readControls());
      status(
        saved.enabled ? "Параллакс включён" : "Параллакс выключен",
        "Настройки применены и сохранены в этом браузере.",
      );
    } catch (error) {
      console.error(error);
      status("Не удалось сохранить настройки", String((error && error.message) || error), "error");
    }
  }, 120);
}

function describeSelection(selectedIds, items) {
  if (!selectedIds || !selectedIds.length) {
    return ["Токен не выбран", "Выберите токен на слое CHARACTER, чтобы фон следил за его движением."];
  }
  const token = items.find(
    (item) => selectedIds.includes(item.id) && item.type === "IMAGE" && item.layer === "CHARACTER",
  );
  if (token) return ["Токен выбран", "Следим за: " + (token.name || "токен без имени") + "."];
  return ["Нет подходящего токена", "Среди выбранных объектов нет изображений на слое CHARACTER."];
}

async function refreshSelectionStatus(selectedIds) {
  if (!ui.enabled.checked) return; // не перетираем сообщение о сохранении, если пользователь крутит настройки
  try {
    const ids = selectedIds ?? ((await OBR.player.getSelection()) || []);
    const items = ids.length ? await OBR.scene.items.getItems((item) => ids.includes(item.id)) : [];
    const [title, detail] = describeSelection(ids, items);
    status(title, detail);
  } catch (error) {
    console.warn("[SS13 Space Parallax] Selection check failed", error);
    status("Нет доступа к сцене", "Откройте сцену и выберите токен персонажа.", "error");
  }
}

async function init() {
  if (!OBR.isAvailable) {
    status("Откройте панель внутри Owlbear", "Эта страница запускается из расширения в комнате Owlbear Rodeo.", "error");
    [ui.enabled, ui.camera, ui.token, ui.smoothness, ui.reset].forEach((node) => (node.disabled = true));
    return;
  }

  try {
    await new Promise((resolve) => OBR.onReady(resolve));
    writeControls(await loadSettings());
    status("Owlbear подключён", "Настройки загружены.");
    await refreshSelectionStatus();

    [ui.enabled, ui.camera, ui.token, ui.smoothness].forEach((node) => {
      node.addEventListener("input", () => {
        updateSliderLabels();
        scheduleSave();
      });
    });

    ui.reset.addEventListener("click", () => {
      writeControls({ ...DEFAULTS, enabled: ui.enabled.checked });
      scheduleSave();
    });

    OBR.player.onChange((player) => void refreshSelectionStatus(player.selection || []));
    OBR.scene.items.onChange(() => void refreshSelectionStatus());
  } catch (error) {
    console.error(error);
    status("Ошибка SDK", String((error && error.message) || error), "error");
  }
}

init();
