const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');

async function main() {
  const pngToIcoModule = await import('png-to-ico');
  const pngToIco = pngToIcoModule.default || pngToIcoModule;

  const source = 'C:/Users/ginma/Desktop/openclaw-color.svg';
  const outDir = path.resolve('build');
  fs.mkdirSync(outDir, { recursive: true });

  const svg = fs.readFileSync(source, 'utf8')
    .replace(/width="1em"/i, 'width="1024"')
    .replace(/height="1em"/i, 'height="1024"');
  fs.writeFileSync(path.join(outDir, 'icon.svg'), svg, 'utf8');

  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const pngs = [];
  for (const size of sizes) {
    const file = path.join(outDir, `icon-${size}.png`);
    await sharp(Buffer.from(svg))
      .resize(size, size, { fit: 'contain' })
      .png()
      .toFile(file);
    pngs.push(file);
  }

  const ico = await pngToIco(pngs);
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
  console.log(path.join(outDir, 'icon.ico'));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
