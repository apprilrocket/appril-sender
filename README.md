# appril-sender

Las dos **Lambdas** del CRM de Appril (`appril-crm`). Procesan la cola de mensajes
y reciben los webhooks de proveedores. El dashboard (`../appril-crm`) solo escribe
en `message_queue`; estas funciones hacen el envío real y registran los eventos.

| Lambda (AWS) | Handler | Qué hace | Trigger | Timeout / Mem |
|---|---|---|---|---|
| `appril-crm-sender` | `sender.handler` | Lee `message_queue` (status `pending`), envía por **SES** (email) o **WhatsApp Cloud API**, registra `message_attempts`, actualiza `message_queue`, inserta `lead_events` y toca `leads_master`. Reintenta hasta `MAX_ATTEMPTS`. | EventBridge `appril-crm-sender-cron` → **`rate(2 minutes)`** | 60 s / 512 MB |
| `appril-crm-webhook` | `webhook.handler` | API Gateway HTTP API. Rutas: `/webhook/ses` (SNS de SES: delivery/open/click/bounce/complaint), `/webhook/whatsapp` (verificación + statuses + replies, valida firma `x-hub-signature-256`), `/webhook/external` (endpoints firmados). Escribe `lead_events`, `webhook_events` y flags en `leads_master`. | API Gateway | 30 s / 256 MB |

- **Región:** `us-east-1` · **Runtime:** `nodejs22.x` · **Arch:** `x86_64`
- **Rol IAM:** `arn:aws:iam::516426598004:role/appril-crm-lambda-role`
- Ambas funciones se despliegan con el **mismo zip** (contiene `sender.js` + `webhook.js`); cada función usa su propio handler.

## ⚠️ Nota de recuperación (importante)

Este proyecto se **reconstruyó desde los paquetes de despliegue de las Lambdas en AWS**
(13-jun-2026), porque la carpeta local se borró y no estaba en Git ni en Vercel
(se desplegaba por CLI a AWS).

- `src/*.ts` se **reconstruyó a partir del bundle** de esbuild. La lógica es fiel y
  legible, pero las **anotaciones de tipos TypeScript originales se perdieron** (esbuild
  las elimina al compilar). Por eso `tsconfig` va en modo laxo (`strict: false`).
- `dist/sender.js` y `dist/webhook.js` son los **bundles exactos que están desplegados**
  hoy (artefactos verbatim). Sirven como referencia y como respaldo deployable.
- El último deploy de las Lambdas fue del **23-may-2026**; esto refleja ese estado.

## Estructura

```
src/
  sender.ts      handler del cron + reintentos
  webhook.ts     handler HTTP (ses / whatsapp / external)
  supabase.ts    cliente Supabase (service role)
  ses.ts         envío por Amazon SES
  whatsapp.ts    envío por WhatsApp Cloud API (Meta)
  templates.ts   render de {{ variables }}
dist/            bundles (build output / artefactos desplegados)
build.mjs        bundling con esbuild
```

## Variables de entorno

Ver `.env.example`. Las mismas 13 variables están en **ambas** Lambdas (Supabase,
SES, WhatsApp, tuning). Para volcar los valores reales desde AWS:

```bash
aws lambda get-function-configuration --function-name appril-crm-sender \
  --region us-east-1 --query 'Environment.Variables'
```

## Desarrollo y deploy

```bash
npm install        # dependencias
npm run build      # esbuild → dist/sender.js + dist/webhook.js

# Deploy (sube el mismo zip a las dos funciones):
npm run deploy
# o por separado:
npm run package && npm run deploy:sender
npm run package && npm run deploy:webhook
```

El `deploy` solo actualiza el **código**. Si cambian variables de entorno, hazlo con
`aws lambda update-function-configuration` o en la consola. El cron y el API Gateway
ya están configurados en AWS (no se tocan al deployar código).

## Deploy automático (GitHub Actions)

`.github/workflows/deploy.yml` compila y despliega ambas Lambdas en cada push a `main`
(o manualmente desde la pestaña *Actions*). Requiere **2 secrets** en el repo
(*Settings → Secrets and variables → Actions*):

| Secret | Valor |
|---|---|
| `AWS_ACCESS_KEY_ID` | Access key de un IAM user con `lambda:UpdateFunctionCode` (p.ej. `appril-crm-deploy`) |
| `AWS_SECRET_ACCESS_KEY` | El secret de esa access key |

Mientras no estén los secrets, el workflow fallará en el paso de credenciales (no rompe nada).
