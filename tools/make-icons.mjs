// Génère les icônes Pixel Art de l'application (sans dépendance) : node tools/make-icons.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const SIZE = 32;
const COLORS = { '.': '#14242c', w: '#2c6e8f', g: '#6bbf73', G: '#3f8f55', s: '#e3c381', S: '#bc9461', c: '#c9a6ff', C: '#8a5af0', h: '#fff3d9' };

// Une île, sa terre en dessous et le cristal de la place centrale.
function art() {
  const px = Array.from({ length: SIZE }, () => Array(SIZE).fill('.'));
  const diamond = (cx, cy, rx, ry, color) => { for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (Math.abs(x + 0.5 - cx) / rx + Math.abs(y + 0.5 - cy) / ry <= 1) px[y][x] = color; };
  diamond(16, 23, 14, 7, 'w');
  diamond(16, 23, 12, 6, 'S');
  diamond(16, 21, 12, 6, 'G');
  diamond(16, 20, 12, 6, 'g');
  diamond(16, 20, 6, 3, 's');
  diamond(16, 11, 5, 9, 'C');
  diamond(14.5, 9.5, 2.5, 6, 'c');
  px[6][14] = px[7][14] = 'h';
  return px;
}

const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]), out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};

// margin : bord ajouté autour du dessin (les icônes « maskable » sont rognées par le système).
function png(size, margin = 0) {
  const grid = art(), total = SIZE + margin * 2, rows = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const gx = Math.floor((x * total) / size) - margin, gy = Math.floor((y * total) / size) - margin;
    const color = COLORS[grid[gy]?.[gx] ?? '.'];
    rows.writeUIntBE(parseInt(color.slice(1), 16), y * (size * 3 + 1) + 1 + x * 3, 3);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const folder = new URL('../public/icons/', import.meta.url);
mkdirSync(folder, { recursive: true });
for (const [name, size, margin] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512, 6], ['apple-touch-icon.png', 180, 2]]) writeFileSync(new URL(name, folder), png(size, margin));
console.log('Icônes écrites dans public/icons.');
