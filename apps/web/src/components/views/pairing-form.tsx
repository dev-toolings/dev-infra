import * as React from "react";
import { KeyRound, LoaderCircle, ServerCog } from "lucide-react";
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
    <main className="flex min-h-[100svh] items-center justify-center px-4 py-8">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-4">
          <span className="flex size-11 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ServerCog aria-hidden="true" className="size-5" />
          </span>
          <div className="space-y-1.5">
            <CardTitle className="text-lg">Connect to DevHub</CardTitle>
            <CardDescription>Enter the one-time pairing code shown by the local DevHub command.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <Label htmlFor="pairing-code">Pairing code</Label>
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
              {busy ? "Connecting" : "Pair this browser"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
