#!/usr/bin/env python3
"""Генератор бесшовных текстур космоса для SS13 Space Parallax.

Все три слоя строятся так, чтобы края тайла стыковались идеально:
шум берётся через FFT (он периодичен по определению), а звёзды рисуются
с «заворачиванием» координат по модулю размера тайла.

Запуск:  python3 scripts/generate_textures.py
Нужно:   pip install numpy pillow
"""
from pathlib import Path

import numpy as np
from PIL import Image

OUT = Path(__file__).resolve().parent.parent / "public" / "tiles"
OUT.mkdir(parents=True, exist_ok=True)


def periodic_noise(size, beta, rng):
    """Бесшовный шум с амплитудным спектром 1/f^beta, нормирован в 0..1."""
    white = rng.standard_normal((size, size))
    spectrum = np.fft.fft2(white)
    fy = np.fft.fftfreq(size)[:, None]
    fx = np.fft.fftfreq(size)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    spectrum *= 1.0 / (f ** beta)
    spectrum[0, 0] = 0.0
    field = np.real(np.fft.ifft2(spectrum))
    field -= field.min()
    field /= field.max()
    return field


def smoothstep(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def stamp(canvas, cx, cy, radius, color, strength, hard=0.35):
    """Рисует мягкую звезду с заворачиванием через края тайла."""
    size = canvas.shape[0]
    reach = int(np.ceil(radius * 4)) + 1
    ys = np.arange(-reach, reach + 1)
    xs = np.arange(-reach, reach + 1)
    dx, dy = np.meshgrid(xs - (cx - np.floor(cx)), ys - (cy - np.floor(cy)))
    d2 = dx * dx + dy * dy
    core = np.exp(-d2 / (2 * (radius * hard) ** 2 + 1e-6))
    glow = np.exp(-d2 / (2 * radius ** 2 + 1e-6)) * 0.35
    weight = (core + glow) * strength
    px = (np.floor(cx).astype(int) + xs) % size
    py = (np.floor(cy).astype(int) + ys) % size
    for c in range(canvas.shape[2]):
        np.add.at(canvas[:, :, c], (py[:, None], px[None, :]), weight * color[c])


def spikes(canvas, cx, cy, length, color, strength):
    """Лучи у самых ярких звёзд (крест)."""
    size = canvas.shape[0]
    for k in range(-length, length + 1):
        fall = (1 - abs(k) / (length + 1)) ** 2 * strength
        for axis in (0, 1):
            x = int(cx + (k if axis == 0 else 0)) % size
            y = int(cy + (k if axis == 1 else 0)) % size
            for c in range(3):
                canvas[y, x, c] += fall * color[c]


STAR_TINTS = [
    (0.80, 0.88, 1.00),
    (0.68, 0.80, 1.00),
    (1.00, 1.00, 1.00),
    (1.00, 0.93, 0.80),
    (1.00, 0.82, 0.70),
    (0.80, 0.75, 1.00),
]


def make_deep(rng, size=1024):
    """Непрозрачный фон: тёмный космос с еле заметной дымкой и пылью дальних звёзд."""
    haze = periodic_noise(size, 2.2, rng)
    base = np.zeros((size, size, 3))
    dark = np.array([0.008, 0.016, 0.040])
    tint = np.array([0.030, 0.050, 0.110])
    base += dark + (tint * smoothstep(0.35, 0.95, haze)[:, :, None])

    stars = np.zeros((size, size, 3))
    for _ in range(950):  # пыль
        x, y = rng.uniform(0, size, 2)
        tint_c = np.array(STAR_TINTS[rng.integers(len(STAR_TINTS))])
        stamp(stars, x, y, rng.uniform(0.45, 0.8), tint_c, rng.uniform(0.18, 0.55))
    for _ in range(90):  # заметнее
        x, y = rng.uniform(0, size, 2)
        tint_c = np.array(STAR_TINTS[rng.integers(len(STAR_TINTS))])
        stamp(stars, x, y, rng.uniform(0.8, 1.2), tint_c, rng.uniform(0.5, 0.9))

    img = np.clip(base + stars, 0, 1)
    Image.fromarray((img * 255).astype(np.uint8), "RGB").save(OUT / "deep-space.png", optimize=True)


def make_nebula(rng, size=512):
    """Полупрозрачные облака газа (RGBA), без резких краёв."""
    a = periodic_noise(size, 2.6, rng)
    b = periodic_noise(size, 2.6, rng)
    c = periodic_noise(size, 2.0, rng)
    detail = periodic_noise(size, 1.4, rng)

    purple = np.array([0.42, 0.25, 0.78])
    blue = np.array([0.14, 0.34, 0.70])
    magenta = np.array([0.72, 0.22, 0.58])

    wa = smoothstep(0.50, 0.85, a)[:, :, None]
    wb = smoothstep(0.52, 0.88, b)[:, :, None]
    wc = smoothstep(0.58, 0.90, c)[:, :, None]
    color = purple * wa + blue * wb + magenta * wc * 0.8
    density = np.clip(wa[:, :, 0] * 0.8 + wb[:, :, 0] * 0.9 + wc[:, :, 0] * 0.55, 0, 1)
    density *= 0.65 + 0.7 * detail  # прожилки
    alpha = np.clip(density * 0.55, 0, 0.62)

    total = np.maximum(wa + wb + wc * 0.8, 1e-4)
    rgb = np.clip(color / total, 0, 1)
    out = np.dstack([rgb, alpha])
    Image.fromarray((out * 255).astype(np.uint8), "RGBA").save(OUT / "nebula.png", optimize=True)


def make_near(rng, size=1024):
    """Прозрачный слой с редкими яркими звёздами и свечением."""
    canvas = np.zeros((size, size, 3))
    alpha = np.zeros((size, size, 1))
    for _ in range(95):
        x, y = rng.uniform(0, size, 2)
        tint_c = np.array(STAR_TINTS[rng.integers(len(STAR_TINTS))])
        stamp(canvas, x, y, rng.uniform(0.9, 1.6), tint_c, rng.uniform(0.55, 0.95))
    for _ in range(14):
        x, y = rng.uniform(0, size, 2)
        tint_c = np.array(STAR_TINTS[rng.integers(len(STAR_TINTS))])
        stamp(canvas, x, y, rng.uniform(1.8, 2.6), tint_c, 1.0, hard=0.4)
        spikes(canvas, x, y, int(rng.integers(7, 15)), tint_c, 0.6)

    intensity = np.clip(canvas.max(axis=2), 0, 1)
    alpha[:, :, 0] = intensity
    rgb = np.clip(canvas / np.maximum(intensity[:, :, None], 1e-4), 0, 1)
    out = np.dstack([rgb, alpha])
    Image.fromarray((out * 255).astype(np.uint8), "RGBA").save(OUT / "near-stars.png", optimize=True)


if __name__ == "__main__":
    make_deep(np.random.default_rng(1313))
    make_nebula(np.random.default_rng(2126))
    make_near(np.random.default_rng(42))
    for p in sorted(OUT.glob("*.png")):
        print(p.name, p.stat().st_size // 1024, "KB")
