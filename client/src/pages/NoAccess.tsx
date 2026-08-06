/**
 * Landing for a signed-in account with no crew role.
 *
 * Lives at /admin/no-access so it stays inside the installed crew app's scope —
 * a path outside it would bounce the user out into the browser. Bilingual,
 * because cleaners may be signed in before their access is granted.
 */
import { LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/_core/hooks/useAuth";
import { detectPreferredLocale } from "@/i18n/LocaleContext";
import { ASSETS } from "@/lib/assets";

const COPY = {
  en: {
    title: "No access yet",
    body: "Your account isn't connected to a Grapefruit Cleaning Co. team member yet. Ask your manager to send you a staff invite, then open the link they email you.",
    signedInAs: "Signed in as",
    signOut: "Sign out",
    website: "Go to our website",
  },
  es: {
    title: "Aún sin acceso",
    body: "Su cuenta todavía no está conectada a un miembro del equipo de Grapefruit Cleaning Co. Pídale a su supervisor que le envíe una invitación y abra el enlace que le llegue por correo.",
    signedInAs: "Sesión iniciada como",
    signOut: "Cerrar sesión",
    website: "Ir a nuestro sitio web",
  },
} as const;

export default function NoAccess() {
  const { user, logout } = useAuth();
  const t = COPY[detectPreferredLocale()] ?? COPY.en;

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4 py-12">
      <div className="w-full max-w-md rounded-3xl bg-card p-8 text-center shadow-lg sm:p-10">
        <img src={ASSETS.logo} alt="Grapefruit Cleaning Co." className="mx-auto h-12 w-auto" />
        <h1 className="mt-6 font-display text-2xl font-bold text-foreground">{t.title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{t.body}</p>

        {user?.email && (
          <p className="mt-6 rounded-xl bg-muted/60 px-4 py-3 text-xs text-muted-foreground">
            {t.signedInAs} <span className="font-medium text-foreground">{user.email}</span>
          </p>
        )}

        <div className="mt-6 flex flex-col gap-2">
          <Button variant="outline" className="rounded-full" onClick={() => logout()}>
            <LogOut className="mr-1.5 h-4 w-4" />
            {t.signOut}
          </Button>
          <a
            href={`/${detectPreferredLocale()}`}
            className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
          >
            {t.website}
          </a>
        </div>
      </div>
    </div>
  );
}
