import { t } from "../../lib/i18n";
import * as React from "react";
import { KeyRound, LoaderCircle } from "lucide-react";
import { LogoMark } from "../brand/logo";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

export interface PairingFormProps {
  busy: boolean;
  error?: string;
  onPair: (code: string) => void | Promise<void>;
}

export function PairingForm({ busy, error, onPair }: PairingFormProps) {
  const [code, setCode] = React.useState("");
  const errorId = React.useId();
  const canSubmit = code.trim().length > 0 && !busy;

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = code.trim();
    if (!value || busy) return;
    onPair(value);
  }

  return (
    <main className="flex min-h-[100svh] items-center justify-center bg-muted px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-4">
          <LogoMark className="size-10 [&_svg]:size-6" />
          <div className="space-y-1.5">
            <CardTitle className="text-base">{t("Connect to DevHub")}</CardTitle>
            <CardDescription>{t("Enter the one-time pairing code shown by the local DevHub command.")}</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="pairing-code">{t("Pairing code")}</Label>
              <Input
                id="pairing-code"
                type="password"
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                value={code}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? errorId : undefined}
                onChange={(event) => setCode(event.currentTarget.value)}
                disabled={busy}
              />
              {error ? <p id={errorId} role="alert" className="text-sm leading-5 text-destructive">{error}</p> : null}
            </div>
            <Button type="submit" className="w-full" disabled={!canSubmit}>
              {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : <KeyRound aria-hidden="true" />}
              {busy ? t("Connecting") : t("Pair this browser")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
