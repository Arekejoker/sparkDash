import { Resvg } from '@resvg/resvg-js';

process.once('message', ({ svg }) => {
  try {
    const options = { font: { loadSystemFonts: false }, logLevel: 'off' };
    const source = new Resvg(svg, options);
    const w = source.width, h = source.height;
    if (!(w > 0 && h > 0) || !Number.isFinite(w + h) || w / h > 100 || h / w > 100) {
      throw new Error('SVG dimensions are invalid or excessively narrow');
    }
    const image = new Resvg(svg, {
      ...options, fitTo: { mode: 'zoom', value: Math.min(1024 / w, 1024 / h) },
    }).render();
    const pixels = image.pixels;
    let visible = 0;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 0) visible++;
    if (!visible) throw new Error('SVG rendered blank');
    // Large PNG messages must flush before the IPC channel is disconnected.
    process.send({ png: image.asPng().toString('base64'), width: image.width, height: image.height }, () => process.disconnect());
  } catch (err) {
    process.send({ error: err.message }, () => process.disconnect());
  }
});
