import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createStudio } from './studio.js';
import { createApp } from './app.js';

await mkdir('data', { recursive: true });
const studio = createStudio(process.env.WORKEDA_DB || 'data/workeda.db');
const port = Number(process.env.PORT || 4318);
createApp({ studio, publicDir: fileURLToPath(new URL('../public', import.meta.url)) })
  .listen(port, () => console.log(`Workeda AI Commerce Studio : http://localhost:${port}`));
