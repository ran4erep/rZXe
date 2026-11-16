import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

async function startServer(): Promise<void> {
  const app = express();
  app.disable('x-powered-by');

  const isProd =
    process.env.NODE_ENV === 'production' || process.env.npm_lifecycle_event === 'start';

  if (isProd) {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { maxAge: '1h' }));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  // Ensure dist directory check doesn't fail silently in misconfigured start
  if (isProd && !fs.existsSync(path.resolve(process.cwd(), 'dist', 'index.html'))) {
    console.warn('Warning: dist/index.html not found; run npm run build first.');
  }

  app.listen(PORT, HOST, () => {
    console.log(`ZX Spectrum server listening on http://${HOST}:${PORT}`);
  });
}

void startServer();
