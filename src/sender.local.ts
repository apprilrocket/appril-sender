// Permite correr el sender localmente sin Lambda — útil para testing y dev.
// Uso: `npm run run:sender:local`
// OJO: ejerce la cola real (message_queue) y ENVÍA emails/WhatsApp de verdad.

import 'dotenv/config';
import { handler } from './sender';

(async () => {
  try {
    const result = await handler({} as any);
    console.log('Resultado:', result);
    process.exit(0);
  } catch (err) {
    console.error('Error fatal:', err);
    process.exit(1);
  }
})();
