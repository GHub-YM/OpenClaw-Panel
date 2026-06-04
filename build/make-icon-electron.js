const fs = require('node:fs');
const path = require('node:path');
const { app, nativeImage } = require('electron');

async function main() {
  const pngToIcoModule = await import('png-to-ico');
  const pngToIco = pngToIcoModule.default || pngToIcoModule;

  await app.whenReady();
  const source = 'C:/Users/ginma/Desktop/openclaw-color.svg';
  const outDir = path.resolve('build');
  fs.mkdirSync(outDir, { recursive: true });

  const svg = fs.readFileSync(source, 'utf8')
    .replace(/width="1em"/i, 'width="1024"')
    .replace(/height="1em"/i, 'height="1024"');
  fs.writeFileSync(path.join(outDir, 'icon.svg'), svg, 'utf8');

  const image = nativeImage.createFromBuffer(Buffer.from(svg));
  if (image.isEmpty()) throw new Error('Electron nativeImage could not load SVG');

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = sizes.map((size) => {
    const resized = image.resize({ width: size, height: size, quality: 'best' });
    const file = path.join(outDir, `icon-${size}.png`);
    fs.writeFileSync(file, resized.toPNG());
    return file;
  });

  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  console.log(path.join(outDir, 'icon.ico'));
  app.quit();
}

main().catch((error) => {
  console.error(error);
  app.exit(1);
});
