import { useEffect, useState } from "react";
import { CalendarClock, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { todayInBookingZone } from "@shared/leadTime";
import { useLocale } from "@/i18n/LocaleContext";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export default function RescheduleRequest({ token }: { token: string }) {
  const { locale } = useLocale();
  const utils = trpc.useUtils();
  const access = trpc.reschedule.access.useQuery({ token }, { retry: false });
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!access.data || date) return;
    setDate(access.data.request?.proposedDate ?? access.data.booking.scheduledDate ?? "");
    setTime(access.data.request?.proposedTime ?? "");
  }, [access.data, date]);

  const availability = trpc.booking.availability.useQuery(
    {
      date,
      serviceType: (access.data?.booking.serviceType ?? undefined) as never,
      sqft: access.data?.booking.sqft ?? undefined,
    },
    { enabled: Boolean(access.data && /^\d{4}-\d{2}-\d{2}$/.test(date) && !access.data.request) }
  );
  const request = trpc.reschedule.request.useMutation({
    onSuccess: () => {
      utils.reschedule.access.invalidate({ token });
      toast.success(locale === "es" ? "Solicitud enviada" : "Request sent");
    },
    onError: error => toast.error(error.message),
  });
  const accept = trpc.reschedule.acceptCounter.useMutation({
    onSuccess: () => {
      utils.reschedule.access.invalidate({ token });
      toast.success(locale === "es" ? "Nuevo horario confirmado" : "New schedule confirmed");
    },
    onError: error => toast.error(error.message),
  });

  if (access.isLoading) {
    return <div className="flex min-h-[55vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-primary" /></div>;
  }
  if (!access.data) {
    return (
      <div className="mx-auto max-w-xl px-4 py-20">
        <Card><CardContent className="p-8 text-center text-muted-foreground">
          {locale === "es" ? "Este enlace no es válido o ya venció." : "This link is invalid or has expired."}
        </CardContent></Card>
      </div>
    );
  }

  const { booking, request: openRequest } = access.data;
  const current = booking.scheduledDate
    ? `${booking.scheduledDate}${booking.scheduledTime ? ` · ${booking.scheduledTime}` : locale === "es" ? " · hora por definir" : " · time to be decided"}`
    : locale === "es" ? "Sin horario" : "Unscheduled";

  return (
    <div className="mx-auto max-w-2xl px-4 py-12 sm:py-16">
      <Card className="overflow-hidden border-0 shadow-xl ring-1 ring-border">
        <CardHeader className="bg-primary/10 px-6 py-8 sm:px-8">
          <CalendarClock className="mb-3 h-8 w-8 text-primary" />
          <CardTitle className="text-2xl sm:text-3xl">
            {locale === "es" ? "Solicitar cambio de fecha" : "Request a schedule change"}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {booking.reference} · {locale === "es" ? "Horario actual" : "Current schedule"}: {current}
          </p>
        </CardHeader>
        <CardContent className="space-y-5 p-6 sm:p-8">
          {openRequest ? (
            openRequest.status === "countered" && openRequest.counterDate ? (
              <div className="space-y-4">
                <p className="text-sm">
                  {locale === "es"
                    ? "Karyme propuso esta opción. Su cita no cambia hasta que la acepte."
                    : "Karyme proposed this option. Your appointment does not change until you accept it."}
                </p>
                <div className="rounded-xl bg-muted p-4 font-semibold">
                  {openRequest.counterDate}{openRequest.counterTime ? ` · ${openRequest.counterTime}` : locale === "es" ? " · hora por definir" : " · time to be decided"}
                </div>
                {openRequest.adminNote && <p className="text-sm text-muted-foreground">{openRequest.adminNote}</p>}
                <Button className="w-full" disabled={accept.isPending} onClick={() => accept.mutate({ token, requestId: openRequest.id })}>
                  {accept.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  {locale === "es" ? "Aceptar esta opción" : "Accept this option"}
                </Button>
              </div>
            ) : (
              <div className="rounded-xl bg-amber-50 p-5 text-amber-950">
                <CheckCircle2 className="mb-2 h-6 w-6" />
                <p className="font-semibold">{locale === "es" ? "Solicitud recibida" : "Request received"}</p>
                <p className="mt-1 text-sm">
                  {locale === "es"
                    ? "Su cita actual no cambia mientras Karyme revisa la propuesta."
                    : "Your current appointment remains unchanged while Karyme reviews the proposal."}
                </p>
              </div>
            )
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                {locale === "es"
                  ? "Proponga una fecha y hora. Karyme revisará la ruta del día antes de aprobarla; este formulario no cambia su cita por sí solo."
                  : "Propose a date and time. Karyme will review the day's route before approving it; this form does not change your appointment by itself."}
              </p>
              <div>
                <Label>{locale === "es" ? "Fecha propuesta" : "Proposed date"}</Label>
                <Input type="date" min={todayInBookingZone()} value={date} onChange={event => { setDate(event.target.value); setTime(""); }} className="mt-1.5" />
              </div>
              {date && availability.isLoading && <p className="text-xs text-muted-foreground">{locale === "es" ? "Consultando disponibilidad…" : "Checking availability…"}</p>}
              {date && availability.data && (
                <div>
                  <Label>{locale === "es" ? "Hora propuesta" : "Proposed time"}</Label>
                  <div className="mt-1.5 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {availability.data.map(slot => (
                      <button
                        key={slot.time}
                        type="button"
                        disabled={!slot.available}
                        onClick={() => setTime(slot.time)}
                        className={`h-10 rounded-lg border text-sm font-semibold ${time === slot.time ? "border-primary bg-primary text-primary-foreground" : slot.available ? "bg-card" : "cursor-not-allowed border-dashed bg-muted text-muted-foreground"}`}
                      >
                        {slot.time}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <Label>{locale === "es" ? "Nota (opcional)" : "Note (optional)"}</Label>
                <Textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} className="mt-1.5 min-h-24" />
              </div>
              <Button
                className="w-full"
                disabled={!date || !time || request.isPending}
                onClick={() => request.mutate({ token, date, time, note: note || undefined, locale })}
              >
                {request.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {locale === "es" ? "Enviar solicitud" : "Send request"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
