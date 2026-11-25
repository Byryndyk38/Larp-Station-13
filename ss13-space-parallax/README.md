# SS13 Space Parallax for Owlbear Rodeo

A multi-layer space background extension for Owlbear Rodeo. The visual layers respond to camera panning and a selected character token.

## Free hosting with GitHub Pages

This repository publishes the extension with GitHub Actions. The workflow builds the Vite project from this directory and deploys only `dist/`.

Once GitHub Pages has been enabled with **Settings → Pages → Build and deployment → Source: GitHub Actions**, the Owlbear install URL is:

`https://byryndyk38.github.io/Larp-Station-13/manifest.json`

## Local development

```bash
npm install
npm run dev
```

## Notes

- Each player enables the extension locally and selects a token on the CHARACTER layer.
- The background is rendered with local Owlbear scene items and does not modify the shared map.
- Test on a duplicate scene first: layer ordering depends on the stacking order of the map artwork in the room.
