import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import updateRoutes from './routes/updates.js';
import requestRoutes from './routes/requests.js';
import laborerRoutes from './routes/laborers.js';
import { portfolioRouter, engineersRouter } from './routes/portfolio.js';
import { metaRouter, dashboardRouter, notificationsRouter } from './routes/misc.js';
import { errorHandler, notFoundHandler } from './middleware/error.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',') }));
  app.use(express.json({ limit: '1mb' }));
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  app.use('/uploads', express.static(fileURLToPath(config.uploadDir), { maxAge: '7d', immutable: true }));

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api/meta', metaRouter);
  app.use('/api/auth', authRoutes);
  app.use('/api/projects', projectRoutes);
  app.use('/api', updateRoutes); // /api/updates and /api/projects/:id/updates
  app.use('/api/requests', requestRoutes);
  app.use('/api/laborers', laborerRoutes);
  app.use('/api/portfolio', portfolioRouter);
  app.use('/api/engineers', engineersRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/notifications', notificationsRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
