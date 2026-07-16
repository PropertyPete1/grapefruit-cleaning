import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { CheckCircle2, Loader2, Sparkles, XCircle } from "lucide-react";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { trpc } from "@/lib/trpc";
import { ASSETS } from "@/lib/assets";

/**
 * Staff invite landing page at /staff/join/:token.
 * Flow: employee opens their personal invite link → signs in if needed
 * (post-login redirect restores this exact URL) → the invite token is
 * exchanged server-side, linking their account to the employee record and
 * granting the staff role → they're taken to the staff dashboard.
 */
export default function StaffJoin({ token }: { token: string }) {
  const [, navigate] = useLocation();
  const { loading, isAuthenticated } = useAuth({ redirectOnUnauthenticated: true });
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const attempted = useRef(false);
  const utils = trpc.useUtils();
  const accept = trpc.staff.acceptInvite.useMutation({
    onSuccess: (data) => {
      setResult({ ok: true, message: `Welcome aboard, ${data.employeeName}! Your staff access is connected.` });
      utils.auth.me.invalidate();
      utils.staff.invalidate();
      setTimeout(() => navigate("/staff", { replace: true }), 1800);
    },
    onError: (e) => setResult({ ok: false, message: e.message }),
  });

  useEffect(() => {
    if (loading || !isAuthenticated || attempted.current) return;
    attempted.current = true;
    accept.mutate({ token });
  }, [loading, isAuthenticated, token, accept]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <div className="w-full max-w-md rounded-3xl bg-card p-10 text-center shadow-lg">
        <img src={ASSETS.logo} alt="Grapefruit Cleaning Co." className="mx-auto h-14 w-auto" />
        {result === null ? (
          <>
            <Loader2 className="mx-auto mt-6 h-9 w-9 animate-spin text-primary" />
            <h1 className="mt-4 font-display text-2xl font-bold text-foreground">Connecting your access…</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              One moment — we're linking your account to the team dashboard.
            </p>
          </>
        ) : result.ok ? (
          <>
            <CheckCircle2 className="mx-auto mt-6 h-10 w-10 text-secondary" />
            <h1 className="mt-4 font-display text-2xl font-bold text-foreground">You're in!</h1>
            <p className="mt-2 text-sm text-muted-foreground">{result.message}</p>
            <p className="mt-1 text-xs text-muted-foreground">Taking you to your dashboard…</p>
          </>
        ) : (
          <>
            <XCircle className="mx-auto mt-6 h-10 w-10 text-destructive" />
            <h1 className="mt-4 font-display text-2xl font-bold text-foreground">Invite not valid</h1>
            <p className="mt-2 text-sm text-muted-foreground">{result.message}</p>
            <p className="mt-3 text-xs text-muted-foreground">
              <Sparkles className="mr-1 inline h-3.5 w-3.5 text-primary" />
              Ask your administrator to send you a fresh invite from the Employees page.
            </p>
            <Button asChild className="mt-6 rounded-full px-6">
              <Link href="/en">Back to website</Link>
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
