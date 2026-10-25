import { createApp } from './app.mjs';

const port = Number(process.env.PORT) || 3000;
createApp().server.listen(port, '0.0.0.0', () => console.log(`street-quest map proxy listening on :${port}`));
