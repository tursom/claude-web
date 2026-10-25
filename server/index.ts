import { loadConfig, listenAddress } from './config.js';
import { buildApp } from './app.js';
try {
  const config = await loadConfig();
  const app = await buildApp(config, { logger: true });
  const close = async () => {
    await app.close();
    process.exitCode = 0;
  };
  process.once('SIGTERM', close);
  process.once('SIGINT', close);
  await app.listen(listenAddress(config.listen));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
