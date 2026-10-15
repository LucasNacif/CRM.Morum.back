# Morum · API

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

- **Dos emprendimientos, datos separados.** Morum y Clarus comparten usuarios pero nada más:
  productos, categorías, ventas y ajustes llevan `businessId`. El front indica el negocio activo en el
  encabezado `X-Business` y todo acceso por id verifica que pertenezca a ese negocio. Los códigos de
  barras son únicos entre los dos, así una etiqueta nunca se confunde.
- **Stock por libro de movimientos.** `Variant.stock` nunca se edita directo: todo cambio pasa por
  `StockService.applyMovement`, que actualiza el saldo y registra un `StockMovement` en la misma
  transacción. El stock no puede quedar negativo, ni siquiera con dos ventas simultáneas.
- **Ventas con seña.** Una venta puede cobrarse en partes: guarda lo pagado, la fecha acordada para el
  saldo y si la prenda se entregó o quedó reservada. Cada pago queda en `Payment`, y una venta puede
  cobrarse con varios medios a la vez o sumar prendas después de hecha.
- **Compras.** Reponen prendas o dan de alta productos nuevos; el envío y el packaging se reparten en
  partes iguales entre las unidades y el costo de cada prenda pasa a ser el de la última compra con esos
  gastos incluidos. Los gastos sin stock (bolsas, percheros) suman al total de la compra.
- **Producto → variantes.** Cada variante (talle + color) se identifica por su código de barras
  numérico (Code 128, secuencia `barcode_seq`); también se puede cargar el código de fábrica.
- **Nada con historial se borra.** Productos y variantes usados se desactivan; las
  ventas se anulan (y devuelven stock) en lugar de eliminarse.
- **Auth.** JWT con guard global; solo `/api/auth/login` y `/api/health` son públicas.

| Módulo | Rutas |
| --- | --- |
| Auth y usuarios | `POST /auth/login`, `GET /auth/me`, `POST /auth/change-password`, `/users` |
| Productos | `/products`, `/products/:id/variants`, `POST /products/:id/price`, `POST /products/prices/bulk`, `/variants`, `GET /variants/lookup?code=` |
| Categorías y ajustes | `/categories`, `/settings` |
| Stock | `POST /stock/adjustments` (reposición con costo y precio, salida o conteo) |
| Ventas | `/sales`, `GET /sales/pending`, `POST /sales/:id/items`, `POST /sales/:id/payments`, `POST /sales/:id/deliver`, `POST /sales/:id/cancel` |
| Compras | `/purchases` |
| Etiquetas | `GET /labels/layouts`, `POST /labels/pdf` |
| Reportes | `GET /reports/dashboard` |

Todas las rutas llevan el prefijo `/api`.

## Despliegue gratis (Neon + Render)

1. **Neon** (neon.tech): crear un proyecto y copiar la connection string (`postgresql://...?sslmode=require`).
2. **Render** (render.com): *New > Blueprint* y elegir este repo. `render.yaml` ya define build,
   migraciones, seed y health check. Completar las variables que pide:
   - `DATABASE_URL`: la de Neon.
   - `CORS_ORIGIN`: la URL del frontend (ej. `https://morum-stock.pages.dev`).
   - `ADMIN_EMAIL` y `ADMIN_PASSWORD`: el usuario con el que vas a entrar.
3. La API queda en `https://<nombre>.onrender.com/api`.

El plan gratuito de Render duerme el servicio tras 15 minutos sin uso; el primer pedido tarda
unos 40 segundos en despertarlo. Los datos no se pierden: viven en Neon.
