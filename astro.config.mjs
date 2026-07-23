// @ts-check
import { defineConfig } from 'astro/config';

// Static output. Deploys free on Vercel (auto-detected) with no adapter and no
// serverless functions. Weather is fetched from Open-Meteo at build time; a daily
// rebuild keeps the forecast fresh (driven externally — no host cron required).
export default defineConfig({
  output: 'static',
  site: 'https://example.com',
  trailingSlash: 'ignore',
});
