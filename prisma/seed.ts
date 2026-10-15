import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

async function main() {
  const email = process.env.ADMIN_EMAIL?.toLowerCase().trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('Faltan ADMIN_EMAIL y ADMIN_PASSWORD en el entorno');
  }

  // Si el usuario ya existe no se toca: el seed corre en cada deploy y no debe pisar
  // una contraseña cambiada desde la app.
  await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash: await bcrypt.hash(password, 12), name: process.env.ADMIN_NAME ?? 'Admin' },
  });
  console.log(`Usuario listo: ${email}`);

  // Morum es ropa; Clarus, maquillaje y skincare.
  for (const business of [
    { id: 'morum', name: 'Morum', categories: ['Remeras', 'Pantalones', 'Buzos', 'Camperas', 'Vestidos', 'Accesorios'] },
    { id: 'clarus', name: 'Clarus', categories: ['Labios', 'Ojos', 'Rostro', 'Skincare', 'Cuidado corporal', 'Accesorios'] },
  ]) {
    await prisma.business.upsert({ where: { id: business.id }, update: {}, create: { id: business.id, name: business.name } });
    await prisma.settings.upsert({ where: { businessId: business.id }, update: {}, create: { businessId: business.id } });
    // Solo en un negocio sin categorías: las que se borren desde la app no tienen que volver en cada deploy.
    if ((await prisma.category.count({ where: { businessId: business.id } })) === 0) {
      await prisma.category.createMany({
        data: business.categories.map((name) => ({
          name,
          businessId: business.id,
        })),
      });
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
