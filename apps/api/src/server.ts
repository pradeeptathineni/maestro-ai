import { buildApp } from './app.js';
import { apiConfig } from './config.js';

const config = apiConfig();
const app = await buildApp({ config });
await app.listen({ host: config.host, port: config.port });
