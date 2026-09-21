import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./sentry.server.config');

    /**
     * E12 · ronda 1 (DEBE #8) — `/admin` está CERRADO cuando nadie está
     * declarado operador de plataforma. Con más de una organización en la
     * instalación eso casi siempre es un olvido de configuración, y es mejor
     * leerlo en el arranque que descubrirlo con un 404 sin explicación. Avisa;
     * no falla.
     */
    const { warnIfNoPlatformAdmins } = await import('./app/(app)/admin/admin');
    const { prisma } = await import('./lib/db');
    await warnIfNoPlatformAdmins(async () =>
      prisma.organization.count({ where: { isPersonal: false } })
    ).catch(() => null);
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('./sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
