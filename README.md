# Guada Stock · API

Backend del sistema de control de stock: NestJS 12 + PostgreSQL + Prisma 7.

## Desarrollo local

Requiere Node 22, pnpm y Docker.

```bash
cp .env.example .env      # completar JWT_SECRET y ADMIN_PASSWORD
pnpm install
pnpm db:up                # Postgres en Docker, puerto 5433
pnpm db:migrate           # crea las tablas
pnpm db:seed              # crea el usuario admin y categorías base
pnpm start:dev            # http://localhost:3000/api
```

`pnpm test` corre los tests unitarios y `pnpm db:studio` abre un visor de la base.

## Cómo está armado

- **Stock por libro de movimientos.** `Variant.stock` nunca se edita directo: todo cambio pasa por
  `StockService.applyMovement`, que actualiza el saldo y registra un `StockMovement` en la misma
  transacción. El stock no puede quedar negativo, ni siquiera con dos ventas simultáneas.
- **Producto → variantes.** Cada variante (talle + color) tiene su SKU legible y su código de barras.
  Los códigos internos son Code 128 numéricos de 8 dígitos (secuencia `barcode_seq`); también se
  puede cargar el código de fábrica de la prenda.
- **Nada con historial se borra.** Productos, variantes y proveedores usados se desactivan; las
  ventas se anulan (y devuelven stock) en lugar de eliminarse.
- **Auth.** JWT con guard global; solo `/api/auth/login` y `/api/health` son públicas.

| Módulo | Rutas |
| --- | --- |
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password` |
| Productos | `/products`, `/products/:id/variants`, `/variants`, `GET /variants/lookup?code=` |
| Categorías y proveedores | `/categories`, `/suppliers` |
| Stock | `GET /stock/movements`, `POST /stock/adjustments` |
| Compras y ventas | `/purchases`, `/sales`, `POST /sales/:id/cancel` |
| Etiquetas | `GET /labels/layouts`, `POST /labels/pdf` |
| Reportes | `GET /reports/dashboard`, `/reports/stock.csv`, `/reports/sales.csv` |

Todas las rutas llevan el prefijo `/api`.

## Despliegue gratis (Neon + Render)

1. **Neon** (neon.tech): crear un proyecto y copiar la connection string (`postgresql://...?sslmode=require`).
2. **Render** (render.com): *New > Blueprint* y elegir este repo. `render.yaml` ya define build,
   migraciones, seed y health check. Completar las variables que pide:
   - `DATABASE_URL`: la de Neon.
   - `CORS_ORIGIN`: la URL del frontend (ej. `https://guada-stock.pages.dev`).
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD`: el usuario con el que vas a entrar.
3. La API queda en `https://<nombre>.onrender.com/api`.

El plan gratuito de Render duerme el servicio tras 15 minutos sin uso; el primer pedido tarda
unos 40 segundos en despertarlo. Los datos no se pierden: viven en Neon.
